require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateMetric } = require('../../src/tools/calculate.tool');

const result = {
  columns: ['score'],
  rows: [{ score: 10 }, { score: 20 }, { score: 30 }, { score: null }, { score: '' }],
};

test('calculate.tool: sum ignores null/empty values', () => {
  const r = calculateMetric(result, { column: 'score', metric: 'sum' });
  assert.equal(r.value, 60);
  assert.equal(r.sampleSize, 3);
});

test('calculate.tool: avg is correct', () => {
  const r = calculateMetric(result, { column: 'score', metric: 'avg' });
  assert.equal(r.value, 20);
});

test('calculate.tool: min and max', () => {
  assert.equal(calculateMetric(result, { column: 'score', metric: 'min' }).value, 10);
  assert.equal(calculateMetric(result, { column: 'score', metric: 'max' }).value, 30);
});

test('calculate.tool: median for odd and even counts', () => {
  const odd = { columns: ['x'], rows: [{ x: 1 }, { x: 5 }, { x: 3 }] };
  assert.equal(calculateMetric(odd, { column: 'x', metric: 'median' }).value, 3);
  const even = { columns: ['x'], rows: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }] };
  assert.equal(calculateMetric(even, { column: 'x', metric: 'median' }).value, 2.5);
});

test('calculate.tool: count counts all non-empty values regardless of type', () => {
  const r = calculateMetric(result, { column: 'score', metric: 'count' });
  assert.equal(r.value, 3);
});

test('calculate.tool: rejects unsupported metric', () => {
  assert.throws(() => calculateMetric(result, { column: 'score', metric: 'stddev' }));
});

test('calculate.tool: rejects unknown column', () => {
  assert.throws(() => calculateMetric(result, { column: 'nonexistent', metric: 'sum' }));
});

test('calculate.tool: errors clearly on a non-numeric column for numeric metrics', () => {
  const textResult = { columns: ['name'], rows: [{ name: 'Alice' }, { name: 'Bob' }] };
  assert.throws(() => calculateMetric(textResult, { column: 'name', metric: 'avg' }));
});
