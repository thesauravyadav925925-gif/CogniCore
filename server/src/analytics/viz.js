/**
 * AUTOMATIC VISUALIZATION SELECTION (Feature 8)
 * Picks the chart type from the *shape* of the result - never from the domain:
 *   one number                     -> KPI card
 *   time + measure                 -> line (area when cumulative)
 *   category + measure (few)       -> bar (horizontal when many / long labels)
 *   category + measure (share)     -> pie/donut when <=6 slices and the question asks for distribution
 *   category + category + measure  -> stacked bar
 *   measure only, many rows        -> histogram
 *   measure + measure              -> scatter
 *   otherwise                      -> table
 * Returns a renderer-agnostic spec the frontend (or SVG exporter) draws.
 */
const { classifyResultColumns } = require('./insights');

const DIST = /(distribution|breakdown|share|split|proportion|composition|percentage of|by percent|expense.*(by|per)|makeup|make up)/i;
const CUMUL = /(cumulative|running total|year[- ]to[- ]date)/i;
const CORR = /(correlat|relationship between|versus|vs\.?|against)/i;

const pretty = (c) => String(c).replace(/_/g, ' ');

function selectChart({ question = '', columns = [], rows = [] }) {
  if (!rows.length || !columns.length) return { type: 'none', reason: 'no data' };
  const info = classifyResultColumns(columns, rows);
  const time = info.filter((c) => c.dateLike || (c.numeric && /(^|_)(year|month|quarter|period|week|day)$/i.test(c.name)));
  const measures = info.filter((c) => c.numeric && !time.includes(c) && !/(^|_)id$/i.test(c.name));
  const cats = info.filter((c) => !c.numeric && !c.dateLike);

  if (rows.length === 1 && measures.length >= 1) {
    return { type: 'kpi', reason: 'single-row result', cards: measures.slice(0, 4).map((m) => ({ label: pretty(m.name), value: rows[0][m.name] })) };
  }
  if (time.length && measures.length) {
    const x = time[0].name;
    const type = CUMUL.test(question) ? 'area' : 'line';
    if (cats.length && rows.length > 3 && cats[0].distinct <= 8 && cats[0].distinct > 1) {
      return { type: 'multi_line', reason: 'time series split by category', x, y: measures[0].name, series: cats[0].name, title: title(measures[0].name, x) };
    }
    return { type, reason: 'time series', x, y: measures.slice(0, 3).map((m) => m.name), title: title(measures[0].name, x) };
  }
  if (cats.length >= 2 && measures.length >= 1 && rows.length <= 60) {
    const distinct = cats.slice(0, 2).map((c) => c.distinct);
    if (distinct[1] <= 8) return { type: 'stacked_bar', reason: 'two categories and a measure', x: cats[0].name, series: cats[1].name, y: measures[0].name, title: title(measures[0].name, cats[0].name) };
  }
  if (cats.length >= 1 && measures.length >= 1) {
    const c = cats[0], m = measures[0];
    const positive = rows.every((r) => Number(r[m.name]) >= 0);
    if (rows.length <= 6 && positive && (DIST.test(question) || /percent|share|pct/i.test(m.name))) {
      return { type: 'pie', reason: 'few parts of a whole', label: c.name, value: m.name, title: title(m.name, c.name) };
    }
    const longLabels = rows.some((r) => String(r[c.name]).length > 14);
    return { type: rows.length > 8 || longLabels ? 'horizontal_bar' : 'bar', reason: 'comparison across categories', x: c.name, y: measures.slice(0, 2).map((mm) => mm.name), title: title(m.name, c.name) };
  }
  if (measures.length >= 2 && (CORR.test(question) || rows.length > 8)) {
    return { type: 'scatter', reason: 'two numeric measures', x: measures[0].name, y: measures[1].name, title: `${pretty(measures[1].name)} vs ${pretty(measures[0].name)}` };
  }
  if (measures.length === 1 && cats.length === 0 && rows.length >= 10) {
    return { type: 'histogram', reason: 'distribution of one measure', value: measures[0].name, bins: Math.min(12, Math.ceil(Math.sqrt(rows.length))), title: `Distribution of ${pretty(measures[0].name)}` };
  }
  return { type: 'table', reason: 'no clear chart shape' };
}

const title = (y, x) => `${pretty(y)} by ${pretty(x)}`;

/** Histogram bins for a numeric array (used by the exporter and API). */
function histogramBins(values, bins = 10) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return [];
  const lo = Math.min(...v), hi = Math.max(...v);
  if (lo === hi) return [{ from: lo, to: hi, count: v.length }];
  const w = (hi - lo) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ from: +(lo + i * w).toFixed(4), to: +(lo + (i + 1) * w).toFixed(4), count: 0 }));
  v.forEach((x) => { out[Math.min(bins - 1, Math.floor((x - lo) / w))].count++; });
  return out;
}

module.exports = { selectChart, histogramBins };
