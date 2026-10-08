function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Best fuzzy match of `word` among `candidates` (strings). Returns candidate or null. Unique best only. */
function closestMatch(word, candidates, { maxDistance } = {}) {
  const target = norm(word);
  if (!target) return null;
  const limit = maxDistance ?? Math.max(1, Math.floor(target.length / 4));
  let best = null, bestD = Infinity, tie = false;
  for (const c of candidates) {
    const d = levenshtein(target, norm(c));
    if (d < bestD) { best = c; bestD = d; tie = false; } else if (d === bestD) tie = true;
  }
  return best !== null && bestD <= limit && !tie ? best : null;
}

module.exports = { levenshtein, closestMatch, norm };
