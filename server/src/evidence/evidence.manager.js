/**
 * EVIDENCE ENGINE
 * RULE #6: Never make the LLM the source of truth.
 * RULE #22: Every answer should preserve source/provenance information.
 *
 * Every route (structured / document / hybrid) produces evidence through
 * this module in a common shape, so the response composer and the
 * "where did this come from" feature always work the same way.
 */
function buildStructuredEvidence({ datasetId, datasetName, sql, result, resultValidation, extras = {} }) {
  return {
    ...extras,
    source_type: 'database',
    dataset_id: datasetId,
    dataset_name: datasetName,
    query: sql,
    row_count: result.rowCount,
    truncated: result.truncated,
    columns: result.columns,
    // Cap embedded rows to keep evidence payloads small; full result stays available separately.
    sample_rows: result.rows.slice(0, 20),
    confidence: resultValidation.confidence,
    issues: resultValidation.issues,
    generated_at: new Date().toISOString(),
  };
}

function buildDocumentEvidence({ datasetId, datasetName, chunks }) {
  return {
    source_type: 'document',
    dataset_id: datasetId,
    dataset_name: datasetName,
    chunks: chunks.map(c => ({
      text: c.text,
      page: c.page ?? null,
      section: c.section ?? null,
      score: c.score ?? null,
    })),
    confidence: chunks.length ? avg(chunks.map(c => c.score ?? 0.5)) : 0,
    generated_at: new Date().toISOString(),
  };
}

function buildHybridEvidence(evidenceParts, incomplete = []) {
  return {
    source_type: 'hybrid',
    parts: evidenceParts,
    // Sources that were requested but produced no usable evidence, with why -
    // Rule #26 ("if the system cannot confidently answer, it must say so")
    // applies just as much to "half the sources failed" as to "no sources
    // worked at all". Silently dropping a failed source would hide that.
    incomplete,
    confidence: avg(evidenceParts.map(p => p.confidence ?? 0)),
    generated_at: new Date().toISOString(),
  };
}

function avg(nums) {
  if (!nums.length) return 0;
  return +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
}

module.exports = { buildStructuredEvidence, buildDocumentEvidence, buildHybridEvidence };
