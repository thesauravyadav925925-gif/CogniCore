require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChartSpec } = require('../../src/tools/chart.tool');

const result = {
  columns: ['region', 'revenue'],
  rows: [
    { region: 'North', revenue: 1000 },
    { region: 'South', revenue: 2000 },
    { region: 'East', revenue: 800 },
  ],
};

test('chart.tool: bar chart reflects real row values exactly', () => {
  const spec = buildChartSpec(result, { chartType: 'bar', xField: 'region', yFields: ['revenue'] });
  assert.deepEqual(spec.labels, ['North', 'South', 'East']);
  assert.deepEqual(spec.series[0].values, [1000, 2000, 800]);
});

test('chart.tool: pie chart percentages sum correctly', () => {
  const spec = buildChartSpec(result, { chartType: 'pie', xField: 'region', yFields: ['revenue'] });
  const total = spec.series.reduce((s, x) => s + x.value, 0);
  assert.equal(total, 3800);
});

test('chart.tool: scatter chart produces one point per row', () => {
  const scatterResult = { columns: ['x', 'y'], rows: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
  const spec = buildChartSpec(scatterResult, { chartType: 'scatter', xField: 'x', yFields: ['y'] });
  assert.equal(spec.series[0].points.length, 2);
  assert.deepEqual(spec.series[0].points[0], { x: 1, y: 2 });
});

test('chart.tool: rejects unsupported chart types', () => {
  assert.throws(() => buildChartSpec(result, { chartType: 'pyramid', xField: 'region', yFields: ['revenue'] }));
});

test('chart.tool: rejects a field that does not exist in the result', () => {
  assert.throws(() => buildChartSpec(result, { chartType: 'bar', xField: 'nonexistent', yFields: ['revenue'] }));
});

test('chart.tool: line chart supports multiple y-series', () => {
  const multi = {
    columns: ['month', 'sales', 'costs'],
    rows: [{ month: 'Jan', sales: 100, costs: 60 }, { month: 'Feb', sales: 150, costs: 70 }],
  };
  const spec = buildChartSpec(multi, { chartType: 'line', xField: 'month', yFields: ['sales', 'costs'] });
  assert.equal(spec.series.length, 2);
  assert.deepEqual(spec.series[0].values, [100, 150]);
  assert.deepEqual(spec.series[1].values, [60, 70]);
});
