const { retrieveRelevantChunks } = require('../../documents/retriever');
const { buildDocumentEvidence } = require('../../evidence/evidence.manager');

/**
 * DOCUMENT ENGINE
 * Section 13 of the spec, now fully implemented:
 *   Question -> embed -> retrieve top-K relevant chunks -> evidence
 *
 * Same discipline as the structured engine: this module does NOT generate
 * the natural-language answer. It only retrieves grounded evidence; the
 * core engine hands that evidence to answer.composer.js, which is the
 * ONLY place the LLM explains anything (Rule #6, #21).
 */
async function runDocumentQuery({ question, dataset, embeddingProvider, conversationContext }) {
  let chunks;
  try {
    chunks = await retrieveRelevantChunks(embeddingProvider, dataset.dataset_id, question);
  } catch (err) {
    return {
      routeType: 'DOCUMENT',
      answer: `I couldn't search this document: ${err.message}`,
      evidence: null,
      lowConfidence: true,
    };
  }

  if (!chunks.length) {
    return {
      routeType: 'DOCUMENT',
      answer: `I couldn't find anything relevant to that question in "${dataset.name}".`,
      evidence: null,
      lowConfidence: true,
    };
  }

  const evidence = buildDocumentEvidence({
    datasetId: dataset.dataset_id,
    datasetName: dataset.name,
    chunks,
  });

  return { routeType: 'DOCUMENT', evidence };
}

module.exports = { runDocumentQuery };
