require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { analyzeComplexity } = require('../../src/structured/sql.complexity');
const { validateSql } = require('../../src/structured/sql.validator');
const { explainConfidence } = require('../../src/evidence/confidence');
const { describeCalculation, columnsUsed } = require('../../src/evidence/provenance');
const { qualityWarningsFor } = require('../../src/quality/answer.warnings');
const { ingestFile } = require('../../src/ingestion/ingestion.pipeline');
const { createAdapter } = require('../../src/ingestion/adapters');
const { analyzeDataQuality } = require('../../src/quality/data.quality');
const { makeTempSqlite } = require('../helpers/tempDb');
const { SQLiteAdapter } = require('../../src/ingestion/adapters/sqlite.adapter');
const { buildSemanticModel } = require('../../src/semantic/semantic.builder');

const schema = { tables: [
  { name: 'orders', rowCount: 100000, columns: [{ name: 'order_id' }, { name: 'customer_id' }, { name: 'amount' }] },
  { name: 'customers', rowCount: 50000, columns: [{ name: 'customer_id' }, { name: 'name' }] },
  { name: 'items', rowCount: 400000, columns: [{ name: 'order_id' }, { name: 'sku' }] },
] };

test('complexity gate: sane queries pass, cartesian products and deep nesting are refused', () => {
  const ok = analyzeComplexity('SELECT c.name, SUM(o.amount) FROM orders o JOIN customers c ON o.customer_id = c.customer_id GROUP BY c.name', schema);
  assert.equal(ok.ok, true);
  assert.equal(ok.level, 'low');
  const cross = analyzeComplexity('SELECT * FROM orders CROSS JOIN customers', schema);
  assert.equal(cross.ok, false);
  assert.match(cross.reasons.join(' '), /cartesian/);
  const comma = analyzeComplexity('SELECT o.order_id FROM orders o, customers c, items i', schema);
  assert.equal(comma.ok, false);
  const commaKeyed = analyzeComplexity('SELECT o.order_id FROM orders o, customers c WHERE o.customer_id = c.customer_id', schema);
  assert.equal(commaKeyed.ok, true);
  const deep = analyzeComplexity('SELECT 1 FROM orders WHERE amount IN (SELECT amount FROM orders WHERE amount IN (SELECT amount FROM orders WHERE amount IN (SELECT amount FROM orders WHERE amount IN (SELECT amount FROM orders WHERE amount > (SELECT MAX(amount) FROM orders)))))', schema);
  assert.equal(deep.ok, false);
  assert.match(deep.reasons.join(' '), /nested/);
  assert.throws(() => validateSql('SELECT * FROM orders CROSS JOIN customers', schema, 'sqlite'), /too expensive/);
  assert.doesNotThrow(() => validateSql('SELECT COUNT(*) FROM orders', schema, 'sqlite'));
});

test('confidence is explained, component-based and only as strong as its weakest link', () => {
  const clean = explainConfidence({ rowCount: 10 });
  assert.equal(clean.level, 'High');
  assert.equal(clean.score, 1);
  const repaired = explainConfidence({ rowCount: 10, repairs: [{ type: 'column_name', corrections: [{ from: 'salaryy', to: 'salary' }] }], recoveryAttempts: 1 });
  assert.ok(repaired.score < clean.score);
  assert.match(repaired.components.schema.reason, /salaryy→salary/);
  assert.match(repaired.components.query.reason, /automatic correction/);
  const sem = { tables: [{ name: 't', columns: [{ name: 'fee', stats: { total: 100, missing: 40 } }] }] };
  const incomplete = explainConfidence({ rowCount: 10, columns: ['t.fee'], semantic: sem });
  assert.notEqual(incomplete.level, 'High');
  assert.match(incomplete.summary, /missing values/);
  assert.equal(explainConfidence({ rowCount: 0 }).components.evidence.score, 0.5);
  const doc = explainConfidence({ kind: 'document', chunkScores: [0.9, 0.8] });
  assert.equal(doc.level, 'High');
});

test('provenance describes the calculation and the columns used', () => {
  const sch = { tables: [{ name: 'att', columns: [{ name: 'dept' }, { name: 'status' }, { name: 'pct' }] }] };
  const sql = "SELECT dept, AVG(pct) AS a FROM att WHERE status = 'Present' GROUP BY dept";
  assert.deepEqual(columnsUsed(sql, sch).sort(), ['att.dept', 'att.pct', 'att.status']);
  const calc = describeCalculation(sql);
  assert.match(calc, /average of pct/);
  assert.match(calc, /filtered where status = 'Present'/);
  assert.match(calc, /grouped by dept/);
});

test('quality warnings only surface issues touching the columns the answer used', () => {
  const quality = { tables: [{ name: 'att', issues: [
    { type: 'missing_values', severity: 'medium', column: 'pct', message: '14 missing values in pct' },
    { type: 'invalid_dates', severity: 'high', column: 'day', message: 'bad dates in day' },
    { type: 'duplicate_rows', severity: 'high', column: null, message: '17 exact duplicate rows' },
  ] }] };
  const w = qualityWarningsFor({ quality, columnRefs: ['att.pct'], tables: ['att'] });
  assert.deepEqual(w.map((x) => x.type).sort(), ['duplicate_rows', 'missing_values']);
  assert.equal(qualityWarningsFor({ quality, columnRefs: ['att.other'], tables: ['other'] }).length, 0);
});

test('referential integrity: orphaned foreign keys are detected', async () => {
  const file = makeTempSqlite({
    parents: { columns: [['pid', 'INTEGER']], rows: [[1], [2], [3]] },
    children: { columns: [['cid', 'INTEGER'], ['pid', 'INTEGER']], rows: [[1, 1], [2, 2], [3, 99], [4, 98], [5, null]] },
  });
  const adapter = new SQLiteAdapter({ datasetId: 't', location: file });
  await adapter.connect();
  const sch = await adapter.getSchema();
  const semantic = await buildSemanticModel({ adapter, schema: sch, datasetType: 'sqlite' });
  const q = await analyzeDataQuality({ adapter, schema: sch, semantic, datasetType: 'sqlite', relationships: [{ fromTable: 'children', fromColumn: 'pid', toTable: 'parents', toColumn: 'pid' }] });
  const issue = q.tables.find((t) => t.name === 'children').issues.find((i) => i.type === 'referential_integrity');
  assert.equal(issue.count, 2);
  assert.match(issue.message, /orphaned pid/);
  await adapter.disconnect();
});
