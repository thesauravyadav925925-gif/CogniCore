/**
 * INSIGHT ENGINE (Feature 9)
 * Turns a validated result set into plain-English observations, using only
 * deterministic statistics on that result: highest/lowest, concentration,
 * outliers, spread, trend & period-over-period change. Each insight carries the
 * numbers it is based on so the UI (and grounding checks) can verify them.
 */
const S = require('./stats');
const { detectAnomalies } = require('./anomaly');
const { analyzeTrend } = require('./trend');
const { parseDateLoose } = require('../utils/dates');

const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : +n.toFixed(2)) : 'n/a');
const pretty = (c) => String(c).replace(/_/g, ' ');

function classifyResultColumns(columns, rows) {
  const info = columns.map((name) => {
    const vals = rows.map((r) => r[name]).filter((v) => v !== null && v !== undefined && v !== '');
    const numeric = vals.length > 0 && vals.every((v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))));
    const dateLike = !numeric && vals.length > 0 && vals.every((v) => parseDateLoose(v) || /^\d{4}-(\d{2}|Q\d)$/.test(String(v)) || /^(19|20)\d{2}$/.test(String(v)));
    return { name, numeric, dateLike, distinct: new Set(vals.map(String)).size, n: vals.length };
  });
  return info;
}

function generateInsights(evidence, { maxInsights = 6 } = {}) {
  const out = [];
  if (!evidence || evidence.source_type !== 'database') return out;
  const { columns = [], sample_rows: rows = [], row_count: total } = evidence;
  if (rows.length < 2 || evidence.truncated === true && rows.length < 3) return out;
  const info = classifyResultColumns(columns, rows);
  const dims = info.filter((c) => !c.numeric && !c.dateLike && c.distinct >= Math.min(2, rows.length));
  const timeCols = info.filter((c) => c.dateLike || (c.numeric && /year|month|period|quarter/i.test(c.name)));
  const measures = info.filter((c) => c.numeric && !timeCols.includes(c) && !/(^|_)id$/i.test(c.name));
  const partial = total > rows.length ? ` (among the first ${rows.length} of ${total} rows)` : '';

  for (const m of measures.slice(0, 2)) {
    const vals = rows.map((r) => Number(r[m.name]));
    if (vals.filter(Number.isFinite).length < 2) continue;

    if (timeCols.length) {
      const t = timeCols[0];
      const ordered = rows.map((r) => ({ label: String(r[t.name]), value: Number(r[m.name]) })).sort((a, b) => a.label.localeCompare(b.label));
      const tr = analyzeTrend(ordered);
      if (tr.direction !== 'insufficient_data') {
        if (tr.latestVsPreviousPct !== null) {
          out.push({ kind: 'period_change', severity: Math.abs(tr.latestVsPreviousPct) >= 15 ? 'notable' : 'info',
            text: `${pretty(m.name)} ${tr.latestVsPreviousPct >= 0 ? 'increased' : 'decreased'} ${fmt(Math.abs(tr.latestVsPreviousPct))}% in ${tr.last.label} compared with the previous period (${fmt(ordered[ordered.length - 2].value)} → ${fmt(tr.last.value)}).`, numbers: [tr.latestVsPreviousPct, tr.last.value, ordered[ordered.length - 2].value] });
        }
        if (tr.direction !== 'flat') out.push({ kind: 'trend', severity: 'info', text: `Over ${tr.n} periods, ${pretty(m.name)} shows a ${tr.direction} pattern (${tr.first.label} → ${tr.last.label}${tr.totalChangePct !== null ? `, ${tr.totalChangePct > 0 ? '+' : ''}${fmt(tr.totalChangePct)}%` : ''}).`, numbers: [tr.totalChangePct] });
        out.push({ kind: 'extremes', severity: 'info', text: `${pretty(m.name)} peaked in ${tr.peak.label} (${fmt(tr.peak.value)}) and was lowest in ${tr.trough.label} (${fmt(tr.trough.value)}).`, numbers: [tr.peak.value, tr.trough.value] });
      }
    } else if (dims.length) {
      const d = dims[0];
      const items = rows.map((r) => ({ label: String(r[d.name]), value: Number(r[m.name]) })).filter((x) => Number.isFinite(x.value)).sort((a, b) => b.value - a.value);
      if (items.length >= 2) {
        const sum = S.sum(items.map((i) => i.value));
        const top = items[0], low = items[items.length - 1];
        out.push({ kind: 'highest', severity: 'info', text: `${top.label} has the highest ${pretty(m.name)} (${fmt(top.value)})${partial}; ${low.label} has the lowest (${fmt(low.value)}).`, numbers: [top.value, low.value] });
        const positive = items.every((i) => i.value >= 0) && sum > 0;
        if (positive) {
          const share = (top.value / sum) * 100;
          if (share >= 40 && items.length >= 3) out.push({ kind: 'concentration', severity: 'notable', text: `${top.label} alone accounts for ${fmt(share)}% of total ${pretty(m.name)}${partial}, indicating high concentration.`, numbers: [+share.toFixed(2)] });
          const top3 = S.sum(items.slice(0, 3).map((i) => i.value)) / sum * 100;
          if (items.length >= 6 && top3 >= 60) out.push({ kind: 'concentration', severity: 'info', text: `The top 3 of ${items.length} groups make up ${fmt(top3)}% of total ${pretty(m.name)}.`, numbers: [+top3.toFixed(2)] });
        }
        if (low.value !== 0 && top.value / Math.abs(low.value) >= 3) out.push({ kind: 'spread', severity: 'notable', text: `${top.label} is ${fmt(top.value / Math.abs(low.value))}× ${low.label} on ${pretty(m.name)}, a wide gap between groups.`, numbers: [+(top.value / Math.abs(low.value)).toFixed(2)] });
      }
    }

    const anomalies = detectAnomalies(vals.map((v) => (Number.isFinite(v) ? v : NaN)));
    if (anomalies.length && rows.length >= 8) {
      const a = anomalies[0];
      const label = dims[0] ? ` (${rows[a.index][dims[0].name]})` : '';
      out.push({ kind: 'anomaly', severity: 'notable', text: `${pretty(m.name)} has ${anomalies.length} unusual value${anomalies.length > 1 ? 's' : ''}; the most extreme is ${fmt(a.value)}${label}, far from typical values.`, numbers: [a.value] });
    }
  }
  return out.slice(0, maxInsights);
}

module.exports = { generateInsights, classifyResultColumns };
