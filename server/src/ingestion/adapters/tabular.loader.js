/**
 * TABULAR LOADER
 * ------------------------------------------------------------------
 * Shared logic used by CSVAdapter and ExcelAdapter.
 *
 * Per spec Section 12: CSV/Excel should be normalized into the SAME
 * structured-query abstraction as real databases. We do this by
 * materializing each sheet/file into a table inside a small per-dataset
 * SQLite file, so the rest of the Structured Engine (SQL generator,
 * validator, executor) never needs to know the data came from a
 * spreadsheet rather than a real database.
 * ------------------------------------------------------------------
 */
const Database = require('better-sqlite3');
const { parseDateLoose, toIsoDate } = require('../../utils/dates');

/** Infer a SQLite-compatible column type from a sample of values. */
function inferColumnType(values) {
  let allInt = true;
  let allNumeric = true;
  let seenAny = false;

  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    seenAny = true;
    const n = Number(v);
    if (Number.isNaN(n)) {
      allInt = false;
      allNumeric = false;
      break;
    }
    if (!Number.isInteger(n)) allInt = false;
  }

  if (!seenAny) return 'TEXT';
  if (allInt) return 'INTEGER';
  if (allNumeric) return 'REAL';
  return 'TEXT';
}

function sanitizeColumnName(name, index) {
  let clean = String(name ?? `column_${index}`).trim();
  clean = clean.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(clean)) clean = 'c_' + clean;
  return clean || `column_${index}`;
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * Load an array-of-objects dataset into a fresh SQLite file as `tableName`.
 * Returns { schema, profile, dbPath }.
 */
function loadRowsIntoSqlite({ dbPath, tableName, rows }) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  if (!rows || rows.length === 0) {
    throw new Error('Dataset appears to be empty - no rows found.');
  }

  const rawColumnNames = Object.keys(rows[0]);
  const columnNames = rawColumnNames.map((c, i) => sanitizeColumnName(c, i));

  // Date normalization: a TEXT column whose values (>=90%) parse as dates is stored as ISO
  // YYYY-MM-DD so that strftime()/ordering/grouping work no matter the source format.
  // The formats seen and any unparseable values are recorded and surfaced as data-quality findings.
  const dateNormalization = {};
  const normalizedDateColumns = new Set();
  rawColumnNames.forEach((raw, idx) => {
    const sampleVals = rows.map((r) => r[raw]).filter((v) => v !== null && v !== undefined && v !== '');
    if (sampleVals.length < 3) return;
    if (inferColumnType(sampleVals.slice(0, 500)) !== 'TEXT') return;
    const parsedAll = sampleVals.map((v) => parseDateLoose(v));
    const okCount = parsedAll.filter(Boolean).length;
    if (okCount / sampleVals.length < 0.9) return;
    const formats = {};
    const invalid = [];
    parsedAll.forEach((p, i) => { if (p) formats[p.format] = (formats[p.format] || 0) + 1; else invalid.push(sampleVals[i]); });
    dateNormalization[columnNames[idx]] = { formats, invalidCount: invalid.length, invalidExamples: invalid.slice(0, 5) };
    normalizedDateColumns.add(idx);
  });

  const columnTypes = columnNames.map((_, idx) => {
    const raw = rawColumnNames[idx];
    const sample = rows.slice(0, 500).map(r => r[raw]);
    return inferColumnType(sample);
  });

  const createSql = `CREATE TABLE ${quoteIdent(tableName)} (` +
    columnNames.map((c, i) => {
      // TEXT columns get COLLATE NOCASE so that WHERE/GROUP BY/ORDER BY are
      // case-insensitive by default. This closes a real, reproducible gap:
      // an LLM-generated query like WHERE status = 'cancelled' would
      // otherwise silently return zero rows against real data stored as
      // 'Cancelled', with no error to signal anything went wrong - the
      // person just gets a confidently wrong "no results" answer. Real-
      // world spreadsheet data is inconsistently cased constantly (status
      // flags, categories, names), so this needs to be handled at the
      // storage layer, not hoped for from prompt wording alone.
      const collation = columnTypes[i] === 'TEXT' ? ' COLLATE NOCASE' : '';
      return `${quoteIdent(c)} ${columnTypes[i]}${collation}`;
    }).join(', ') +
    `)`;
  db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
  db.exec(createSql);

  const insertSql = `INSERT INTO ${quoteIdent(tableName)} (${columnNames.map(quoteIdent).join(', ')}) VALUES (${columnNames.map(() => '?').join(', ')})`;
  const insertStmt = db.prepare(insertSql);
  const insertMany = db.transaction((allRows) => {
    for (const row of allRows) {
      const values = rawColumnNames.map((raw, i) => {
        if (normalizedDateColumns.has(i)) {
          const p = parseDateLoose(row[raw]);
          if (p) return toIsoDate(p.date);
        }
        return normalizeValue(row[raw], columnTypes[i]);
      });
      insertStmt.run(...values);
    }
  });
  insertMany(rows);

  // Missing-value & uniqueness profile (Section 6: dataset profile)
  const profile = { columns: {} };
  for (let i = 0; i < columnNames.length; i++) {
    const raw = rawColumnNames[i];
    const colValues = rows.map(r => r[raw]);
    const missing = colValues.filter(v => v === null || v === undefined || v === '').length;
    const uniqueCount = new Set(colValues.map(v => JSON.stringify(v))).size;
    profile.columns[columnNames[i]] = {
      inferredType: columnTypes[i],
      missingCount: missing,
      missingRatio: +(missing / rows.length).toFixed(4),
      uniqueCount,
    };
  }
  profile.rowCount = rows.length;
  if (Object.keys(dateNormalization).length) profile.dateNormalization = dateNormalization;

  const schema = {
    tables: [{
      name: tableName,
      rowCount: rows.length,
      columns: columnNames.map((c, i) => ({
        name: c,
        type: columnTypes[i],
        nullable: true,
        primaryKey: false,
      })),
      foreignKeys: [],
    }],
  };

  db.close();
  return { schema, profile };
}

function normalizeValue(v, type) {
  if (v === undefined || v === '') return null;
  if (v === null) return null;
  if (type === 'INTEGER' || type === 'REAL') {
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  return String(v);
}

module.exports = { loadRowsIntoSqlite, sanitizeColumnName, quoteIdent };
