/**
 * ANALYTIC TOOLS (Features 10-13, 15, 26-29 as chat-callable tools)
 * Each tool: (ctx) -> result | null
 *   ctx = { question, dataset, semantic, table, words, policy }
 *   result = { answer, evidence, generatedSql, execResult?, analytics }
 * Returning null means "I can't resolve this confidently" and the caller falls
 * back to the normal LLM SQL pipeline - tools never guess.
 * All numbers in `answer` come from executed queries + deterministic stats.
 */
const R = require('./column.resolver');
const { runSafeSql, policyRestrictsAggregates, isColumnDenied } = require('./safe.query');
const { buildStructuredEvidence } = require('../evidence/evidence.manager');
const { detectAnomalies, isolationForest } = require('../analytics/anomaly');
const { bucketSeries, analyzeTrend, describeTrend, rankByImprovement } = require('../analytics/trend');
const { forecast, nextLabels } = require('../analytics/forecast');
const { compareTwo, compareGroups } = require('../analytics/compare');
const { generateKpis } = require('../analytics/kpi');
const { exploreQuestions } = require('../analytics/exploration');
const { runDataScience } = require('../python/python.tool');
const { createAdapter } = require('../ingestion/adapters');
const { parseDateLoose, bucketKey } = require('../utils/dates');
const S = require('../analytics/stats');
const { describeValues, detectSeasonality } = require('../analytics/descriptive');
const { parseScenario, applyScenario } = require('../analytics/scenario');

