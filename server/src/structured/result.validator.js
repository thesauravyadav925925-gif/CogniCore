/**
 * RESULT VALIDATOR
 * RULE #25: Do not silently fabricate missing data.
 * RULE #26: If the system cannot confidently answer, it must say so.
 *
 * This does NOT judge correctness of the answer - only structural sanity
 * of the execution result before it's handed to the LLM as evidence.
 */
function validateResult(result) {
  const issues = [];

  if (!result || !Array.isArray(result.rows)) {
    issues.push('Query did not return a well-formed result set.');
    return { valid: false, issues, confidence: 0 };
  }

  if (result.rows.length === 0) {
    issues.push('Query returned zero rows.');
  }

  if (result.truncated) {
    issues.push(`Result was truncated to the maximum allowed rows.`);
  }

  const confidence = computeConfidence(result, issues);

  return {
    valid: issues.length === 0 || result.rows.length > 0, // zero rows is still "valid" (a real empty answer), just flagged
    issues,
    confidence,
  };
}

function computeConfidence(result, issues) {
  let score = 1.0;
  if (result.rows.length === 0) score -= 0.3;
  if (result.truncated) score -= 0.2;
  return Math.max(0, +score.toFixed(2));
}

module.exports = { validateResult };
