/**
 * TREND ANALYSIS (Feature 11) - time treated as a dimension.
 * Works on an ordered series of {label, value}. Buckets raw (date, value) rows
 * by the coarsest sensible grain first when needed.
 */
const S = require('./stats');
const { parseDateLoose, bucketKey, chooseGrain } = require('../utils/dates');

/** rows: [{date, value}] -> ordered [{label, value}] aggregated with sum|avg|count */
function bucketSeries(rows, { agg = 'sum', grain = null, minBuckets = 6 } = {}) {
  const parsed = rows.map((r) => ({ d: parseDateLoose(r.date)?.date, v: Number(r.value) })).filter((r) => r.d && Number.isFinite(r.v));
  if (!parsed.length) return { grain: null, series: [] };
  const g = grain || chooseGrain(parsed.map((p) => p.d), minBuckets);
  const buckets = new Map();
  for (const p of parsed) {
    const k = bucketKey(p.d, g);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p.v);
  }
  const series = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, vs]) => ({
    label, value: agg === 'avg' ? S.mean(vs) : agg === 'count' ? vs.length : S.sum(vs),
  }));
  return { grain: g, series };
}

function analyzeTrend(series) {
  const pts = series.filter((p) => Number.isFinite(p.value));
  const n = pts.length;
  if (n < 3) return { direction: 'insufficient_data', n, message: 'At least 3 periods are needed to describe a trend.' };
  const xs = pts.map((_, i) => i), ys = pts.map((p) => p.value);
  const reg = S.linearRegression(xs, ys);
  const mean = S.mean(ys);
  const relSlope = mean !== 0 ? (reg.slope / Math.abs(mean)) * 100 : 0; // % of mean per period
  let direction = 'flat';
  if (reg.r2 >= 0.3 && Math.abs(relSlope) >= 1) direction = reg.slope > 0 ? 'increasing' : 'decreasing';
  else if (S.std(ys) / (Math.abs(mean) || 1) > 0.25) direction = 'volatile';
  const first = pts[0], last = pts[n - 1];
  const changes = pts.slice(1).map((p, i) => ({ from: pts[i].label, to: p.label, change: p.value - pts[i].value, pct: S.pctChange(pts[i].value, p.value) }));
  const best = changes.reduce((a, b) => (b.change > a.change ? b : a), changes[0]);
  const worst = changes.reduce((a, b) => (b.change < a.change ? b : a), changes[0]);
  const peak = pts.reduce((a, b) => (b.value > a.value ? b : a));
  const trough = pts.reduce((a, b) => (b.value < a.value ? b : a));
  return {
    direction, n, slopePerPeriod: S.round(reg.slope, 4), slopePctOfMeanPerPeriod: S.round(relSlope, 2), r2: S.round(reg.r2, 3),
    first, last, totalChangePct: S.round(S.pctChange(first.value, last.value), 2),
    peak, trough, biggestRise: best, biggestDrop: worst,
    latestVsPreviousPct: S.round(S.pctChange(pts[n - 2].value, last.value), 2),
  };
}

function describeTrend(t, { measure = 'value' } = {}) {
  if (t.direction === 'insufficient_data') return t.message;
  const dir = { increasing: 'is trending upward', decreasing: 'is trending downward', flat: 'is broadly flat', volatile: 'is volatile without a clear direction' }[t.direction];
  const bits = [`${measure} ${dir} across ${t.n} periods (${t.first.label} → ${t.last.label}).`];
  if (t.totalChangePct !== null) bits.push(`Overall change: ${t.totalChangePct > 0 ? '+' : ''}${t.totalChangePct}%.`);
  bits.push(`Peak: ${t.peak.label} (${S.round(t.peak.value)}); low: ${t.trough.label} (${S.round(t.trough.value)}).`);
  if (t.latestVsPreviousPct !== null) bits.push(`Latest period vs previous: ${t.latestVsPreviousPct > 0 ? '+' : ''}${t.latestVsPreviousPct}%.`);
  return bits.join(' ');
}

/** Which group improved the most? groups: {name: series[]} */
function rankByImprovement(groups) {
  return Object.entries(groups).map(([name, series]) => {
    const t = analyzeTrend(series);
    const first = series[0]?.value, last = series[series.length - 1]?.value;
    return { name, direction: t.direction, change: Number.isFinite(first) && Number.isFinite(last) ? last - first : null, changePct: t.totalChangePct ?? null };
  }).filter((g) => g.change !== null).sort((a, b) => b.change - a.change);
}

module.exports = { bucketSeries, analyzeTrend, describeTrend, rankByImprovement };
