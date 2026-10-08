/**
 * RERANKER (blueprint #8, #11 "Reranking")
 * A local, model-free reranker: after vector search returns the top candidates, each is
 * re-scored by combining the embedding similarity with BM25-style lexical overlap and a
 * boost when the query matches the chunk's section title. This fixes the classic failure of
 * pure embeddings (a semantically "close" chunk that never mentions the asked-for term).
 */
const STOP = new Set('the a an of for in on to by and or with from at as is are was were be been what which who how why when where did does do this that these those it its their there any than then about into over after before'.split(' '));
const tok = (s) => String(s).toLowerCase().replace(/[^a-z0-9%.\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');

function lexicalScore(query, text, df, n, avgLen, k1 = 1.4, b = 0.75) {
  const q = [...new Set(tok(query).map(stem))];
  if (!q.length) return 0;
  const words = tok(text).map(stem);
  const len = words.length || 1;
  const tf = new Map();
  words.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
  let score = 0, max = 0;
  for (const term of q) {
    const idf = Math.log(1 + (n - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));
    const f = tf.get(term) || 0;
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    max += idf * (k1 + 1);
  }
  return max ? score / max : 0;
}

/** candidates: [{text, score(embedding cosine), section, page}] -> reranked [{..., rerank}] */
function rerank(query, candidates, { topK = 5, alpha = 0.6 } = {}) {
  if (!candidates.length) return [];
  const n = candidates.length;
  const docs = candidates.map((c) => new Set(tok(c.text).map(stem)));
  const df = new Map();
  docs.forEach((d) => d.forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
  const avgLen = candidates.reduce((s, c) => s + (tok(c.text).length || 1), 0) / n;
  const qTerms = new Set(tok(query).map(stem));
  const scored = candidates.map((c) => {
    const lex = lexicalScore(query, c.text, df, n, avgLen);
    const sectionHit = c.section && tok(c.section).map(stem).some((w) => qTerms.has(w)) ? 0.08 : 0;
    const dense = Math.max(0, Math.min(1, c.score ?? 0));
    const rerankScore = Math.min(1, alpha * dense + (1 - alpha) * lex + sectionHit);
    return { ...c, dense: +dense.toFixed(4), lexical: +lex.toFixed(4), rerank: +rerankScore.toFixed(4) };
  });
  return scored.sort((a, b) => b.rerank - a.rerank).slice(0, topK);
}

module.exports = { rerank, lexicalScore, tok };
