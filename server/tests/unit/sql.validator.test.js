require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSql, SQLValidationError } = require('../../src/structured/sql.validator');

const schema = {
  tables: [
    { name: 'employees', columns: [{ name: 'id' }, { name: 'name' }, { name: 'salary' }] },
    { name: 'departments', columns: [{ name: 'id' }, { name: 'name' }] },
  ],
};

test('sql.validator: allows a plain SELECT', () => {
  const result = validateSql('SELECT name, salary FROM employees', schema, 'sqlite');
  assert.equal(result.valid, true);
  assert.deepEqual(result.tablesUsed, ['employees']);
});

test('sql.validator: allows SELECT with JOIN/GROUP BY/aggregation', () => {
  const result = validateSql(
    'SELECT d.name, AVG(e.salary) FROM employees e JOIN departments d ON e.id = d.id GROUP BY d.name',
    schema, 'sqlite'
  );
  assert.equal(result.valid, true);
});

for (const [label, sql] of Object.entries({
  DROP: 'DROP TABLE employees',
  DELETE: 'DELETE FROM employees',
  UPDATE: "UPDATE employees SET salary = 999999",
  INSERT: "INSERT INTO employees (name) VALUES ('x')",
  ALTER: 'ALTER TABLE employees ADD COLUMN hacked TEXT',
  ATTACH: "ATTACH DATABASE '/etc/passwd' AS x",
  PRAGMA: 'PRAGMA table_info(employees)',
})) {
  test(`sql.validator: blocks ${label}`, () => {
    assert.throws(() => validateSql(sql, schema, 'sqlite'), SQLValidationError);
  });
}

test('sql.validator: blocks queries against unknown tables (no hallucinated schema)', () => {
  assert.throws(() => validateSql('SELECT * FROM secret_admin_table', schema, 'sqlite'), SQLValidationError);
});

test('sql.validator: blocks multi-statement injection attempts', () => {
  assert.throws(() => validateSql('SELECT * FROM employees; DROP TABLE employees;', schema, 'sqlite'), SQLValidationError);
});

test('sql.validator: blocks SQL comments (injection smuggling vector)', () => {
  assert.throws(() => validateSql('SELECT * FROM employees -- DROP TABLE employees', schema, 'sqlite'), SQLValidationError);
});

test('sql.validator: blocks empty input', () => {
  assert.throws(() => validateSql('', schema, 'sqlite'), SQLValidationError);
  assert.throws(() => validateSql('   ', schema, 'sqlite'), SQLValidationError);
});

test('sql.validator: works across all three supported dialects', () => {
  assert.equal(validateSql('SELECT name FROM employees WHERE name ILIKE \'%a%\'', schema, 'postgres').valid, true);
  assert.equal(validateSql('SELECT `name` FROM `employees` LIMIT 5', schema, 'mysql').valid, true);
  assert.equal(validateSql('SELECT name FROM employees', schema, 'sqlite').valid, true);
});

test('sql.validator: security holds regardless of dialect', () => {
  assert.throws(() => validateSql('DELETE FROM employees', schema, 'postgres'), SQLValidationError);
  assert.throws(() => validateSql('DELETE FROM employees', schema, 'mysql'), SQLValidationError);
});
