/**
 * PYTHON / DATA-SCIENCE TOOL (Feature 26)
 * Runs a FIXED, whitelisted worker script (analysis.py) - it never executes code
 * from users or from the LLM. Input is JSON on stdin, hard timeout, output-size
 * cap, no shell, no network use. If Python is unavailable the same operations
 * fall back to the JavaScript implementations so the feature degrades, not fails.
 */
const { spawn } = require('child_process');
const path = require('path');
const S = require('../analytics/stats');
const A = require('../analytics/anomaly');
const F = require('../analytics/forecast');

const SCRIPT = path.join(__dirname, 'analysis.py');
const TIMEOUT_MS = 15000;
const MAX_OUT = 2 * 1024 * 1024;
const OPS = ['describe', 'correlation', 'outliers', 'regression', 'forecast'];

let pythonBin;
function candidates() { return [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean); }

function runPython(payload) {
  return new Promise((resolve, reject) => {
    const tryBin = (list) => {
      if (!list.length) return reject(Object.assign(new Error('python not available'), { code: 'NO_PYTHON' }));
      const bin = pythonBin || list[0];
      const child = spawn(bin, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: { PATH: process.env.PATH, PYTHONIOENCODING: 'utf-8' } });
      let out = '', err = '', done = false;
      const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('python tool timed out')); } }, TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d; if (out.length > MAX_OUT) { child.kill('SIGKILL'); } });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', () => { clearTimeout(timer); if (!done) { done = true; pythonBin = undefined; tryBin(list.slice(1)); } });
      child.on('close', () => {
        clearTimeout(timer);
        if (done) return; done = true;
        try { pythonBin = bin; resolve(JSON.parse(out)); } catch (_) { reject(new Error(`python tool produced invalid output${err ? `: ${err.slice(0, 200)}` : ''}`)); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    };
    tryBin(candidates());
  });
}

function jsFallback(req) {
  switch (req.op) {
    case 'describe': {
      const out = {};
      for (const [k, col] of Object.entries(req.columns || {})) {
        const xs = S.nums(col.map(Number));
        out[k] = xs.length ? { count: xs.length, mean: S.mean(xs), std: S.std(xs), min: Math.min(...xs), q1: S.quantile(xs, 0.25), median: S.median(xs), q3: S.quantile(xs, 0.75), max: Math.max(...xs) } : { count: 0 };
      }
      return out;
    }
    case 'correlation': {
      const names = Object.keys(req.columns || {}); const pairs = [];
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        const r = S.pearson(req.columns[names[i]].map(Number), req.columns[names[j]].map(Number));
        if (Number.isFinite(r)) pairs.push({ a: names[i], b: names[j], pearson: r, n: Math.min(req.columns[names[i]].length, req.columns[names[j]].length), strength: Math.abs(r) >= 0.8 ? 'very strong' : Math.abs(r) >= 0.6 ? 'strong' : Math.abs(r) >= 0.4 ? 'moderate' : Math.abs(r) >= 0.2 ? 'weak' : 'negligible', direction: r > 0 ? 'positive' : 'negative' });
      }
      return { pairs: pairs.sort((a, b) => Math.abs(b.pearson) - Math.abs(a.pearson)), note: 'Correlation does not imply causation.' };
    }
    case 'outliers': return { outliers: A.detectAnomalies(req.values.map(Number)).map((o) => ({ index: o.index, value: o.value })), method: 'iqr+mad+zscore' };
    case 'regression': return S.linearRegression(req.x.map(Number), req.y.map(Number));
    case 'forecast': return F.forecast(req.values.map(Number), { horizon: req.horizon || 3, method: 'linear_regression' });
    default: throw new Error(`unsupported op: ${req.op}`);
  }
}

async function runDataScience(req) {
  if (!req || !OPS.includes(req.op)) throw new Error(`op must be one of: ${OPS.join(', ')}`);
  try {
    const res = await runPython(req);
    if (res.ok) return { engine: 'python', result: res.result };
    throw new Error(res.error || 'python tool failed');
  } catch (err) {
    if (err.code === 'NO_PYTHON' || /timed out|invalid output/.test(err.message)) return { engine: 'javascript-fallback', result: jsFallback(req) };
    throw err;
  }
}

module.exports = { runDataScience, jsFallback, OPS };
