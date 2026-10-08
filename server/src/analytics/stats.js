/**
 * Deterministic statistics primitives. Pure functions over number arrays.
 * Rule #20: every number CogniCore states about data comes from code like this
 * or from an executed query - never from the LLM.
 */
const nums = (a) => a.filter((v) => typeof v === 'number' && Number.isFinite(v));
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => (a.length ? sum(a) / a.length : NaN);

function variance(a, sample = true) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return sum(a.map((v) => (v - m) ** 2)) / (a.length - (sample ? 1 : 0));
}
const std = (a, sample = true) => Math.sqrt(variance(a, sample));

function quantileSorted(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const sortedCopy = (a) => [...a].sort((x, y) => x - y);
const median = (a) => quantileSorted(sortedCopy(a), 0.5);
const quantile = (a, q) => quantileSorted(sortedCopy(a), q);

function iqrBounds(a, k = 1.5) {
  const s = sortedCopy(a);
  const q1 = quantileSorted(s, 0.25), q3 = quantileSorted(s, 0.75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, lower: q1 - k * iqr, upper: q3 + k * iqr };
}

function mad(a) {
  const med = median(a);
  return median(a.map((v) => Math.abs(v - med)));
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return NaN;
  const x = xs.slice(0, n), y = ys.slice(0, n);
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? NaN : num / den;
}

function linearRegression(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0, n };
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

function movingAverage(values, window) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < window) { out.push(null); continue; }
    out.push(mean(values.slice(i + 1 - window, i + 1)));
  }
  return out;
}

function cumulative(values) {
  let run = 0;
  return values.map((v) => (run += v));
}

/** Percentage change from a to b; null when a is 0/invalid (never fabricate a number). */
function pctChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

const round = (v, d = 2) => (Number.isFinite(v) ? +v.toFixed(d) : null);

function mape(actual, predicted) {
  const pairs = actual.map((a, i) => [a, predicted[i]]).filter(([a, p]) => Number.isFinite(a) && Number.isFinite(p) && a !== 0);
  if (!pairs.length) return null;
  return mean(pairs.map(([a, p]) => Math.abs((a - p) / a))) * 100;
}

module.exports = {
  nums, sum, mean, variance, std, median, quantile, quantileSorted, sortedCopy, iqrBounds, mad,
  pearson, linearRegression, movingAverage, cumulative, pctChange, round, mape,
};
