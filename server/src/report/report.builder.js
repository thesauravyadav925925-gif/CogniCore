/**
 * MANAGEMENT REPORT BUILDER (Feature 14)
 * Executive Summary · Key Metrics · Major Trends · Problems Identified ·
 * Category Analysis · Recommendations / Areas for Investigation · Supporting Data.
 * Every figure is computed by executed queries + deterministic statistics
 * (nothing is written by the LLM), and each section keeps the SQL that produced it.
 * Works on any dataset with a semantic model; sections that don't apply
 * (e.g. no date column => no trend) are simply omitted.
 */
const { runSafeSql, policyRestrictsAggregates, isColumnDenied } = require('../agent/safe.query');
const { generateKpis } = require('../analytics/kpi');
const { createAdapter } = require('../ingestion/adapters');
const { bucketSeries, analyzeTrend, describeTrend } = require('../analytics/trend');
const { compareGroups } = require('../analytics/compare');
const { detectAnomalies } = require('../analytics/anomaly');
const { selectChart } = require('../analytics/viz');
const S = require('../analytics/stats');
const { qi } = require('../agent/column.resolver');

const pretty = (c) => String(c).replace(/_/g, ' ');
const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : +Number(n).toFixed(2)) : 'n/a');

function pickPrimary(table, policy) {
  const ok = (c) => !isColumnDenied(policy, table.name, c.name);
  const measure = table.columns.find((c) => c.role === 'monetary' && ok(c)) || table.columns.find((c) => ['measure', 'count'].includes(c.role) && ok(c));
  const date = table.columns.find((c) => c.role === 'temporal' && ok(c));
  const cats = table.columns.filter((c) => c.role === 'categorical' && c.stats.distinct >= 2 && c.stats.distinct <= 25 && ok(c));
  const category = cats.sort((a, b) => Math.abs(a.stats.distinct - 6) - Math.abs(b.stats.distinct - 6))[0] || null;
  return { measure, date, category };
}

