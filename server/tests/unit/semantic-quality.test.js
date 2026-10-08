const test = require('node:test');
const assert = require('node:assert');
const { makeTempSqlite } = require('../helpers/tempDb');
const { SQLiteAdapter } = require('../../src/ingestion/adapters/sqlite.adapter');
const { buildSemanticModel, renderSemanticPrompt } = require('../../src/semantic/semantic.builder');
const { classifyColumn } = require('../../src/semantic/semantic.classifier');
const { analyzeDataQuality } = require('../../src/quality/data.quality');

function fixture() {
  const rows = [];
  const depts = ['Cardiology', 'Orthopedics', 'Neurology'];
  for (let i = 1; i <= 40; i++) {
    rows.push([i, `Patient ${i}`, depts[i % 3], i % 7 === 0 ? 'cancelled' : (i % 5 === 0 ? 'Cancelled' : 'Completed'),
      i === 3 ? 'not-a-date' : (i % 2 ? `2026-01-${String((i % 28) + 1).padStart(2, '0')}` : `${(i % 28) + 1}/02/2026`),
      i === 4 ? null : 1000 + i * 10, i === 8 ? 'N/A' : 'ok']);
  }
  rows.push([40, 'Patient 40', 'Neurology', 'Completed', '2026-03-01', 1400, 'ok']); // duplicate id (not full dup)
  rows.push(rows[0].slice()); // exact duplicate row
  rows.push([99, 'Outlier', 'Cardiology', 'Completed', '2026-03-02', 9999999, 'ok']);
  return makeTempSqlite({ appt: { columns: [['appt_id', 'INTEGER'], ['patient_name', 'TEXT'], ['department', 'TEXT'], ['status', 'TEXT'], ['visit_date', 'TEXT'], ['fee', 'REAL'], ['note', 'TEXT']], rows } });
}

test('classifyColumn assigns generic roles without domain rules', () => {
  assert.strictEqual(classifyColumn({ name: 'joining_date', sqlType: 'TEXT', totalRows: 50, nonNull: 50, distinct: 40, samples: ['2024-01-05', '2024-02-11', '2023-12-30'] }).role, 'temporal');
  assert.strictEqual(classifyColumn({ name: 'salary', sqlType: 'REAL', totalRows: 50, nonNull: 50, distinct: 40, min: 10, max: 90 }).role, 'monetary');
  assert.strictEqual(classifyColumn({ name: 'employee_id', sqlType: 'INTEGER', totalRows: 50, nonNull: 50, distinct: 50, min: 1, max: 50 }).role, 'identifier');
  assert.strictEqual(classifyColumn({ name: 'department', sqlType: 'TEXT', totalRows: 100, nonNull: 100, distinct: 4, samples: ['A', 'B', 'C', 'D'] }).role, 'categorical');
  assert.strictEqual(classifyColumn({ name: 'contact', sqlType: 'TEXT', totalRows: 10, nonNull: 10, distinct: 10, samples: ['a@x.com', 'b@y.org', 'c@z.io'] }).pii, 'email');
});

test('semantic model measures columns and lists categorical values', async () => {
  const file = fixture();
  const adapter = new SQLiteAdapter({ datasetId: 't', location: file });
  await adapter.connect();
  const schema = await adapter.getSchema();
  const model = await buildSemanticModel({ adapter, schema, datasetType: 'sqlite' });
  const t = model.tables[0];
  const dept = t.columns.find((c) => c.name === 'department');
  assert.strictEqual(dept.role, 'categorical');
  assert.ok(dept.values.map((v) => v.value).includes('Cardiology'));
  assert.strictEqual(t.columns.find((c) => c.name === 'appt_id').role, 'identifier');
  assert.strictEqual(t.columns.find((c) => c.name === 'visit_date').role, 'temporal');
  assert.match(renderSemanticPrompt(model), /possible values/);
  await adapter.disconnect();
});

test('data quality finds duplicates, missing, bad dates, inconsistent categories, outliers', async () => {
  const file = fixture();
  const adapter = new SQLiteAdapter({ datasetId: 't', location: file });
  await adapter.connect();
  const schema = await adapter.getSchema();
  const semantic = await buildSemanticModel({ adapter, schema, datasetType: 'sqlite' });
  const q = await analyzeDataQuality({ adapter, schema, semantic, datasetType: 'sqlite' });
  const types = new Set(q.tables[0].issues.map((i) => i.type));
  for (const expected of ['missing_values', 'duplicate_rows', 'duplicate_ids', 'invalid_dates', 'mixed_date_formats', 'inconsistent_categories', 'placeholder_values', 'outliers']) {
    assert.ok(types.has(expected), `expected issue ${expected}, got ${[...types].join(',')}`);
  }
  assert.match(q.tables[0].issues.find((i) => i.type === 'missing_values').message, /missing value.*fee/);
  assert.ok(q.overallScore < 100);
  await adapter.disconnect();
});
