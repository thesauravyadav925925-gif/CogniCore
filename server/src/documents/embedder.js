const { VectorStore } = require('./vector.store');

/**
 * EMBEDDER
 * Takes chunked text + an EmbeddingProvider, produces vectors, stores them.
 * Kept separate from chunker.js and vector.store.js so each piece has one job.
 */
async function embedAndStore(embeddingProvider, datasetId, chunks, { batchSize = 16 } = {}) {
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vectors = await embeddingProvider.embed(batch.map((c) => c.text));
    const withVectors = batch.map((c, idx) => ({ ...c, embedding: vectors[idx] }));
    VectorStore.insertChunks(datasetId, withVectors);
  }
  return { chunkCount: chunks.length };
}

module.exports = { embedAndStore };
