require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadRowsIntoSqlite } = require('../../src/ingestion/adapters/tabular.loader');
const Database = require('better-sqlite3');

/**
 * Found via live user testing: a small local LLM generated
 * WHERE status = 'cancelled' (lowercase) against data actually stored as
 * 'Cancelled' (capitalized) - a completely plausible, common mismatch for
 * real-world spreadsheet data. SQLite's default TEXT comparison is
 * case-sensitive, so this silently returned zero rows instead of erroring,
 * which is worse than a crash: a confidently wrong "no results" answer.
 * Fixed by giving TEXT columns COLLATE NOCASE at table-creation time.
 */
test('tabular loader: TEXT columns compare case-insensitively by default', () => {
  const dbPath = `/tmp/collation-test-${Date.now()}.db`;
  const rows = [
    { name: 'Alice', status: 'Cancelled' },
    { name: 'Bob', status: 'Completed' },
  ];
  loadRowsIntoSqlite({ dbPath, tableName: 'appointments', rows });

  const db = new Database(dbPath);

  const lowercase = db.prepare(`SELECT * FROM appointments WHERE status = 'cancelled'`).all();
  assert.equal(lowercase.length, 1, 'lowercase literal should still match capitalized stored data');
  assert.equal(lowercase[0].name, 'Alice');

  const uppercase = db.prepare(`SELECT * FROM appointments WHERE status = 'CANCELLED'`).all();
  assert.equal(uppercase.length, 1, 'uppercase literal should also match');

  const groupBy = db.prepare(`SELECT status, COUNT(*) as c FROM appointments GROUP BY status`).all();
  assert.equal(groupBy.length, 2, 'GROUP BY should not be fooled by casing either');

  db.close();
  fs.rmSync(dbPath, { force: true });
});

test('tabular loader: numeric columns are unaffected by the text collation change', () => {
  const dbPath = `/tmp/collation-test-numeric-${Date.now()}.db`;
  const rows = [{ id: 1, amount: 100.5 }, { id: 2, amount: 200.25 }];
  const { schema } = loadRowsIntoSqlite({ dbPath, tableName: 't', rows });

  assert.equal(schema.tables[0].columns.find((c) => c.name === 'amount').type, 'REAL');

  const db = new Database(dbPath);
  const total = db.prepare(`SELECT SUM(amount) as total FROM t`).get();
  assert.equal(total.total, 300.75);
  db.close();
  fs.rmSync(dbPath, { force: true });
});
