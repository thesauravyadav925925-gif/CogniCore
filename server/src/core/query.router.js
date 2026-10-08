const { planQuery } = require('./query.planner');
const { runStructuredQuery } = require('./engines/structured.engine');
const { runDocumentQuery } = require('./engines/document.engine');
const { runHybridQuery } = require('./engines/hybrid.engine');
const { runAnalysisQuery } = require('./engines/analysis.engine');

/**
 * QUERY ROUTER
 * Section 15 of the spec. Structured, Document, and Hybrid are all fully
 * implemented as of Phase 4. Analysis (multi-step) mode is an explicit
 * opt-in (`analysisMode: true`) for open-ended business-analysis
 * questions on a single structured dataset - it is deliberately NOT
 * auto-detected from question phrasing, matching this project's existing
 * pattern of explicit user control over anything that costs meaningfully
 * more (multiple LLM calls + multiple query executions) than a normal
 * question, the same way hybrid queries require explicitly linking
 * datasets rather than being guessed at.
 */
const polFor = (policy, id) => (typeof policy === 'function' ? policy(id) : policy);

async function routeQuery({ question, datasetIds, session, llmProvider, embeddingProvider, conversationContext, analysisMode = false, policy = null, knowledgeText = '', followUp = null }) {
  const plan = planQuery({
    question,
    datasetIds,
    sessionActiveDatasetId: session?.active_dataset_id,
  });

  if (analysisMode && plan.routeType === 'STRUCTURED') {
    return runAnalysisQuery({ question, dataset: plan.dataset, llmProvider, conversationContext, policy: polFor(policy, plan.dataset.dataset_id), knowledgeText });
  }

  switch (plan.routeType) {
    case 'STRUCTURED':
      return runStructuredQuery({ question, dataset: plan.dataset, llmProvider, conversationContext, policy: polFor(policy, plan.dataset.dataset_id), knowledgeText, followUp });

    case 'DOCUMENT':
      return runDocumentQuery({ question, dataset: plan.dataset, embeddingProvider, conversationContext });

    case 'HYBRID':
      return runHybridQuery({
        question,
        structuredDataset: plan.structuredDataset,
        documentDataset: plan.documentDataset,
        structuredDatasets: plan.structuredDatasets,
        documentDatasets: plan.documentDatasets,
        llmProvider,
        embeddingProvider,
        conversationContext,
        policy,
        knowledgeText,
      });

    case 'UNKNOWN':
    default:
      return {
        routeType: 'UNKNOWN',
        answer: plan.reason || 'I could not determine how to answer this question with the available data.',
        evidence: null,
        lowConfidence: true,
      };
  }
}

module.exports = { routeQuery };
