const { VectorStore } = require('./vector.store');
const { rerank } = require('./reranker');
const { neutralizeInjection } = require('../guardrails/input.guard');
const config = require('../config/env');

/**
 * RETRIEVER (blueprint #8)
 * Question -> embed -> dense top-N -> local reranker (dense + lexical + section boost) -> top-K.
 * Retrieved text is UNTRUSTED DATA (blueprint #18): instruction-like lines are neutralised here,
 * before the text can ever reach a prompt.
 */
async function retrieveRelevantChunks(embeddingProvider, datasetId, question, { topK } = {}) {
  const k = topK || config.documents.retrievalTopK;
  const [queryEmbedding] = await embeddingProvider.embed([question]);
  const dense = VectorStore.search(datasetId, queryEmbedding, Math.max(k * 3, 12));
  const candidates = dense.map((r) => ({ text: r.text, page: r.pageNumber, section: r.section ?? null, score: r.score }));
  return rerank(question, candidates, { topK: k }).map((r) => {
    const safe = neutralizeInjection(r.text);
    return { text: safe.text, page: r.page, section: r.section, score: +r.rerank.toFixed(4), dense: r.dense, lexical: r.lexical, sanitized: safe.removed > 0 || undefined };
  });
}

module.exports = { retrieveRelevantChunks };