const pretty = (c) => String(c).replace(/_/g, ' ');
const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : +Number(n).toFixed(2)) : 'n/a');
const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`;
const { qi } = R;

function evidenceFor(ctx, sql, rows, columns, extras = {}) {
  const result = { rowCount: rows.length, truncated: false, columns, rows };
  return buildStructuredEvidence({
    datasetId: ctx.dataset.dataset_id, datasetName: ctx.dataset.name, sql, result,
    resultValidation: { confidence: 0.95, issues: [] }, extras: { tables_used: [ctx.table.name], ...extras },
  });
}

/** WHERE clause from category values literally mentioned in the question. */
function mentionFilter(ctx, { skipColumns = [] } = {}) {
  const mentions = R.findMentionedValues(ctx.table, ctx.question).filter((m) => !skipColumns.includes(m.column));
  const byCol = new Map();
  mentions.forEach((m) => { if (!byCol.has(m.column)) byCol.set(m.column, []); byCol.get(m.column).push(m.value); });
  const conds = [...byCol.entries()].map(([col, vals]) => `${qi(col)} IN (${vals.map(sqlStr).join(', ')})`);
  return { where: conds, mentions };
}

const withWhere = (base, conds) => (conds.length ? `${base} AND ${conds.join(' AND ')}` : base);
const aggFor = (ctx, measure) => {
  if (!measure) return 'count';
  if (/\b(average|avg|mean)\b/i.test(ctx.question) || measure.role === 'percentage') return 'avg';
  return 'sum';
};
const aggSql = (agg, measure) => (agg === 'count' ? 'COUNT(*)' : `${agg === 'avg' ? 'AVG' : 'SUM'}(${qi(measure.name)})`);

// ---------------------------------------------------------------- time series
async function fetchSeries(ctx, { measure, date, agg, extraWhere = [] }) {
  const base = `${qi(date.name)} IS NOT NULL`;
  const sql = `SELECT ${qi(date.name)} AS date, ${aggSql(agg, measure)} AS value FROM ${qi(ctx.table.name)} WHERE ${withWhere(base, extraWhere)} GROUP BY ${qi(date.name)} ORDER BY ${qi(date.name)}`;
  const res = await runSafeSql({ dataset: ctx.dataset, sql, policy: ctx.policy });
  return { sql, res };
}

function seriesContext(ctx) {
  const date = R.pickDate(ctx.table, ctx.words);
  if (!date) return null;
  const m = R.pickMeasure(ctx.table, ctx.words);
  const wantsCount = /\b(how many|number of|count|appointments|records|visits|orders|transactions)\b/i.test(ctx.question) && !(m && m.explicit);
  const measure = wantsCount ? null : (m ? m.column : null);
  if (measure && isColumnDenied(ctx.policy, ctx.table.name, measure.name)) return { denied: measure.name };
  if (isColumnDenied(ctx.policy, ctx.table.name, date.name)) return { denied: date.name };
  return { date, measure, agg: aggFor(ctx, measure) };
}

const deniedAnswer = (col) => ({ answer: `Access denied: your role does not have access to the column "${col}".`, denied: true, evidence: null, lowConfidence: true });

async function trendTool(ctx) {
  const sc = seriesContext(ctx);
  if (!sc) return null;
  if (sc.denied) return deniedAnswer(sc.denied);
  const { date, measure, agg } = sc;
  const label = measure ? `${agg === 'avg' ? 'average ' : ''}${pretty(measure.name)}` : `number of ${pretty(ctx.table.name)} records`;

  // "Which <category> improved the most?" -> per-group trend ranking
  const cat = R.pickCategory(ctx.table, ctx.words);
  if (cat && /(improv|declin|grown|growing|fastest|most)/i.test(ctx.question)) {
    if (isColumnDenied(ctx.policy, ctx.table.name, cat.name)) return deniedAnswer(cat.name);
    const { where } = mentionFilter(ctx, { skipColumns: [cat.name] });
    const sql = `SELECT ${qi(cat.name)} AS grp, ${qi(date.name)} AS date, ${aggSql(agg, measure)} AS value FROM ${qi(ctx.table.name)} WHERE ${withWhere(`${qi(date.name)} IS NOT NULL AND ${qi(cat.name)} IS NOT NULL`, where)} GROUP BY ${qi(cat.name)}, ${qi(date.name)}`;
    const res = await runSafeSql({ dataset: ctx.dataset, sql, policy: ctx.policy });
    const groups = {};
    const grain = bucketSeries(res.rows.map((r) => ({ date: r.date, value: r.value })), { minBuckets: 4 }).grain;
    const perGroup = {};
    res.rows.forEach((r) => (perGroup[r.grp] = perGroup[r.grp] || []).push({ date: r.date, value: r.value }));
    for (const [g, rows] of Object.entries(perGroup)) groups[g] = bucketSeries(rows, { grain, agg: agg === 'avg' ? 'avg' : 'sum' }).series;
    const ranking = rankByImprovement(groups);
    if (ranking.length < 2) return null;
    const rows = ranking.map((r) => ({ [cat.name]: r.name, change: S.round(r.change, 2), change_pct: r.changePct, trend: r.direction }));
    const winner = ranking[0];
    const answer = `${winner.name} improved the most in ${label} (${winner.change >= 0 ? '+' : ''}${fmt(winner.change)}${winner.changePct !== null ? `, ${fmt(winner.changePct)}%` : ''} from first to last ${grain}). ${ranking[ranking.length - 1].name} changed the least or declined (${fmt(ranking[ranking.length - 1].change)}).`;
    return { answer, evidence: evidenceFor(ctx, sql, rows, [cat.name, 'change', 'change_pct', 'trend'], { analytics: { tool: 'trend_ranking', grain } }), generatedSql: sql, analytics: { tool: 'trend_ranking', ranking } };
  }

  const { where, mentions } = mentionFilter(ctx);
  const { sql, res } = await fetchSeries(ctx, { measure, date, agg, extraWhere: where });
  const { grain, series } = bucketSeries(res.rows, { agg: agg === 'avg' ? 'avg' : 'sum', minBuckets: 6 });
  if (series.length < 3) return { answer: `There are only ${series.length} time period(s) of data for ${label}, so a trend cannot be described reliably.`, evidence: evidenceFor(ctx, sql, series.map((s) => ({ period: s.label, value: S.round(s.value, 2) })), ['period', 'value']), generatedSql: sql, analytics: { tool: 'trend', direction: 'insufficient_data' }, lowConfidence: true };
  const t = analyzeTrend(series);
  const scope = mentions.length ? ` for ${mentions.map((m) => m.value).join(', ')}` : '';
  const ma = S.movingAverage(series.map((x) => x.value), 3);
  const rows = series.map((s, i) => ({ period: s.label, value: S.round(s.value, 2), moving_avg_3: ma[i] === null ? null : S.round(ma[i], 2) }));
  const season = detectSeasonality(series.map((x) => x.value));
  const seasonText = season ? ` A repeating pattern shows up roughly every ${season.period} ${grain}s (autocorrelation ${season.strength}).` : '';
  return {
    answer: describeTrend(t, { measure: label + scope }) + seasonText,
    evidence: evidenceFor(ctx, sql, rows, ['period', 'value', 'moving_avg_3'], { analytics: { tool: 'trend', grain, direction: t.direction, seasonality: season } }),
    generatedSql: sql, analytics: { tool: 'trend', grain, trend: t, seasonality: season },
  };
}

async function forecastTool(ctx) {
  const sc = seriesContext(ctx);
  if (!sc) return null;
  if (sc.denied) return deniedAnswer(sc.denied);
  const { date, measure, agg } = sc;
  const { horizon, unit } = R.parseHorizon(ctx.question, 3);
  const { where, mentions } = mentionFilter(ctx);
  const { sql, res } = await fetchSeries(ctx, { measure, date, agg, extraWhere: where });
  const grain = (unit && R.UNIT_TO_GRAIN[unit]) || null;
  const { grain: usedGrain, series } = bucketSeries(res.rows, { agg: agg === 'avg' ? 'avg' : 'sum', grain, minBuckets: 8 });
  const label = measure ? `${agg === 'avg' ? 'average ' : ''}${pretty(measure.name)}` : `${pretty(ctx.table.name)} record count`;
  // The most recent bucket may be partial; keep it but say so when we can.
  const f = forecast(series.map((s) => s.value), { horizon, seasonLength: usedGrain === 'month' && series.length >= 24 ? 12 : null });
  if (f.error) return { answer: `I can't forecast ${label}: ${f.error} (found ${series.length} period${series.length === 1 ? '' : 's'}).`, evidence: evidenceFor(ctx, sql, series.map((s) => ({ period: s.label, value: S.round(s.value, 2) })), ['period', 'value']), generatedSql: sql, analytics: { tool: 'forecast', error: f.error }, lowConfidence: true };
  const labels = nextLabels(series[series.length - 1].label, usedGrain, horizon);
  const rows = f.predictions.map((p, i) => ({ period: labels[i], forecast: S.round(p.value, 2), lower: S.round(p.lower, 2), upper: S.round(p.upper, 2), type: 'forecast' }));
  const scope = mentions.length ? ` for ${mentions.map((m) => m.value).join(', ')}` : '';
  const err = f.backtest.mape !== null ? ` Backtest error on past periods was about ${fmt(f.backtest.mape)}% (MAPE).` : '';
  const lastActual = series[series.length - 1];
  const answer = `Forecast (statistical projection, not recorded data) of ${label}${scope} using ${f.method.replace(/_/g, ' ')} on ${f.basedOnPeriods} historical ${usedGrain}s: ${rows.map((r) => `${r.period} ≈ ${fmt(r.forecast)} (range ${fmt(r.lower)}–${fmt(r.upper)})`).join('; ')}. Last recorded ${usedGrain} (${lastActual.label}): ${fmt(lastActual.value)}.${err}`;
  return { answer, evidence: evidenceFor(ctx, sql, rows, ['period', 'forecast', 'lower', 'upper', 'type'], { analytics: { tool: 'forecast', method: f.method, disclaimer: f.disclaimer } }), generatedSql: sql, analytics: { tool: 'forecast', forecast: f, history: series } };
}

