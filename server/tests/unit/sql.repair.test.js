require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { repairTableNames } = require('../../src/structured/sql.repair');

const schema = { tables: [{ name: 'employee', columns: [] }] };

test('sql.repair: fixes a plural guess against a singular real table name', () => {
  const result = repairTableNames('SELECT AVG(salary) FROM employees', schema);
  assert.equal(result.repaired, true);
  assert.equal(result.sql, 'SELECT AVG(salary) FROM employee');
  assert.deepEqual(result.corrections, [{ from: 'employees', to: 'employee' }]);
});

test('sql.repair: fixes a singular guess against a plural real table name', () => {
  const pluralSchema = { tables: [{ name: 'orders', columns: [] }] };
  const result = repairTableNames('SELECT * FROM order', pluralSchema);
  assert.equal(result.sql, 'SELECT * FROM orders');
});

test('sql.repair: does nothing when the table name is already correct', () => {
  const result = repairTableNames('SELECT * FROM employee', schema);
  assert.equal(result.repaired, false);
  assert.equal(result.sql, 'SELECT * FROM employee');
});

test('sql.repair: does not touch a genuinely unknown table it cannot map', () => {
  const result = repairTableNames('SELECT * FROM totally_made_up_table', schema);
  assert.equal(result.repaired, false);
  assert.equal(result.sql, 'SELECT * FROM totally_made_up_table');
});

test('sql.repair: handles JOINs with multiple table references', () => {
  const multiSchema = { tables: [{ name: 'employee' }, { name: 'department' }] };
  const result = repairTableNames(
    'SELECT * FROM employees e JOIN departments d ON e.dept_id = d.id',
    multiSchema
  );
  assert.equal(result.sql, 'SELECT * FROM employee e JOIN department d ON e.dept_id = d.id');
  assert.equal(result.corrections.length, 2);
});