async function buildManagementReport({ dataset, policy = null, maxTables = 3 }) {
  const semantic = dataset.profile?.semantic;
  if (!semantic) throw new Error('This dataset has no semantic model (is it a document dataset?).');
  if (policyRestrictsAggregates(policy)) {
    const e = new Error('Management reports summarise entire datasets, which is not available for roles with row-level restrictions.');
    e.status = 403; throw e;
  }
  const report = {
    title: `Management Report — ${dataset.name}`, datasetId: dataset.dataset_id, generatedAt: new Date().toISOString(),
    executiveSummary: '', keyMetrics: [], trends: [], problems: [], anomalies: [], categoryAnalysis: [], recommendations: [], supportingData: [], appendix: { queries: [], methodology: [] }, notes: [],
  };
  const findings = { highConcentration: [], decliningTrends: [], risingTrends: [], anomalyCounts: [], totalRecords: 0 };

  // ---- Key metrics ----
  const adapter = createAdapter(dataset.type, { datasetId: dataset.dataset_id, location: dataset.location });
  await adapter.connect();
  let kpiGroups = [];
  try { kpiGroups = await generateKpis({ adapter, semantic, datasetType: dataset.type }); } finally { await adapter.disconnect(); }
  for (const g of kpiGroups.slice(0, maxTables)) {
    for (const k of g.kpis) {
      if (k.value === null || isColumnDenied(policy, g.table, k.column)) continue;
      report.keyMetrics.push({ table: g.table, label: k.label, value: k.value, format: k.format, sql: k.sql });
    }
  }
  findings.totalRecords = semantic.tables.slice(0, maxTables).reduce((s, t) => s + t.rowCount, 0);

  for (const table of semantic.tables.slice(0, maxTables)) {
    const { measure, date, category } = pickPrimary(table, policy);
    const tq = qi(table.name);

    // ---- Trend ----
    if (date && (measure || table.rowCount > 0)) {
      try {
        const agg = measure ? `SUM(${qi(measure.name)})` : 'COUNT(*)';
        const sql = `SELECT ${qi(date.name)} AS date, ${agg} AS value FROM ${tq} WHERE ${qi(date.name)} IS NOT NULL GROUP BY ${qi(date.name)} ORDER BY ${qi(date.name)}`;
        const res = await runSafeSql({ dataset, sql, policy });
        const { grain, series } = bucketSeries(res.rows, { minBuckets: 6 });
        if (series.length >= 3) {
          const t = analyzeTrend(series);
          const label = measure ? pretty(measure.name) : `${pretty(table.name)} records`;
          const sentence = describeTrend(t, { measure: label });
          const rows = series.map((s) => ({ period: s.label, value: S.round(s.value, 2) }));
          report.trends.push({ table: table.name, measure: label, grain, direction: t.direction, sentence, sql, chart: selectChart({ question: 'trend over time', columns: ['period', 'value'], rows }), data: rows });
          if (t.direction === 'decreasing') findings.decliningTrends.push({ label, t });
          if (t.direction === 'increasing') findings.risingTrends.push({ label, t });
        }
      } catch (_) { report.notes.push(`Trend for ${table.name} could not be computed.`); }
    }

    // ---- Category analysis ----
    if (category) {
      try {
        const agg = measure ? `SUM(${qi(measure.name)})` : 'COUNT(*)';
        const sql = `SELECT ${qi(category.name)} AS label, ${agg} AS value FROM ${tq} WHERE ${qi(category.name)} IS NOT NULL GROUP BY ${qi(category.name)} ORDER BY value DESC`;
        const res = await runSafeSql({ dataset, sql, policy });
        const items = res.rows.map((r) => ({ label: String(r.label), value: Number(r.value) })).filter((i) => Number.isFinite(i.value));
        if (items.length >= 2) {
          const cmp = compareGroups(items, { measure: measure ? pretty(measure.name) : 'record count' });
          const rows = cmp.items.map((i) => ({ [category.name]: i.label, value: S.round(i.value, 2), share_pct: i.shareOfTotalPct }));
          report.categoryAnalysis.push({ table: table.name, dimension: category.name, measure: measure ? measure.name : 'record count', sentence: cmp.sentence, sql, chart: selectChart({ question: `${measure?.name || 'count'} by ${category.name}`, columns: [category.name, 'value'], rows }), data: rows });
          const top = cmp.items[0];
          if (items.length >= 3 && top.shareOfTotalPct >= 40) findings.highConcentration.push({ dimension: category.name, label: top.label, share: top.shareOfTotalPct });
        }
      } catch (_) { report.notes.push(`Category analysis for ${table.name} could not be computed.`); }
    }

    // ---- Anomalies (problems) ----
    if (measure) {
      try {
        const sql = `SELECT ${qi(measure.name)} AS value FROM ${tq} WHERE ${qi(measure.name)} IS NOT NULL`;
        const res = await runSafeSql({ dataset, sql, policy });
        const vals = res.rows.map((r) => Number(r.value));
        const an = vals.length >= 8 ? detectAnomalies(vals) : [];
        if (an.length) {
          findings.anomalyCounts.push({ table: table.name, measure: measure.name, n: an.length });
          report.anomalies.push({ table: table.name, measure: measure.name, count: an.length, median: S.round(S.median(vals), 2), top: an.slice(0, 5).map((a) => ({ value: a.value, methods: a.methods, confidence: a.confidence })), sql });
          report.problems.push({ type: 'anomaly', severity: 'medium', text: `${an.length} unusual ${pretty(measure.name)} value${an.length === 1 ? '' : 's'} in ${table.name} (most extreme: ${fmt(an[0].value)}; median ${fmt(S.median(vals))}).` });
        }
      } catch (_) { /* skip */ }
    }
  }

  // ---- Data quality problems ----
  const q = dataset.profile?.quality;
  if (q) {
    report.dataQualityScore = q.overallScore;
    for (const t of q.tables.slice(0, maxTables)) for (const i of t.issues) {
      if (i.column && isColumnDenied(policy, t.name, i.column)) continue;
      report.problems.push({ type: i.type, severity: i.severity, text: `${t.name}: ${i.message}` });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  report.problems.sort((a, b) => order[a.severity] - order[b.severity]);

  // ---- Recommendations / areas to investigate (rule-based, each tied to a finding) ----
  for (const d of findings.decliningTrends) report.recommendations.push(`Investigate the decline in ${d.label}: it fell ${Math.abs(d.t.totalChangePct ?? 0)}% from ${d.t.first.label} to ${d.t.last.label}; check what changed around the peak (${d.t.peak.label}).`);
  for (const c of findings.highConcentration) report.recommendations.push(`Assess dependence on ${c.label}: it accounts for ${c.share}% of the total by ${pretty(c.dimension)}.`);
  for (const a of findings.anomalyCounts) report.recommendations.push(`Review the ${a.n} unusual ${pretty(a.measure)} record${a.n === 1 ? '' : 's'} in ${a.table} to confirm they are genuine and not data-entry errors.`);
  const highIssues = report.problems.filter((p) => p.severity === 'high' && p.type !== 'anomaly');
  if (highIssues.length) report.recommendations.push(`Fix ${highIssues.length} high-severity data-quality issue${highIssues.length === 1 ? '' : 's'} before relying on these figures (e.g. ${highIssues[0].text}).`);
  for (const r of findings.risingTrends.slice(0, 2)) report.recommendations.push(`Identify what is driving the growth in ${r.label} (+${r.t.totalChangePct ?? '?'}% overall) so it can be sustained.`);
  if (!report.recommendations.length) report.recommendations.push('No material risks were detected by the automated checks; continue routine monitoring.');

  // ---- Executive summary ----
  const parts = [`This report covers ${semantic.tables.length} table${semantic.tables.length === 1 ? '' : 's'} and ${fmt(findings.totalRecords)} records from "${dataset.name}".`];
  const headline = report.keyMetrics.filter((k) => k.label && !/completeness|unique/i.test(k.label)).slice(0, 3);
  if (headline.length) parts.push(`Headline figures: ${headline.map((k) => `${k.label} ${fmt(k.value)}${/percent/.test(k.format || '') ? '%' : ''}`).join('; ')}.`);
  if (report.trends[0]) parts.push(report.trends[0].sentence);
  if (report.categoryAnalysis[0]) parts.push(report.categoryAnalysis[0].sentence);
  parts.push(report.problems.length ? `${report.problems.length} issue${report.problems.length === 1 ? '' : 's'} need attention${report.dataQualityScore !== undefined ? ` (data quality score ${report.dataQualityScore}/100)` : ''}.` : 'No data problems were detected.');
  report.executiveSummary = parts.join(' ');

  // ---- Appendix: every query behind every number, plus methodology (blueprint #23 'Evidence / Appendix') ----
  for (const k of report.keyMetrics) if (k.sql) report.appendix.queries.push({ section: 'Key metrics', label: k.label, sql: k.sql });
  for (const t of report.trends) report.appendix.queries.push({ section: 'Trends', label: t.measure, sql: t.sql });
  for (const c of report.categoryAnalysis) report.appendix.queries.push({ section: 'Category analysis', label: `${c.measure} by ${c.dimension}`, sql: c.sql });
  for (const a of report.anomalies) report.appendix.queries.push({ section: 'Anomalies', label: a.measure, sql: a.sql });
  report.appendix.methodology = [
    'All figures come from read-only queries on your data and deterministic statistics; no number is written by an AI model.',
    'Trends use least-squares regression on period totals; a trend is called increasing/decreasing only when it explains enough variance and exceeds 1% of the mean per period.',
    'Anomalies are flagged with IQR, modified z-score (MAD) and z-score; "high" confidence means at least two methods agree.',
    'Recommendations are rule-based and each cites the finding that triggered it.',
  ];

  // ---- Supporting data ----
  report.supportingData = [
    ...report.trends.map((t) => ({ title: `${t.measure} by ${t.grain}`, columns: ['period', 'value'], rows: t.data })),
    ...report.categoryAnalysis.map((c) => ({ title: `${pretty(c.measure)} by ${pretty(c.dimension)}`, columns: Object.keys(c.data[0] || {}), rows: c.data })),
  ];
  return report;
}

module.exports = { buildManagementReport, pickPrimary };