// -------------------------------------------------------------------- anomaly
async function anomalyTool(ctx) {
  const m = R.pickMeasure(ctx.table, ctx.words);
  if (!m) return null;
  const measure = m.column;
  if (isColumnDenied(ctx.policy, ctx.table.name, measure.name)) return deniedAnswer(measure.name);
  const cat = R.pickCategory(ctx.table, ctx.words);
  const { where } = mentionFilter(ctx, { skipColumns: cat ? [cat.name] : [] });

  // Group-level anomalies: "departments with unusually high expenses"
  if (cat && cat.stats.distinct >= 5 && !isColumnDenied(ctx.policy, ctx.table.name, cat.name)) {
    const agg = aggFor(ctx, measure);
    const sql = `SELECT ${qi(cat.name)} AS grp, ${aggSql(agg, measure)} AS value FROM ${qi(ctx.table.name)} WHERE ${withWhere(`${qi(measure.name)} IS NOT NULL AND ${qi(cat.name)} IS NOT NULL`, where)} GROUP BY ${qi(cat.name)}`;
    const res = await runSafeSql({ dataset: ctx.dataset, sql, policy: ctx.policy });
    const vals = res.rows.map((r) => Number(r.value));
    const an = detectAnomalies(vals);
    const rows = an.map((a) => ({ [cat.name]: res.rows[a.index].grp, [`${agg}_${measure.name}`]: S.round(a.value, 2), direction: a.value >= S.median(vals) ? 'high' : 'low', methods: a.methods.join('+'), confidence: a.confidence }));
    const answer = an.length
      ? `${an.length} of ${res.rows.length} ${pretty(cat.name)} groups have unusual ${agg === 'avg' ? 'average ' : 'total '}${pretty(measure.name)}: ${rows.slice(0, 5).map((r) => `${r[cat.name]} (${fmt(r[`${agg}_${measure.name}`])}, ${r.direction})`).join(', ')}. The typical (median) group value is ${fmt(S.median(vals))}.`
      : `No ${pretty(cat.name)} group has an unusual ${pretty(measure.name)}: all ${res.rows.length} groups are within the normal statistical range (median ${fmt(S.median(vals))}).`;
    return { answer, evidence: evidenceFor(ctx, sql, rows, an.length ? Object.keys(rows[0]) : [cat.name], { analytics: { tool: 'anomaly', level: 'group' } }), generatedSql: sql, analytics: { tool: 'anomaly', level: 'group', count: an.length, total: res.rows.length } };
  }

  // Record-level anomalies
  const label = R.pickLabelColumn(ctx.table);
  const cols = [label?.name, measure.name].filter(Boolean).filter((c, i, a) => a.indexOf(c) === i);
  const extraMeasures = ctx.table.columns.filter((c) => R.MEASURE_ROLES.includes(c.role) && c.name !== measure.name && !isColumnDenied(ctx.policy, ctx.table.name, c.name)).slice(0, 3);
  const selectCols = [...cols, ...extraMeasures.map((c) => c.name)].filter((c, i, a) => a.indexOf(c) === i);
  if (label && isColumnDenied(ctx.policy, ctx.table.name, label.name)) selectCols.splice(selectCols.indexOf(label.name), 1);
  const sql = `SELECT ${selectCols.map(qi).join(', ')} FROM ${qi(ctx.table.name)} WHERE ${withWhere(`${qi(measure.name)} IS NOT NULL`, where)}`;
  const res = await runSafeSql({ dataset: ctx.dataset, sql, policy: ctx.policy });
  const values = res.rows.map((r) => Number(r[measure.name]));
  if (values.length < 5) return { answer: `There are only ${values.length} records, which is too few to identify unusual values reliably.`, evidence: null, lowConfidence: true };
  const ordered = ctx.table.columns.some((c) => c.role === 'temporal') && /\b(sequence|over time|spike|drop|sudden)\b/i.test(ctx.question);
  const an = detectAnomalies(values, { ordered });
  let multivariate = [];
  if (extraMeasures.length && res.rows.length >= 30) {
    const mat = res.rows.map((r) => [Number(r[measure.name]), ...extraMeasures.map((c) => Number(r[c.name]))]);
    multivariate = isolationForest(mat).anomalies;
  }
  const seen = new Set(an.map((a) => a.index));
  const extra = multivariate.filter((a) => !seen.has(a.index)).map((a) => ({ index: a.index, value: values[a.index], methods: ['isolation_forest'], score: a.score, confidence: 'medium' }));
  const all = [...an, ...extra].sort((a, b) => (b.confidence === 'high') - (a.confidence === 'high') || b.score - a.score).slice(0, 25);
  const med = S.median(values);
  const rows = all.map((a) => ({ ...(label && selectCols.includes(label.name) ? { [label.name]: res.rows[a.index][label.name] } : { row: a.index + 1 }), [measure.name]: a.value, direction: a.value >= med ? 'high' : 'low', methods: a.methods.join('+'), confidence: a.confidence }));
  const answer = all.length
    ? `Found ${all.length} unusual ${pretty(measure.name)} value${all.length === 1 ? '' : 's'} among ${values.length} records (typical/median value ${fmt(med)}). Most extreme: ${rows.slice(0, 3).map((r) => `${label && r[label.name] !== undefined ? r[label.name] + ' = ' : ''}${fmt(r[measure.name])} (${r.direction})`).join('; ')}. Flagged with ${[...new Set(all.flatMap((a) => a.methods))].join(', ')}; "high" confidence means more than one method agreed.`
    : `No unusual ${pretty(measure.name)} values were found among ${values.length} records - all values fall within the expected statistical range (median ${fmt(med)}).`;
  return { answer, evidence: evidenceFor(ctx, sql, rows, rows.length ? Object.keys(rows[0]) : [measure.name], { analytics: { tool: 'anomaly', level: 'record', flagged: all.length, scanned: values.length } }), generatedSql: sql, analytics: { tool: 'anomaly', level: 'record', count: all.length, total: values.length } };
}

