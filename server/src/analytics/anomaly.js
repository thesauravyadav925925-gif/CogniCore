/**
 * ANOMALY DETECTION (Feature 10)
 * Statistical outliers (IQR, z-score, robust MAD z-score), time-series anomalies
 * (deviation from a rolling baseline) and a compact Isolation Forest for
 * multi-column records. Pure functions over arrays; deterministic (seeded RNG).
 */
const S = require('./stats');

function detectIqr(values, { k = 1.5 } = {}) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v));
  if (idx.length < 4) return [];
  const b = S.iqrBounds(idx.map(([v]) => v), k);
  if (b.iqr === 0) return [];
  return idx.filter(([v]) => v < b.lower || v > b.upper).map(([v, i]) => ({ index: i, value: v, method: 'iqr', score: +(Math.abs(v < b.lower ? b.lower - v : v - b.upper) / b.iqr).toFixed(2), bounds: { lower: +b.lower.toFixed(4), upper: +b.upper.toFixed(4) } }));
}

function detectZScore(values, { threshold = 3 } = {}) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v));
  if (idx.length < 5) return [];
  const m = S.mean(idx.map(([v]) => v)), sd = S.std(idx.map(([v]) => v));
  if (!sd) return [];
  return idx.map(([v, i]) => ({ index: i, value: v, z: (v - m) / sd })).filter((o) => Math.abs(o.z) >= threshold)
    .map((o) => ({ index: o.index, value: o.value, method: 'zscore', score: +Math.abs(o.z).toFixed(2) }));
}

/** Modified z-score (Iglewicz & Hoaglin) - robust to the outliers it is looking for. */
function detectMad(values, { threshold = 3.5 } = {}) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v));
  if (idx.length < 5) return [];
  const vals = idx.map(([v]) => v);
  const med = S.median(vals), m = S.mad(vals);
  if (!m) return [];
  return idx.map(([v, i]) => ({ index: i, value: v, mz: (0.6745 * (v - med)) / m })).filter((o) => Math.abs(o.mz) >= threshold)
    .map((o) => ({ index: o.index, value: o.value, method: 'mad', score: +Math.abs(o.mz).toFixed(2) }));
}

/** Time-series: compare each point with the mean/std of the preceding window. */
function detectTimeSeries(values, { window = 6, threshold = 3 } = {}) {
  const out = [];
  for (let i = window; i < values.length; i++) {
    const w = values.slice(i - window, i).filter(Number.isFinite);
    if (w.length < Math.max(3, window - 1) || !Number.isFinite(values[i])) continue;
    const m = S.mean(w);
    const sd = Math.max(S.std(w), Math.abs(m) * 0.02, 1e-9);
    const z = (values[i] - m) / sd;
    if (Math.abs(z) >= threshold) out.push({ index: i, value: values[i], method: 'timeseries', score: +Math.abs(z).toFixed(2), expected: +m.toFixed(4), direction: z > 0 ? 'spike' : 'drop' });
  }
  return out;
}

// ---- Isolation Forest ----
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const cFactor = (n) => (n <= 1 ? 0 : n === 2 ? 1 : 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n);

function buildTree(data, depth, maxDepth, rand) {
  if (depth >= maxDepth || data.length <= 1) return { size: data.length };
  const dims = data[0].length;
  const q = Math.floor(rand() * dims);
  const col = data.map((r) => r[q]);
  const lo = Math.min(...col), hi = Math.max(...col);
  if (lo === hi) return { size: data.length };
  const split = lo + rand() * (hi - lo);
  return {
    q, split,
    left: buildTree(data.filter((r) => r[q] < split), depth + 1, maxDepth, rand),
    right: buildTree(data.filter((r) => r[q] >= split), depth + 1, maxDepth, rand),
  };
}
function pathLength(x, node, depth = 0) {
  if (node.size !== undefined) return depth + cFactor(node.size);
  return pathLength(x, x[node.q] < node.split ? node.left : node.right, depth + 1);
}

/** rows: array of numeric arrays. Returns [{index, score}] with score in (0,1); >0.6 is suspicious. */
function isolationForest(rows, { trees = 100, sample = 256, seed = 42, contamination = 0.05 } = {}) {
  const clean = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.every(Number.isFinite));
  if (clean.length < 20) return { scores: [], anomalies: [] };
  const rand = rng(seed);
  const psi = Math.min(sample, clean.length);
  const maxDepth = Math.ceil(Math.log2(psi));
  const forest = [];
  for (let t = 0; t < trees; t++) {
    const subset = [];
    for (let k = 0; k < psi; k++) subset.push(clean[Math.floor(rand() * clean.length)].r);
    forest.push(buildTree(subset, 0, maxDepth, rand));
  }
  const norm = cFactor(psi);
  const scores = clean.map(({ r, i }) => ({ index: i, score: +(2 ** (-S.mean(forest.map((t) => pathLength(r, t))) / norm)).toFixed(4) }));
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const cut = Math.max(1, Math.floor(clean.length * contamination));
  const threshold = Math.max(0.6, sorted[cut - 1].score);
  return { scores, anomalies: sorted.filter((s) => s.score >= threshold).slice(0, cut) };
}

/** Choose methods sensibly and merge: a value flagged by >=2 methods is "high" confidence. */
function detectAnomalies(values, { ordered = false } = {}) {
  const found = new Map();
  const add = (list) => list.forEach((a) => {
    const cur = found.get(a.index) || { index: a.index, value: a.value, methods: [], score: 0 };
    cur.methods.push(a.method); cur.score = Math.max(cur.score, a.score);
    if (a.expected !== undefined) { cur.expected = a.expected; cur.direction = a.direction; }
    found.set(a.index, cur);
  });
  add(detectIqr(values)); add(detectMad(values)); add(detectZScore(values));
  if (ordered) add(detectTimeSeries(values));
  return [...found.values()].map((a) => ({ ...a, confidence: a.methods.length >= 2 ? 'high' : 'medium' })).sort((x, y) => y.score - x.score);
}

module.exports = { detectIqr, detectZScore, detectMad, detectTimeSeries, isolationForest, detectAnomalies };
