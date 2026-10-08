const { DatasetRegistry } = require('../ingestion/dataset.registry');

const STRUCTURED_TYPES = new Set(['sqlite', 'postgres', 'mysql', 'csv', 'xlsx', 'json']);
const DOCUMENT_TYPES = new Set(['pdf', 'docx', 'txt', 'pptx']);

/**
 * QUERY PLANNER
 * Decides WHICH dataset(s) a question should run against and what kind
 * of route is needed, based on dataset TYPE (structural fact), not any
 * assumption about the question's domain.
 *
 * Accepts one or more dataset IDs. Section 16 of the spec ("Which
 * employees don't meet the minimum leave requirement according to the
 * policy?") requires a structured dataset AND a document dataset in the
 * same request - that's what triggers HYBRID. A single dataset ID keeps
 * working exactly as it did in Phase 1 (backward compatible).
 */
function planQuery({ question, datasetIds, sessionActiveDatasetId }) {
  const ids = normalizeIds(datasetIds, sessionActiveDatasetId);

  if (ids.length === 0) {
    return { routeType: 'UNKNOWN', reason: 'No dataset selected. Upload or select a dataset first.' };
  }

  const resolved = [];
  for (const id of ids) {
    const dataset = DatasetRegistry.get(id);
    if (!dataset) {
      return { routeType: 'UNKNOWN', reason: `Dataset "${id}" not found.` };
    }
    if (dataset.status !== 'ready') {
      return { routeType: 'UNKNOWN', reason: `Dataset "${dataset.name}" is not ready (status: ${dataset.status}).`, dataset };
    }
    resolved.push(dataset);
  }

  const structuredDatasets = resolved.filter((d) => STRUCTURED_TYPES.has(d.type));
  const documentDatasets = resolved.filter((d) => DOCUMENT_TYPES.has(d.type));
  const unrecognized = resolved.filter((d) => !STRUCTURED_TYPES.has(d.type) && !DOCUMENT_TYPES.has(d.type));

  if (unrecognized.length > 0) {
    return { routeType: 'UNKNOWN', reason: `Unrecognized dataset type "${unrecognized[0].type}".`, dataset: unrecognized[0] };
  }

  if (structuredDatasets.length > 0 && documentDatasets.length > 0) {
    // HYBRID supports N structured + M document datasets (database + Excel + PDF + API ...).
    return {
      routeType: 'HYBRID',
      structuredDataset: structuredDatasets[0],
      documentDataset: documentDatasets[0],
      // Multi-source reasoning (Features 32/33): every selected structured and
      // document dataset takes part; the first of each is kept for compatibility.
      structuredDatasets,
      documentDatasets,
    };
  }

  if (structuredDatasets.length > 1) {
    // Several structured sources at once (database + Excel + API ...): ask each one and
    // combine the evidence so cross-source questions are answered from all of them.
    return { routeType: 'HYBRID', structuredDataset: structuredDatasets[0], documentDataset: null, structuredDatasets, documentDatasets: [] };
  }

  if (structuredDatasets.length > 0) {
    return { routeType: 'STRUCTURED', dataset: structuredDatasets[0] };
  }
  if (documentDatasets.length > 0) {
    return { routeType: 'DOCUMENT', dataset: documentDatasets[0] };
  }

  return { routeType: 'UNKNOWN', reason: 'Could not determine a route for the selected dataset(s).' };
}

function normalizeIds(datasetIds, sessionActiveDatasetId) {
  if (Array.isArray(datasetIds) && datasetIds.length > 0) {
    return [...new Set(datasetIds.filter(Boolean))];
  }
  if (typeof datasetIds === 'string' && datasetIds) {
    return [datasetIds];
  }
  if (sessionActiveDatasetId) {
    return [sessionActiveDatasetId];
  }
  return [];
}

module.exports = { planQuery, STRUCTURED_TYPES, DOCUMENT_TYPES };
