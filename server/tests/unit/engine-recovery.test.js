require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { ingestFile } = require('../../src/ingestion/ingestion.pipeline');
const { routeQuery } = require('../../src/core/query.router');
const { resolvePolicy, PolicyStore } = require('../../src/security/data.policy');

async function load(name, csv) {
  const p = `/tmp/${name}-${Date.now()}.csv`;
  // unique content per test so content-hash reuse never aliases fixtures across tests/runs
  const uniq = csv.trim().split('\n').map((l, i) => `${l},${i === 0 ? 'batch' : name + Date.now()}`).join('\n') + '\n';
  fs.writeFileSync(p, uniq);
  const ds = await ingestFile({ filePath: p, originalFilename: `${name}.csv` });
  fs.rmSync(p, { force: true });
  return ds;
}
const run = (ds, question, llm, extra = {}) => routeQuery({
  question, datasetIds: [ds.dataset_id], session: { active_dataset_id: null }, llmProvider: llm, embeddingProvider: null, conversationContext: '', ...extra,
});
const sqlLLM = (fn) => ({ async complete(prompt) { return prompt.includes('SQL generation engine') ? fn(prompt) : 'x'; } });

const CSV = 'emp_id,name,department,salary,visit_date\n1,A,Sales,100,2026-01-05\n2,B,Sales,200,05/02/2026\n3,C,HR,300,2026-02-11\n4,D,HR,400,2026-03-01\n';

test('ingestion builds a semantic model and normalizes dates to ISO', async () => {
  const ds = await load('emp1', CSV);
  const sem = ds.profile.semantic.tables[0];
  assert.equal(sem.columns.find((c) => c.name === 'department').role, 'categorical');
  assert.equal(sem.columns.find((c) => c.name === 'visit_date').role, 'temporal');
  assert.ok(ds.profile.quality.tables[0].issues.some((i) => i.type === 'mixed_date_formats'));
  const r = await run(ds, 'x', sqlLLM(() => "SELECT visit_date FROM emp1 WHERE emp_id = 2"));
  assert.equal(r.evidence.sample_rows[0].visit_date, '2026-02-05');
});

test('error recovery: a misspelled column is repaired deterministically before execution', async () => {
  const ds = await load('emp2', CSV);
  const r = await run(ds, 'total salaries', sqlLLM(() => 'SELECT SUM(salaryy) AS total FROM emp2'));
  assert.ok(r.evidence, `no evidence: ${r.answer}`);
  assert.equal(r.evidence.sample_rows[0].total, 1000);
  assert.ok(r.evidence.repairs.some((x) => x.type === 'column_name'));
});

test('error recovery: DB error is fed back to the model, which corrects the query', async () => {
  const ds = await load('emp3', CSV);
  let calls = 0;
  const llm = sqlLLM((prompt) => {
    calls++;
    if (prompt.includes('YOUR PREVIOUS QUERY FAILED')) return 'SELECT COUNT(*) AS n FROM emp3';
    return 'SELECT COUNT(*) AS n FROM emp3 WHERE nonsense_col_xyz_abc = 3';
  });
  const r = await run(ds, 'how many rows', llm);
  assert.equal(calls, 2);
  assert.equal(r.evidence.sample_rows[0].n, 4);
  assert.equal(r.evidence.recovery_attempts, 1);
});

test('missing GROUP BY is added and the result is correct', async () => {
  const ds = await load('emp4', CSV);
  const r = await run(ds, 'avg by dept', sqlLLM(() => 'SELECT department, AVG(salary) AS avg_sal FROM emp4 ORDER BY avg_sal DESC'));
  assert.equal(r.evidence.row_count, 2, JSON.stringify({ sql: r.generatedSql, repairs: r.sqlRepaired, rows: r.evidence.sample_rows }));
  assert.equal(r.evidence.sample_rows[0].department, 'HR');
  assert.ok(r.evidence.repairs.some((x) => x.type === 'missing_group_by'));
});

test('a security-class validation failure is NOT retried through the model', async () => {
  const ds = await load('emp5', CSV);
  let calls = 0;
  const r = await run(ds, 'wipe it', sqlLLM(() => { calls++; return 'DELETE FROM emp5'; }));
  assert.equal(calls, 1);
  assert.equal(r.evidence, null);
  assert.match(r.answer, /safety validation/);
});

test('policy: denied column blocks the query; row filter limits visible rows', async () => {
  const ds = await load('emp6', CSV);
  PolicyStore.add({ datasetId: ds.dataset_id, role: 'viewer', kind: 'deny_column', columnName: 'salary' });
  PolicyStore.add({ datasetId: ds.dataset_id, role: 'employee', kind: 'row_filter', columnName: 'name', op: '=', value: '{{user.name}}' });

  const viewer = resolvePolicy({ datasetId: ds.dataset_id, user: { role: 'viewer' } });
  const denied = await run(ds, 'salaries', sqlLLM(() => 'SELECT name, salary FROM emp6'), { policy: viewer });
  assert.equal(denied.denied, true);
  const star = await run(ds, 'everything', sqlLLM(() => 'SELECT * FROM emp6'), { policy: viewer });
  assert.equal(star.denied, true);
  const ok = await run(ds, 'names', sqlLLM(() => 'SELECT name FROM emp6'), { policy: viewer });
  assert.equal(ok.evidence.row_count, 4);

  const emp = resolvePolicy({ datasetId: ds.dataset_id, user: { role: 'employee', name: 'C' } });
  const mine = await run(ds, 'all rows', sqlLLM(() => 'SELECT name, salary FROM emp6'), { policy: emp });
  assert.equal(mine.evidence.row_count, 1);
  assert.equal(mine.evidence.sample_rows[0].salary, 300);
  const admin = resolvePolicy({ datasetId: ds.dataset_id, user: { role: 'admin' } });
  const all = await run(ds, 'all rows', sqlLLM(() => 'SELECT name FROM emp6'), { policy: admin });
  assert.equal(all.evidence.row_count, 4);
});
