/**
 * Dialect-aware identifier quoting + dialect resolution.
 * Datasets materialized from CSV/Excel/JSON (and native SQLite) all execute on SQLite;
 * postgres and mysql are live connections.
 */
const SQLITE_BACKED = new Set(['sqlite', 'csv', 'xlsx', 'json', 'api']);

function dialectOf(datasetType) {
  if (datasetType === 'postgres') return 'postgres';
  if (datasetType === 'mysql') return 'mysql';
  return 'sqlite';
}

function quoteIdent(name, dialect = 'sqlite') {
  const s = String(name);
  if (dialect === 'mysql') return '`' + s.replace(/`/g, '``') + '`';
  return '"' + s.replace(/"/g, '""') + '"';
}

function isSqliteBacked(datasetType) {
  return SQLITE_BACKED.has(datasetType);
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isNumericType(sqlType = '') {
  return /INT|REAL|NUM|FLOAT|DOUBLE|DEC|MONEY|SERIAL/i.test(sqlType);
}

function isTextType(sqlType = '') {
  return /CHAR|TEXT|STRING|CLOB|VARCHAR|^$|UNKNOWN/i.test(sqlType) && !isNumericType(sqlType);
}

function isDateType(sqlType = '') {
  return /DATE|TIME/i.test(sqlType);
}

module.exports = { dialectOf, quoteIdent, isSqliteBacked, toNum, isNumericType, isTextType, isDateType, SQLITE_BACKED };
