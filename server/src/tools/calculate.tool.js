/**
 * CALCULATE TOOL
 * RULE #20: Numerical answers must originate from deterministic computation.
 * Simple, auditable aggregate math over a real column of a validated result.
 */
const METRICS = new Set(['sum', 'avg', 'min', 'max', 'count', 'median']);

function calculateMetric({ columns, rows }, { column, metric }) {
  if (!METRICS.has(metric)) {
    throw new Error(`Unsupported metric "${metric}". Supported: ${[...METRICS].join(', ')}`);
  }
  if (!columns.includes(column)) {
    throw new Error(`Column "${column}" is not present in the result: ${columns.join(', ')}`);
  }

  const values = rows.map((r) => r[column]).filter((v) => v !== null && v !== undefined && v !== '');
  const numeric = values.map(Number).filter((n) => !Number.isNaN(n));

  if (metric === 'count') {
    return { metric, column, value: values.length, sampleSize: rows.length };
  }

  if (numeric.length === 0) {
    throw new Error(`Column "${column}" has no numeric values to compute "${metric}" over.`);
  }

  let value;
  switch (metric) {
    case 'sum': value = numeric.reduce((a, b) => a + b, 0); break;
    case 'avg': value = numeric.reduce((a, b) => a + b, 0) / numeric.length; break;
    case 'min': value = Math.min(...numeric); break;
    case 'max': value = Math.max(...numeric); break;
    case 'median': {
      const sorted = [...numeric].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      value = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      break;
    }
  }

  return { metric, column, value: +value.toFixed(4), sampleSize: numeric.length };
}

module.exports = { calculateMetric, METRICS };
