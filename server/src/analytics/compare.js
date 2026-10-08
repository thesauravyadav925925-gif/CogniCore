/**
 * COMPARATIVE ANALYSIS (Feature 12) - numbers first, explanation second.
 * All figures are computed deterministically; the text is templated from them
 * (the LLM may rephrase it later but never supplies numbers).
 */
const S = require('./stats');

const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : +n.toFixed(2)) : 'n/a');

/** a, b: { label, value } */
function compareTwo(a, b, { measure = 'value' } = {}) {
  const diff = b.value - a.value;
  const pct = S.pctChange(a.value, b.value);
  const ratio = a.value !== 0 ? b.value / a.value : null;
  const higher = a.value === b.value ? null : (a.value > b.value ? a : b);
  const lower = higher ? (higher === a ? b : a) : null;
  const sentence = higher
    ? `${higher.label} is higher than ${lower.label} by ${fmt(Math.abs(diff))}${pct !== null ? ` (${fmt(Math.abs(S.pctChange(lower.value, higher.value)))}% ${higher === a ? 'more' : 'more'})` : ''} on ${measure}: ${higher.label} = ${fmt(higher.value)}, ${lower.label} = ${fmt(lower.value)}.`
    : `${a.label} and ${b.label} are equal on ${measure} (${fmt(a.value)}).`;
  return { a, b, difference: S.round(diff, 4), percentChange: S.round(pct, 2), ratio: S.round(ratio, 4), leader: higher?.label ?? null, sentence };
}

/** rows: [{label, value}] (e.g. per-branch) -> ranking, spread, leader/laggard and share of total. */
function compareGroups(rows, { measure = 'value' } = {}) {
  const items = rows.filter((r) => Number.isFinite(r.value)).sort((x, y) => y.value - x.value);
  if (items.length < 2) return { items, sentence: 'At least two groups are needed to compare.' };
  const total = S.sum(items.map((i) => i.value));
  const ranked = items.map((it, i) => ({ rank: i + 1, ...it, shareOfTotalPct: total ? S.round((it.value / total) * 100, 2) : null }));
  const top = ranked[0], bottom = ranked[ranked.length - 1];
  const gapPct = S.pctChange(bottom.value, top.value);
  const sentence = `${top.label} leads on ${measure} (${fmt(top.value)}), ${bottom.label} is lowest (${fmt(bottom.value)}); the gap is ${fmt(top.value - bottom.value)}${gapPct !== null ? ` (${fmt(gapPct)}%)` : ''}. ${top.label} accounts for ${top.shareOfTotalPct}% of the total.`;
  return { items: ranked, total: S.round(total, 4), spread: S.round(top.value - bottom.value, 4), leader: top.label, laggard: bottom.label, sentence };
}

module.exports = { compareTwo, compareGroups };