// ----------------------------------------------------------------- correlation
async function correlationTool(ctx) {
  const pair = R.pickTwoMeasures(ctx.table, ctx.words);
  if (!pair) return null;
  if (pair.some((c) => isColumnDenied(ctx.policy, ctx.table.name, c.name))) return deniedAnswer(pair.find((c) => isColumnDenied(ctx.policy, ctx.table.name, c.name)).name);
  const [a, b] = pair;
  const sql = `SELECT ${qi(a.name)}, ${qi(b.name)} FROM ${qi(ctx.table.name)} WHERE ${qi(a.name)} IS NOT NULL AND ${qi(b.name)} IS NOT NULL`;
  const res = await runSafeSql({ dataset: ctx.dataset, sql, policy: ctx.policy });
  if (res.rows.length < 5) return { answer: `Only ${res.rows.length} complete records exist for ${pretty(a.name)} and ${pretty(b.name)} - too few to measure a correlation.`, evidence: null, lowConfidence: true };
  const ds = await runDataScience({ op: 'correlation', columns: { [a.name]: res.rows.map((r) => r[a.name]), [b.name]: res.rows.map((r) => r[b.name]) } });
  const p = ds.result.pairs[0];
  if (!p) return { answer: `No correlation can be computed between ${pretty(a.name)} and ${pretty(b.name)} (one of them does not vary).`, evidence: null, lowConfidence: true };
  const r = S.round(p.pearson, 3);
  const answer = `${pretty(a.name)} and ${pretty(b.name)} have a ${p.strength} ${p.direction} correlation (Pearson r = ${r}${p.spearman !== undefined && p.spearman !== null ? `, Spearman ρ = ${S.round(p.spearman, 3)}` : ''}, n = ${p.n}). ${p.direction === 'positive' ? 'As one rises the other tends to rise.' : 'As one rises the other tends to fall.'} Correlation does not imply causation.`;
  const rows = [{ variable_a: a.name, variable_b: b.name, pearson_r: r, spearman_rho: S.round(p.spearman, 3), strength: p.strength, n: p.n }];
  return { answer, evidence: evidenceFor(ctx, sql, rows, Object.keys(rows[0]), { analytics: { tool: 'correlation', engine: ds.engine } }), generatedSql: sql, analytics: { tool: 'correlation', engine: ds.engine, pair: p } };
}

