/**
 * EXECUTIVE INTELLIGENCE LAYER (blueprint #21): "Today's Intelligence"
 * Proactive: nobody asks. For every dataset a user can read, run the generic checks and
 * return ranked alerts (red / orange / green) with the numbers that justify them.
 * Dataset-wide statistics are skipped for row-restricted roles (they would leak hidden rows).
 */
const { runSafeSql, policyRestrictsAggregates, isColumnDenied } = require('../agent/safe.query');
const { focusOf } = require('../agent/orchestrator');
const { bucketSeries, analyzeTrend } = require('./trend');
const { detectAnomalies } = require('./anomaly');
const { compareGroups } = require('./compare');
const S = require('./stats');
const { qi } = require('../agent/column.resolver');

const pretty = (c) => String(c).replace(/_/g, ' ');
const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : +Number(n).toFixed(2)) : 'n/a');
const RANK = { red: 0, orange: 1, green: 2, info: 3 };

async function briefDataset(dataset, policy) {
  const alerts = [];
  const semantic = dataset.profile?.semantic;
  if (!semantic) return alerts;
  const name = dataset.name;
  const push = (severity, title, detail, extra = {}) => alerts.push({ severity, title, detail, dataset_id: dataset.dataset_id, dataset: name, ...extra });
  if (policyRestrictsAggregates(policy)) return [{ severity: 'info', title: 'Restricted view', detail: `Dataset-wide insights for "${name}" are hidden because row-level restrictions apply to your role.`, dataset_id: dataset.dataset_id, dataset: name }];

  // data quality
  const q = dataset.profile?.quality;
  if (q) {
    const high = q.tables.flatMap((t) => t.issues.filter((i) => i.severity === 'high' && (!i.column || !isColumnDenied(policy, t.name, i.column))).map((i) => ({ ...i, table: t.name })));
    if (high.length) push('red', `Data quality: ${high.length} high-severity issue${high.length === 1 ? '' : 's'}`, high.slice(0, 2).map((i) => i.message).join(' '), { kind: 'quality', ask: 'Are there any data quality problems?' });
    else if (q.overallScore < 85) push('orange', `Data quality score ${q.overallScore}/100`, 'Some columns have missing or inconsistent values that may affect conclusions.', { kind: 'quality', ask: 'Are there any data quality problems?' });
  }

  for (const table of semantic.tables.slice(0, 2)) {
    const f = focusOf(semantic, table, policy);
    const tq = qi(table.name);
    const label = f.measure ? pretty(f.measure.name) : `${pretty(table.name)} records`;
    try {
      if (f.date) {
        const agg = f.measure ? `SUM(${qi(f.measure.name)})` : 'COUNT(*)';
        const res = await runSafeSql({ dataset, policy, sql: `SELECT ${qi(f.date.name)} AS date, ${agg} AS value FROM ${tq} WHERE ${qi(f.date.name)} IS NOT NULL GROUP BY ${qi(f.date.name)} ORDER BY ${qi(f.date.name)}` });
        const { grain, series } = bucketSeries(res.rows, { minBuckets: 6 });
        if (series.length >= 3) {
          const t = analyzeTrend(series);
          const last = t.latestVsPreviousPct;
          if (last !== null && last <= -10) push('red', `${label} dropped ${Math.abs(last)}% in ${t.last.label}`, `From ${fmt(series[series.length - 2].value)} to ${fmt(t.last.value)} versus the previous ${grain}.`, { kind: 'trend', ask: `Why did ${label} change in the latest period?` });
          else if (last !== null && last >= 10) push('green', `${label} rose ${last}% in ${t.last.label}`, `From ${fmt(series[series.length - 2].value)} to ${fmt(t.last.value)} versus the previous ${grain}.`, { kind: 'trend', ask: `What is driving ${label}?` });
          if (t.direction === 'decreasing') push('orange', `${label} is trending down`, `${t.totalChangePct}% from ${t.first.label} to ${t.last.label}.`, { kind: 'trend', ask: `Is ${label} increasing or decreasing?` });
          else if (t.direction === 'increasing' && !(last !== null && last >= 10)) push('green', `${label} is trending up`, `+${t.totalChangePct}% from ${t.first.label} to ${t.last.label}.`, { kind: 'trend', ask: `Forecast ${label} for the next 3 months` });
        }
      }
      if (f.measure) {
        const res = await runSafeSql({ dataset, policy, sql: `SELECT ${qi(f.measure.name)} AS value FROM ${tq} WHERE ${qi(f.measure.name)} IS NOT NULL` });
        const vals = res.rows.map((r) => Number(r.value));
        const an = vals.length >= 8 ? detectAnomalies(vals) : [];
        if (an.length) push('orange', `${an.length} unusual ${pretty(f.measure.name)} value${an.length === 1 ? '' : 's'}`, `Most extreme: ${fmt(an[0].value)} (typical value ${fmt(S.median(vals))}).`, { kind: 'anomaly', ask: `Are there any unusual ${pretty(f.measure.name)} values?` });
      }
      if (f.measure && f.category) {
        const res = await runSafeSql({ dataset, policy, sql: `SELECT ${qi(f.category.name)} AS label, SUM(${qi(f.measure.name)}) AS value FROM ${tq} WHERE ${qi(f.category.name)} IS NOT NULL GROUP BY ${qi(f.category.name)}` });
        const items = res.rows.map((r) => ({ label: String(r.label), value: Number(r.value) })).filter((i) => Number.isFinite(i.value));
        if (items.length >= 3) {
          const c = compareGroups(items);
          const top = c.items[0];
          if (top.shareOfTotalPct >= 40 && items.every((i) => i.value >= 0)) push('orange', `${top.label} concentrates ${top.shareOfTotalPct}% of ${pretty(f.measure.name)}`, `Across ${items.length} ${pretty(f.category.name)} groups.`, { kind: 'concentration', ask: `Show ${pretty(f.measure.name)} by ${pretty(f.category.name)}` });
        }
      }
    } catch (_) { /* a failing check must not break the briefing */ }
  }
  return alerts;
}

async function buildBriefing({ datasets, policyFor }) {
  const all = [];
  for (const d of datasets) {
    if (d.status !== 'ready' || !d.profile?.semantic) continue;
    all.push(...(await briefDataset(d, policyFor(d.dataset_id))));
  }
  all.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const count = (s) => all.filter((a) => a.severity === s).length;
  return {
    generated_at: new Date().toISOString(),
    headline: all.length ? `${count('red')} critical, ${count('orange')} to review, ${count('green')} positive` : 'No datasets with enough data to analyse yet.',
    counts: { red: count('red'), orange: count('orange'), green: count('green') },
    alerts: all.slice(0, 20),
  };
}

module.exports = { buildBriefing, briefDataset };
