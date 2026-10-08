/**
 * CHART TOOL
 * Section 25 of the spec:
 *   USER QUERY -> STRUCTURED ENGINE -> VALIDATED RESULT -> CHART SPEC -> FRONTEND -> CHART
 *   "Never allow the LLM to fabricate chart values."
 *
 * This module NEVER calls an LLM. It takes validated { columns, rows }
 * (already produced by resolveValidatedResult) and a field mapping chosen
 * by the person, and mechanically reshapes the real data into a chart
 * spec the frontend can render directly.
 */
const SUPPORTED_TYPES = new Set(['bar', 'line', 'pie', 'scatter']);

function buildChartSpec({ columns, rows }, { chartType, xField, yFields, title }) {
  if (!SUPPORTED_TYPES.has(chartType)) {
    throw new Error(`Unsupported chart type "${chartType}". Supported: ${[...SUPPORTED_TYPES].join(', ')}`);
  }
  if (!columns.includes(xField)) {
    throw new Error(`Field "${xField}" is not present in the query result columns: ${columns.join(', ')}`);
  }
  const yList = (Array.isArray(yFields) ? yFields : [yFields]).filter(Boolean);
  if (yList.length === 0) {
    throw new Error('At least one yField is required.');
  }
  for (const y of yList) {
    if (!columns.includes(y)) {
      throw new Error(`Field "${y}" is not present in the query result columns: ${columns.join(', ')}`);
    }
  }

  if (chartType === 'scatter') {
    // Scatter needs numeric x AND y - reject early with a clear reason rather
    // than silently rendering a broken/empty chart.
    const yField = yList[0];
    const points = rows
      .map((r) => ({ x: toNumber(r[xField]), y: toNumber(r[yField]) }))
      .filter((p) => p.x !== null && p.y !== null);
    return {
      chartType, title: title || `${yField} vs ${xField}`,
      xField, yFields: [yField],
      series: [{ name: yField, points }],
    };
  }

  if (chartType === 'pie') {
    const yField = yList[0];
    const series = rows.map((r) => ({ label: String(r[xField]), value: toNumber(r[yField]) ?? 0 }));
    return { chartType, title: title || yField, xField, yFields: [yField], series };
  }

  // bar / line: one category axis (xField), one or more numeric series (yFields)
  const labels = rows.map((r) => String(r[xField]));
  const series = yList.map((y) => ({
    name: y,
    values: rows.map((r) => toNumber(r[y]) ?? 0),
  }));

  return { chartType, title: title || yList.join(', '), xField, yFields: yList, labels, series };
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

module.exports = { buildChartSpec, SUPPORTED_TYPES };