// -------------------------------------------------------------------- compare
async function compareTool(ctx) {
  const mentions = R.findMentionedValues(ctx.table, ctx.question);
  const byCol = {};
  mentions.forEach((m) => (byCol[m.column] = byCol[m.column] || new Set()).add(m.value));
  const target = Object.entries(byCol).find(([, v]) => v.size >= 2);
  const m = R.pickMeasure(ctx.table, ctx.words);
  const measure = m && m.explicit ? m.column : (m && ctx.table.columns.some((c) => c.role === 'monetary') ? m.column : null);
  if (target) {
    const [col, vals] = target;
    if (isColumnDenied(ctx.policy, ctx.table.name, col) || (measure && isColumnDenied(ctx.policy, ctx.table.name, measure.name))) return deniedAnswer(isColumnDenied(ctx.policy, ctx.table.name, col) ? col : measure.name);
    const agg = aggFor(ctx, measure);
    const sql = `SELECT ${qi(col)} AS label, ${aggSql(agg, measure)} AS value FROM ${qi(ctx.table.name)} WHERE ${qi(col)} IN (${[...vals].map(sqlStr).join(', ')}) GROUP BY ${qi(col)}`;
    const res = await runSafeSql({ dataset: ctx.dataset, sql, policy: ctx.policy });
    if (res.rows.length < 2) return null;
    const what = measure ? `${agg === 'avg' ? 'average ' : ''}${pretty(measure.name)}` : `number of ${pretty(ctx.table.name)} records`;
    const cmp = res.rows.length === 2 ? compareTwo({ label: String(res.rows[0].label), value: Number(res.rows[0].value) }, { label: String(res.rows[1].label), value: Number(res.rows[1].value) }, { measure: what }) : compareGroups(res.rows.map((r) => ({ label: String(r.label), value: Number(r.value) })), { measure: what });
    const rows = res.rows.map((r) => ({ [col]: r.label, value: S.round(Number(r.value), 2) }));
    return { answer: cmp.sentence, evidence: evidenceFor(ctx, sql, rows, [col, 'value'], { analytics: { tool: 'compare' } }), generatedSql: sql, analytics: { tool: 'compare', comparison: cmp } };
  }
  // year-vs-year
  const years = [...new Set((ctx.question.match(/\b(19|20)\d{2}\b/g) || []))];
  const date = R.pickDate(ctx.table, ctx.words);
  if (years.length === 2 && date && !isColumnDenied(ctx.policy, ctx.table.name, date.name)) {
    const agg = aggFor(ctx, measure);
    const sql = `SELECT ${qi(date.name)} AS date, ${aggSql(agg, measure)} AS value FROM ${qi(ctx.table.name)} WHERE ${qi(date.name)} IS NOT NULL GROUP BY ${qi(date.name)}`;
    const res = await runSafeSql({ dataset: ctx.dataset, sql, policy: ctx.policy });
    const totals = Object.fromEntries(years.map((y) => [y, 0]));
    const counts = Object.fromEntries(years.map((y) => [y, 0]));
    for (const r of res.rows) {
      const d = parseDateLoose(r.date)?.date;
      if (!d) continue;
      const y = String(d.getUTCFullYear());
      if (y in totals) { totals[y] += Number(r.value) || 0; counts[y]++; }
    }
    if (agg === 'avg') years.forEach((y) => { totals[y] = counts[y] ? totals[y] / counts[y] : 0; });
    if (!counts[years[0]] && !counts[years[1]]) return null;
    const [y1, y2] = years.sort();
    const what = measure ? pretty(measure.name) : `${pretty(ctx.table.name)} records`;
    const cmp = compareTwo({ label: y1, value: totals[y1] }, { label: y2, value: totals[y2] }, { measure: what });
    const rows = [y1, y2].map((y) => ({ year: y, value: S.round(totals[y], 2) }));
    return { answer: `${cmp.sentence}${cmp.percentChange !== null ? ` Change from ${y1} to ${y2}: ${cmp.percentChange > 0 ? '+' : ''}${fmt(cmp.percentChange)}%.` : ''}`, evidence: evidenceFor(ctx, sql, rows, ['year', 'value'], { analytics: { tool: 'compare' } }), generatedSql: sql, analytics: { tool: 'compare', comparison: cmp } };
  }
  return null; // let the SQL pipeline handle other comparisons
}

