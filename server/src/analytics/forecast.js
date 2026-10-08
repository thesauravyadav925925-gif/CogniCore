/**
 * FORECASTING (Feature 27)
 * Methods: moving average, linear regression, Holt's linear exponential smoothing,
 * Holt-Winters additive (when a seasonal period is available). The best method is
 * picked by a rolling-origin backtest (MAPE). Every result is explicitly labelled
 * `type: 'forecast'` and carries its method, error estimate and an interval, so
 * projections are never presented as historical fact.
 */
const S = require('./stats');

function fcMovingAverage(values, h, window = 3) {
  const w = Math.min(window, values.length);
  const base = S.mean(values.slice(-w));
  return Array(h).fill(base);
}
function fcLinear(values, h) {
  const xs = values.map((_, i) => i);
  const r = S.linearRegression(xs, values);
  return Array.from({ length: h }, (_, k) => r.intercept + r.slope * (values.length + k));
}
function fcHolt(values, h, alpha = 0.5, beta = 0.3) {
  if (values.length < 2) return Array(h).fill(values[0] ?? 0);
  let level = values[0], trend = values[1] - values[0];
  for (let i = 1; i < values.length; i++) {
    const prev = level;
    level = alpha * values[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  return Array.from({ length: h }, (_, k) => level + (k + 1) * trend);
}
function fcSeasonalNaiveTrend(values, h, m) {
  // Additive seasonal decomposition around a linear trend (simple, robust for short series).
  const xs = values.map((_, i) => i);
  const reg = S.linearRegression(xs, values);
  const detr = values.map((v, i) => v - (reg.intercept + reg.slope * i));
  const seas = Array.from({ length: m }, (_, s) => S.mean(detr.filter((_, i) => i % m === s)));
  const sMean = S.mean(seas);
  return Array.from({ length: h }, (_, k) => reg.intercept + reg.slope * (values.length + k) + (seas[(values.length + k) % m] - sMean));
}

const METHODS = {
  moving_average: (v, h) => fcMovingAverage(v, h),
  linear_regression: fcLinear,
  holt: (v, h) => fcHolt(v, h),
};

function backtest(values, method, m) {
  const start = Math.max(4, Math.floor(values.length * 0.6));
  const actual = [], pred = [];
  for (let t = start; t < values.length; t++) {
    const train = values.slice(0, t);
    const f = method === 'seasonal' ? fcSeasonalNaiveTrend(train, 1, m) : METHODS[method](train, 1);
    actual.push(values[t]); pred.push(f[0]);
  }
  if (!actual.length) return { mape: null, rmse: null, n: 0 };
  const rmse = Math.sqrt(S.mean(actual.map((a, i) => (a - pred[i]) ** 2)));
  return { mape: S.mape(actual, pred), rmse, n: actual.length };
}

function forecast(values, { horizon = 3, seasonLength = null, method = 'auto' } = {}) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 4) return { type: 'forecast', error: 'At least 4 historical periods are required to forecast.', n: clean.length };
  const candidates = Object.keys(METHODS);
  if (seasonLength && clean.length >= seasonLength * 2) candidates.push('seasonal');
  let chosen = method;
  const scores = {};
  if (method === 'auto') {
    for (const c of candidates) scores[c] = backtest(clean, c, seasonLength);
    chosen = candidates.filter((c) => scores[c].rmse !== null).sort((a, b) => scores[a].rmse - scores[b].rmse)[0] || 'linear_regression';
  }
  const pred = chosen === 'seasonal' ? fcSeasonalNaiveTrend(clean, horizon, seasonLength) : METHODS[chosen](clean, horizon);
  const bt = scores[chosen] || backtest(clean, chosen, seasonLength);
  const resid = bt.rmse ?? S.std(clean);
  return {
    type: 'forecast',
    method: chosen,
    horizon,
    predictions: pred.map((p, k) => ({
      step: k + 1, value: +p.toFixed(4),
      lower: +(p - 1.96 * resid * Math.sqrt(k + 1)).toFixed(4), upper: +(p + 1.96 * resid * Math.sqrt(k + 1)).toFixed(4),
    })),
    backtest: { mape: S.round(bt.mape, 2), rmse: S.round(bt.rmse, 4), testedPeriods: bt.n },
    comparedMethods: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, S.round(v.rmse, 4)])),
    basedOnPeriods: clean.length,
    disclaimer: 'Forecast values are statistical projections from historical data, not recorded facts.',
  };
}

/** Generates next-period labels for month/year/quarter/day labels (best effort). */
function nextLabels(lastLabel, grain, n) {
  const out = [];
  let m;
  if (grain === 'month' && (m = /^(\d{4})-(\d{2})$/.exec(lastLabel))) {
    let y = +m[1], mo = +m[2];
    for (let i = 0; i < n; i++) { mo++; if (mo > 12) { mo = 1; y++; } out.push(`${y}-${String(mo).padStart(2, '0')}`); }
  } else if (grain === 'year' && /^\d{4}$/.test(lastLabel)) {
    for (let i = 1; i <= n; i++) out.push(String(+lastLabel + i));
  } else if (grain === 'quarter' && (m = /^(\d{4})-Q(\d)$/.exec(lastLabel))) {
    let y = +m[1], q = +m[2];
    for (let i = 0; i < n; i++) { q++; if (q > 4) { q = 1; y++; } out.push(`${y}-Q${q}`); }
  } else if ((grain === 'day' || grain === 'week') && /^\d{4}-\d{2}-\d{2}$/.test(lastLabel)) {
    const step = grain === 'week' ? 7 : 1;
    const d = new Date(lastLabel + 'T00:00:00Z');
    for (let i = 0; i < n; i++) { d.setUTCDate(d.getUTCDate() + step); out.push(d.toISOString().slice(0, 10)); }
  } else for (let i = 1; i <= n; i++) out.push(`+${i}`);
  return out;
}

module.exports = { forecast, nextLabels, fcHolt, fcLinear };
