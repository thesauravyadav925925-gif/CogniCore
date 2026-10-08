const test = require('node:test');
const assert = require('node:assert');
const { findUnknownColumns, repairColumnNames, repairMissingGroupBy } = require('../../src/structured/sql.analyzer');
const { repairValueLiterals, listStringFilters } = require('../../src/structured/sql.values.repair');
const { shortestJoinPath, renderJoinHints } = require('../../src/schema/join.planner');

const schema = { tables: [
  { name: 'employee', columns: [{ name: 'employee_id' }, { name: 'name' }, { name: 'salary' }, { name: 'department_id' }, { name: 'status' }] },
  { name: 'department', columns: [{ name: 'department_id' }, { name: 'department_name' }] },
] };

test('unknown column detection ignores functions, aliases, keywords', () => {
  const ok = 'SELECT d.department_name AS dept, AVG(e.salary) AS avg_sal, COUNT(*) FROM employee e JOIN department d ON e.department_id = d.department_id GROUP BY d.department_name ORDER BY avg_sal DESC LIMIT 5';
  assert.deepStrictEqual(findUnknownColumns(ok, schema), []);
  const win = 'SELECT name, salary, SUM(salary) OVER (ORDER BY employee_id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running FROM employee';
  assert.deepStrictEqual(findUnknownColumns(win, schema), []);
  const cast = "SELECT CAST(salary AS REAL) / 2, strftime('%Y', name) FROM employee WHERE status = 'x'";
  assert.deepStrictEqual(findUnknownColumns(cast, schema), []);
  const extract = 'SELECT EXTRACT(YEAR FROM salary) FROM employee';
  assert.deepStrictEqual(findUnknownColumns(extract, schema), []);
});

test('misspelled columns are repaired to real ones; unresolved ones are reported', () => {
  const r = repairColumnNames('SELECT name, salaryy FROM employee WHERE statuss = 1', schema);
  assert.ok(r.repaired);
  assert.match(r.sql, /salary FROM employee WHERE status = 1/);
  const bad = repairColumnNames('SELECT zzzzzzzz FROM employee', schema);
  assert.strictEqual(bad.unresolved[0].name, 'zzzzzzzz');
});

test('missing GROUP BY is added for aggregate + bare column', () => {
  const r = repairMissingGroupBy('SELECT department_id, AVG(salary) AS a FROM employee ORDER BY a DESC LIMIT 3');
  assert.ok(r.repaired);
  assert.match(r.sql, /GROUP BY department_id\s+ORDER BY a DESC LIMIT 3/);
  assert.strictEqual(repairMissingGroupBy('SELECT COUNT(*) FROM employee').repaired, false);
  assert.strictEqual(repairMissingGroupBy('SELECT department_id, AVG(salary) FROM employee GROUP BY department_id').repaired, false);
  assert.strictEqual(repairMissingGroupBy('SELECT name, SUM(salary) OVER (ORDER BY name) FROM employee').repaired, false);
});

test('value literals are repaired against measured values only', () => {
  const semantic = { tables: [{ name: 'employee', columns: [{ name: 'status', stats: { distinct: 3 }, values: [{ value: 'Completed' }, { value: 'Cancelled' }, { value: 'No-show' }] }] }] };
  const r = repairValueLiterals("SELECT * FROM employee WHERE status = 'cancelled' OR status IN ('no show', 'Completed')", semantic);
  assert.ok(r.repaired);
  assert.match(r.sql, /status = 'Cancelled'/);
  assert.match(r.sql, /'No-show'/);
  assert.strictEqual(repairValueLiterals("SELECT * FROM employee WHERE status = 'banana'", semantic).repaired, false);
  assert.deepStrictEqual(listStringFilters("SELECT 1 FROM t WHERE status = 'x'"), [{ column: 'status', literal: 'x' }]);
});

test('join planner finds multi-hop path', () => {
  const rels = [
    { fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'customer_id' },
    { fromTable: 'order_items', fromColumn: 'order_id', toTable: 'orders', toColumn: 'order_id' },
    { fromTable: 'order_items', fromColumn: 'product_id', toTable: 'products', toColumn: 'product_id' },
  ];
  const p = shortestJoinPath(rels, 'customers', 'products');
  assert.strictEqual(p.length, 3);
  const sch = { tables: [{ name: 'customers', columns: [{ name: 'customer_id' }] }, { name: 'orders', columns: [{ name: 'order_id' }] }, { name: 'order_items', columns: [{ name: 'order_id' }] }, { name: 'products', columns: [{ name: 'category' }] }] };
  assert.match(renderJoinHints('which customers bought electronics products', sch, rels), /customers.*products/);
});