// --------------------------------------------------------- dataset-wide tools
function restrictedNotice() {
  return { answer: 'Dataset-wide summaries are not available for your role because row-level restrictions apply. Ask a specific question instead and it will be answered within your permitted rows.', evidence: null, lowConfidence: true, denied: true };
}

async function qualityTool(ctx) {
  const q = ctx.dataset.profile?.quality;
  if (!q) return null;
  if (policyRestrictsAggregates(ctx.policy)) return restrictedNotice();
  const denied = (c) => c && isColumnDenied(ctx.policy, '', c);
  const tables = q.tables.map((t) => ({ ...t, issues: t.issues.filter((i) => !denied(i.column)) }));
  const issues = tables.flatMap((t) => t.issues.map((i) => ({ table: t.name, ...i })));
  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  const rows = issues.map((i) => ({ table: i.table, column: i.column || '(row)', issue: i.type.replace(/_/g, ' '), severity: i.severity, count: i.count, detail: i.message }));
  const answer = issues.length
    ? `Data quality score: ${q.overallScore}/100 with ${issues.length} issue${issues.length === 1 ? '' : 's'}. ${issues.slice(0, 5).map((i) => i.message).join(' ')}${issues.length > 5 ? ` (+${issues.length - 5} more in the table.)` : ''}`
    : `Data quality score: ${q.overallScore}/100. No missing values, duplicates, invalid dates or other quality issues were detected.`;
  const evidence = evidenceFor(ctx, '(computed by the data-quality analyzer during ingestion)', rows, ['table', 'column', 'issue', 'severity', 'count', 'detail'], { analytics: { tool: 'data_quality', score: q.overallScore } });
  return { answer, evidence, generatedSql: null, analytics: { tool: 'data_quality', quality: { ...q, tables } } };
}

