/**
 * DESCRIPTIVE STATISTICS + SEASONALITY (blueprint #3, #7)
 * Pure functions: percentiles, spread, shape, histogram, and autocorrelation-based seasonality.
 */
const S = require('./stats');
const { histogramBins } = require('./viz');

function describeValues(values) {
  const v = S.nums(values.map(Number));
  if (!v.length) return null;
  const sorted = S.sortedCopy(v);
  const mean = S.mean(v), sd = S.std(v), q = (p) => S.quantileSorted(sorted, p);
  const skew = sd ? v.reduce((s, x) => s + ((x - mean) / sd) ** 3, 0) / v.length : 0;
  const kurt = sd ? v.reduce((s, x) => s + ((x - mean) / sd) ** 4, 0) / v.length - 3 : 0;
  return {
    count: v.length, mean: S.round(mean, 4), median: S.round(q(0.5), 4), std: S.round(sd, 4), variance: S.round(S.variance(v), 4),
    min: sorted[0], p5: S.round(q(0.05), 4), p25: S.round(q(0.25), 4), p75: S.round(q(0.75), 4), p90: S.round(q(0.9), 4), p95: S.round(q(0.95), 4), max: sorted[sorted.length - 1],
    iqr: S.round(q(0.75) - q(0.25), 4), cv: mean ? S.round(sd / Math.abs(mean), 3) : null, skew: S.round(skew, 3), excess_kurtosis: S.round(kurt, 3),
    shape: Math.abs(skew) < 0.5 ? 'roughly symmetric' : skew > 0 ? 'right-skewed (a few very high values)' : 'left-skewed (a few very low values)',
    histogram: histogramBins(v, Math.min(10, Math.max(4, Math.ceil(Math.sqrt(v.length))))),
  };
}

/** Autocorrelation of the detrended series; returns {period, strength} or null when no repeating pattern. */
function detectSeasonality(values, { maxLag = 12, minStrength = 0.5 } = {}) {
  const v = values.map(Number).filter(Number.isFinite);
  const n = v.length;
  if (n < 8) return null;
  const reg = S.linearRegression(v.map((_, i) => i), v);
  const r = v.map((x, i) => x - (reg.intercept + reg.slope * i));
  const m = S.mean(r);
  const denom = r.reduce((s, x) => s + (x - m) ** 2, 0);
  if (!denom) return null;
  let best = null;
  for (let lag = 2; lag <= Math.min(maxLag, Math.floor(n / 2)); lag++) {
    let num = 0;
    for (let i = 0; i + lag < n; i++) num += (r[i] - m) * (r[i + lag] - m);
    const acf = num / denom;
    if (acf >= minStrength && (!best || acf > best.strength + 0.05)) best = { period: lag, strength: S.round(acf, 3) };
  }
  return best;
}

module.exports = { describeValues, detectSeasonality };
