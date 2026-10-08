/**
 * WHAT-IF / SCENARIO ENGINE (blueprint #22)
 * "What happens if attendance improves by 10%?" - take the REAL current value, apply the
 * hypothetical change, recompute, and compare. The output is always labelled SIMULATED:
 * it is arithmetic on recorded data, never a prediction or a recorded fact.
 */
const S = require('./stats');

const UP = /\b(improv\w*|increas\w*|rise|rises|rising|grow\w*|boost\w*|rais\w*|goes? up|higher|up by|gain\w*|expand\w*|jump\w*)\b/i;
const DOWN = /\b(reduc\w*|decreas\w*|drop\w*|fall\w*|falls|cut\w*|lower\w*|declin\w*|goes? down|down by|shrink\w*|saves?|slash\w*|dip\w*)\b/i;

function parseScenario(question) {
  const pm = String(question).match(/(\d+(?:\.\d+)?)\s*(%|percent|per cent)/i);
  if (!pm) return null;
  const pct = parseFloat(pm[1]);
  const up = UP.test(question), down = DOWN.test(question);
  if (!up && !down) return null;
  // the direction word closest before the number wins when both appear
  let direction = up && !down ? 'up' : down && !up ? 'down' : null;
  if (!direction) {
    const before = question.slice(0, pm.index);
    const lastUp = Math.max(...[...before.matchAll(new RegExp(UP.source, 'gi'))].map((m) => m.index), -1);
    const lastDown = Math.max(...[...before.matchAll(new RegExp(DOWN.source, 'gi'))].map((m) => m.index), -1);
    direction = lastDown > lastUp ? 'down' : 'up';
  }
  return { pct, direction, factor: direction === 'up' ? 1 + pct / 100 : 1 - pct / 100 };
}

/**
 * baseline: { total, avg, n } over the whole measure; slice: same over the affected subset (or null = everything)
 * mode: 'sum' | 'avg'
 */
function applyScenario({ baseline, slice = null, mode, factor, clampMax = null }) {
  const affected = slice || baseline;
  const newAffectedTotal = affected.total * factor;
  const rest = baseline.total - affected.total;
  let scenarioTotal = rest + newAffectedTotal;
  let scenario = mode === 'avg' ? (baseline.n ? scenarioTotal / baseline.n : null) : scenarioTotal;
  const base = mode === 'avg' ? baseline.avg : baseline.total;
  let clamped = false;
  if (clampMax !== null && scenario !== null && scenario > clampMax) { scenario = clampMax; clamped = true; }
  return {
    baseline: S.round(base, 4), scenario: S.round(scenario, 4), change: S.round(scenario - base, 4),
    change_pct: S.round(S.pctChange(base, scenario), 2), clamped,
  };
}

module.exports = { parseScenario, applyScenario };