async function kpiTool(ctx) {
  if (!ctx.semantic) return null;
  if (policyRestrictsAggregates(ctx.policy)) return restrictedNotice();
  const adapter = createAdapter(ctx.dataset.type, { datasetId: ctx.dataset.dataset_id, location: ctx.dataset.location });
  await adapter.connect();
  let groups;
  try { groups = await generateKpis({ adapter, semantic: ctx.semantic, datasetType: ctx.dataset.type }); } finally { await adapter.disconnect(); }
  const rows = groups.flatMap((g) => g.kpis.filter((k) => k.value !== null && !isColumnDenied(ctx.policy, g.table, k.column)).map((k) => ({ table: g.table, kpi: k.label, value: k.value, unit: k.format })));
  if (!rows.length) return null;
  const headline = rows.slice(0, 6).map((r) => `${r.kpi}: ${fmt(r.value)}${r.unit === 'percent' || r.unit === 'percent_change' ? '%' : ''}`).join('; ');
  return { answer: `Key metrics — ${headline}.`, evidence: evidenceFor(ctx, '(KPI queries; each KPI lists its SQL in the analytics payload)', rows, ['table', 'kpi', 'value', 'unit'], { analytics: { tool: 'kpi' } }), generatedSql: null, analytics: { tool: 'kpi', groups } };
}

async function exploreTool(ctx) {
  if (!ctx.semantic) return null;
  const qs = exploreQuestions(ctx.semantic).filter((q) => !(ctx.policy?.deniedColumns || []).some((d) => q.question.toLowerCase().includes(pretty(d.column).toLowerCase())));
  const rows = qs.map((q) => ({ category: q.category, question: q.question }));
  return { answer: `Here are ${qs.length} questions you can ask about this dataset:\n${qs.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}`, evidence: evidenceFor(ctx, '(generated from the semantic model)', rows, ['category', 'question'], { analytics: { tool: 'explore' } }), generatedSql: null, analytics: { tool: 'explore', questions: qs } };
}

// ------------------------------------------------------------------- describe
async function describeTool(ctx) {
  const m = R.pickMeasure(ctx.table, ctx.words);
  if (!m || !m.explicit) return null;
  const measure = m.column;
  if (isColumnDenied(ctx.policy, ctx.table.name, measure.name)) return deniedAnswer(measure.name);
  const { where, mentions } = mentionFilter(ctx);
  const sql = `SELECT ${qi(measure.name)} AS value FROM ${qi(ctx.table.name)} WHERE ${withWhere(`${qi(measure.name)} IS NOT NULL`, where)}`;
  const res = await runSafeSql({ dataset: ctx.dataset, sql, policy: ctx.policy, maxRows: 50000 });
  const d = describeValues(res.rows.map((r) => Number(r.value)));
  if (!d) return { answer: `There are no numeric ${pretty(measure.name)} values to describe.`, evidence: null, lowConfidence: true };
  const scope = mentions.length ? ` for ${mentions.map((x) => x.value).join(', ')}` : '';
  const rows = [['count', d.count], ['mean', d.mean], ['median', d.median], ['std deviation', d.std], ['variance', d.variance], ['minimum', d.min], ['5th percentile', d.p5], ['25th percentile', d.p25], ['75th percentile', d.p75], ['90th percentile', d.p90], ['95th percentile', d.p95], ['maximum', d.max], ['IQR', d.iqr], ['skewness', d.skew]].map(([statistic, value]) => ({ statistic, value }));
  const answer = `${pretty(measure.name)}${scope} across ${d.count} records: mean ${fmt(d.mean)}, median ${fmt(d.median)}, standard deviation ${fmt(d.std)}, range ${fmt(d.min)}–${fmt(d.max)}. The middle 50% of values lie between ${fmt(d.p25)} and ${fmt(d.p75)}, and 90% fall below ${fmt(d.p90)}. The distribution is ${d.shape}${d.cv !== null ? `; variability (CV) is ${fmt(d.cv * 100)}% of the mean` : ''}.`;
  return { answer, evidence: evidenceFor(ctx, sql, rows, ['statistic', 'value'], { analytics: { tool: 'describe', column: measure.name } }), generatedSql: sql, analytics: { tool: 'describe', stats: d } };
}

