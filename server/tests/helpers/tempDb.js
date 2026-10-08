const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/** Creates a throw-away SQLite file from { tableName: { columns:[[name,type]...], rows:[[...]] } } */
function makeTempSqlite(spec) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')), 'test.db');
  const db = new Database(file);
  for (const [table, { columns, rows }] of Object.entries(spec)) {
    db.exec(`CREATE TABLE "${table}" (${columns.map(([n, t]) => `"${n}" ${t}`).join(', ')})`);
    const ins = db.prepare(`INSERT INTO "${table}" VALUES (${columns.map(() => '?').join(',')})`);
    for (const r of rows) ins.run(...r);
  }
  db.close();
  return file;
}

module.exports = { makeTempSqlite };
