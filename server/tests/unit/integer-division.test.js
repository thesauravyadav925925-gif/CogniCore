require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixIntegerDivision } = require('../../src/structured/sql.repair');

/**
 * Found via live user testing: "What is the overall appointment completion
 * rate?" generated COUNT(...)/COUNT(*)*100 which SQLite evaluates as
 * integer division (truncating 5/7 to 0 BEFORE the *100), giving a
 * confidently wrong "0%" instead of ~71.4%. Worse than a refusal - it
 * looked like a real, precise answer.
 */
test('sql.repair: fixes the exact reported completion-rate bug', () => {
  const buggy = "SELECT COUNT(CASE WHEN status = 'completed' THEN 1 END) / COUNT(*) * 100 AS completion_rate FROM t";
  const result = fixIntegerDivision(buggy);
  assert.equal(result.repaired, true);
  assert.match(result.sql, /1\.0 \* COUNT\(CASE WHEN status = 'completed' THEN 1 END\) \/ COUNT\(\*\)/);
});

test('sql.repair: fixIntegerDivision produces the mathematically correct result', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (status TEXT)');
  const ins = db.prepare('INSERT INTO t VALUES (?)');
  ['completed', 'completed', 'completed', 'completed', 'completed', 'cancelled', 'no-show'].forEach((s) => ins.run(s));

  const buggy = "SELECT COUNT(CASE WHEN status = 'completed' THEN 1 END) / COUNT(*) * 100 AS rate FROM t";
  assert.equal(db.prepare(buggy).get().rate, 0, 'sanity check: the bug is real without the fix');

  const fixed = fixIntegerDivision(buggy);
  const rate = db.prepare(fixed.sql).get().rate;
  assert.ok(Math.abs(rate - (5 / 7) * 100) < 0.001, `expected ~71.43, got ${rate}`);
  db.close();
});

test('sql.repair: handles SUM(...)/COUNT(...) the same way', () => {
  const result = fixIntegerDivision('SELECT SUM(amount) / COUNT(*) AS avg_amount FROM t');
  assert.equal(result.repaired, true);
  assert.match(result.sql, /1\.0 \* SUM\(amount\) \/ COUNT\(\*\)/);
});

test('sql.repair: does not double-fix an already-safe CAST expression', () => {
  const already = 'SELECT CAST(COUNT(*) AS REAL) / COUNT(id) FROM t';
  const result = fixIntegerDivision(already);
  assert.equal(result.repaired, false);
  assert.equal(result.sql, already);
});

test('sql.repair: does not double-fix an already-safe "1.0 *" expression', () => {
  const already = 'SELECT 1.0 * COUNT(*) / COUNT(id) FROM t';
  const result = fixIntegerDivision(already);
  assert.equal(result.repaired, false);
});

test('sql.repair: leaves queries with no division untouched', () => {
  const sql = 'SELECT COUNT(*) FROM t';
  const result = fixIntegerDivision(sql);
  assert.equal(result.repaired, false);
  assert.equal(result.sql, sql);
});

test('sql.repair: correctly handles a nested IN(...) inside CASE WHEN without breaking paren matching', () => {
  const sql = "SELECT COUNT(CASE WHEN status IN ('a','b') THEN 1 END) / COUNT(*) FROM t";
  const result = fixIntegerDivision(sql);
  assert.equal(result.repaired, true);
  assert.match(result.sql, /1\.0 \* COUNT\(CASE WHEN status IN \('a','b'\) THEN 1 END\)/);
});