// ------------------------------------------------------------------ scenario
async function scenarioTool(ctx) {
  const sc = parseScenario(ctx.question);
  if (!sc) return null;
  const m = R.pickMeasure(ctx.table, ctx.words);
  if (!m) return null;
  const measure = m.column;
  if (isColumnDenied(ctx.policy, ctx.table.name, measure.name)) return deniedAnswer(measure.name);
  const mode = measure.role === 'percentage' || /\b(average|avg|mean|rate)\b/i.test(ctx.question) ? 'avg' : 'sum';
  const { where, mentions } = mentionFilter(ctx);
  const tq = qi(ctx.table.name), mq = qi(measure.name);
  const baseSql = `SELECT SUM(${mq}) AS total, AVG(${mq}) AS avg, COUNT(${mq}) AS n FROM ${tq} WHERE ${mq} IS NOT NULL`;
  const base = (await runSafeSql({ dataset: ctx.dataset, sql: baseSql, policy: ctx.policy })).rows[0];
  const baseline = { total: Number(base.total) || 0, avg: Number(base.avg) || 0, n: Number(base.n) || 0 };
  if (!baseline.n) return { answer: `There is no ${pretty(measure.name)} data to base a scenario on.`, evidence: null, lowConfidence: true };
  let slice = null, sliceSql = null;
  if (where.length) {
    sliceSql = `SELECT SUM(${mq}) AS total, AVG(${mq}) AS avg, COUNT(${mq}) AS n FROM ${tq} WHERE ${withWhere(`${mq} IS NOT NULL`, where)}`;
    const sr = (await runSafeSql({ dataset: ctx.dataset, sql: sliceSql, policy: ctx.policy })).rows[0];
    slice = { total: Number(sr.total) || 0, avg: Number(sr.avg) || 0, n: Number(sr.n) || 0 };
  }
  const clampMax = measure.role === 'percentage' && measure.stats.max <= 100 ? 100 : null;
  const out = applyScenario({ baseline, slice, mode, factor: sc.factor, clampMax });
  const what = `${mode === 'avg' ? 'average ' : 'total '}${pretty(measure.name)}`;
  const scopeText = mentions.length ? `${mentions.map((x) => x.value).join(' and ')} ${pretty(measure.name)}` : pretty(measure.name);
  const answer = `SIMULATED SCENARIO (not recorded data): if ${scopeText} ${sc.direction === 'up' ? 'increases' : 'decreases'} by ${sc.pct}%, ${what} would move from ${fmt(out.baseline)} to ${fmt(out.scenario)} (${out.change >= 0 ? '+' : ''}${fmt(out.change)}${out.change_pct !== null ? `, ${out.change_pct >= 0 ? '+' : ''}${fmt(out.change_pct)}%` : ''}).${out.clamped ? ' The result was capped at the maximum possible value (100).' : ''}${slice ? ` Only the ${mentions.map((x) => x.value).join('/')} slice (${slice.n} records, ${fmt(mode === 'avg' ? slice.avg : slice.total)}) is changed; everything else stays as recorded.` : ''}${m.explicit ? '' : ` (Assumed the measure is ${pretty(measure.name)}.)`} Current values are from your data; the changed values are hypothetical.`;
  const rows = [{ metric: what, baseline: out.baseline, scenario: out.scenario, change: out.change, change_pct: out.change_pct, type: 'scenario' }];
  return { answer, evidence: evidenceFor(ctx, [baseSql, sliceSql].filter(Boolean).join('  /  '), rows, Object.keys(rows[0]), { analytics: { tool: 'scenario', assumption: `${sc.direction} ${sc.pct}%`, simulated: true } }), generatedSql: baseSql, analytics: { tool: 'scenario', scenario: out, params: sc, simulated: true } };
}

const TOOLS = { describe: describeTool, scenario: scenarioTool, trend: trendTool, forecast: forecastTool, anomaly: anomalyTool, correlation: correlationTool, compare: compareTool, quality: qualityTool, kpi: kpiTool, explore: exploreTool };

module.exports = { describeTool, scenarioTool, TOOLS, trendTool, forecastTool, anomalyTool, correlationTool, compareTool, qualityTool, kpiTool, exploreTool };
