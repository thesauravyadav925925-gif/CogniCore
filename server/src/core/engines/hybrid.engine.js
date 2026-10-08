const { runStructuredQuery } = require('./structured.engine');
const { runDocumentQuery } = require('./document.engine');
const { buildHybridEvidence } = require('../../evidence/evidence.manager');

/**
 * HYBRID ENGINE
 * Section 16 of the spec:
 *   "According to the attendance policy, which students are below the
 *    minimum requirement?"
 *
 *           QUESTION
 *              │
 *            HYBRID
 *           /      \
 *          ▼        ▼
 *      DATABASE   POLICY PDF
 *          │          │
 *         SQL        RAG
 *          │          │
 *          └────┬─────┘
 *               ▼
 *         EVIDENCE MERGER
 *
 * Both sub-engines run independently and in parallel - neither knows the
 * other exists. This module's only job is to run both and merge whatever
 * evidence comes back. If one side fails (e.g. no relevant document
 * passages, or SQL generation declines), the other side's evidence still
 * reaches the answer composer rather than the whole hybrid query failing.
 */
const polFor = (policy, id) => (typeof policy === 'function' ? policy(id) : policy);

async function runHybridQuery({ question, structuredDataset, documentDataset, structuredDatasets = null, documentDatasets = null, llmProvider, embeddingProvider, conversationContext, policy = null, knowledgeText = '' }) {
  const structs = Array.isArray(structuredDatasets) && structuredDatasets.length ? structuredDatasets : [structuredDataset];
  const docs = Array.isArray(documentDatasets) ? documentDatasets : (documentDataset ? [documentDataset] : []);

  const [structuredResults, documentResults] = await Promise.all([
    Promise.all(structs.map((d) => runStructuredQuery({ question, dataset: d, llmProvider, conversationContext, policy: polFor(policy, d.dataset_id), knowledgeText }))),
    Promise.all(docs.map((d) => runDocumentQuery({ question, dataset: d, embeddingProvider, conversationContext }))),
  ]);

  const evidenceParts = [];
  const incomplete = [];

  structs.forEach((dataset, i) => {
    const r = structuredResults[i];
    if (r.evidence) evidenceParts.push(r.evidence);
    else incomplete.push({ source_type: 'database', dataset_name: dataset.name, reason: r.answer || 'No usable result from the structured dataset.' });
  });
  docs.forEach((dataset, i) => {
    const r = documentResults[i];
    if (r.evidence) evidenceParts.push(r.evidence);
    else incomplete.push({ source_type: 'document', dataset_name: dataset.name, reason: r.answer || 'No usable result from the document.' });
  });

  if (evidenceParts.length === 0) {
    const fallbackAnswer = structuredResults.map((r) => r.answer).concat(documentResults.map((r) => r.answer)).find(Boolean) ||
      'Neither the structured dataset nor the document produced enough evidence to answer this question.';
    return { routeType: 'HYBRID', answer: fallbackAnswer, evidence: null, lowConfidence: true };
  }

  const evidence = buildHybridEvidence(evidenceParts, incomplete);
  const denied = structuredResults.find((r) => r.denied);
  return {
    routeType: 'HYBRID',
    evidence,
    generatedSql: structuredResults.find((r) => r.generatedSql)?.generatedSql,
    lowConfidence: incomplete.length > 0,
    sources: { structured: structs.length, documents: docs.length },
    ...(denied ? { deniedNotice: denied.deniedReason } : {}),
  };
}

module.exports = { runHybridQuery };
