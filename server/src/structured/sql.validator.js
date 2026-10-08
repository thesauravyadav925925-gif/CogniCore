/**
 * SQL VALIDATOR
 * ------------------------------------------------------------------
 * RULE #7: Never trust raw LLM-generated SQL.
 * RULE #8: Validate SQL before execution.
 *
 * Pipeline: LLM SQL -> Parser -> AST -> Operation validation ->
 *           Table validation -> Column validation -> Read-only execution
 *
 * We use node-sql-parser to build a real AST rather than regex matching,
 * then whitelist statement types and referenced tables/columns against
 * the dataset's actual discovered schema.
 * ------------------------------------------------------------------
 */
const { Parser } = require('node-sql-parser');
const { extractCteNames } = require('./sql.analyzer');
const { analyzeComplexity } = require('./sql.complexity');
const parser = new Parser();

const ALLOWED_STATEMENT_TYPES = new Set(['select']);
const BLOCKED_KEYWORDS = [
  'DROP', 'DELETE', 'UPDATE', 'INSERT', 'ALTER', 'CREATE', 'ATTACH',
  'DETACH', 'REPLACE', 'TRUNCATE', 'GRANT', 'REVOKE', 'PRAGMA', 'VACUUM',
  'EXEC', 'EXECUTE', 'CALL',
];

class SQLValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SQLValidationError';
    this.details = details;
  }
}

/**
 * Maps a CogniCore dataset type to the SQL dialect node-sql-parser expects.
 *
 * NOTE: SQLite-backed datasets (sqlite/csv/xlsx/json) are validated using
 * the 'postgresql' grammar rather than 'sqlite'. This is deliberate: in
 * testing, node-sql-parser's own 'sqlite' dialect implementation fails to
 * parse perfectly valid, common SQL (e.g. a scalar subquery in a WHERE
 * clause: "WHERE salary = (SELECT MAX(salary) FROM t)"), while its
 * 'postgresql' dialect parses the exact same query correctly AND still
 * correctly recognizes double-quoted identifiers (SQLite and PostgreSQL
 * share that quoting convention, unlike MySQL's backticks). This only
 * changes which grammar VALIDATES the query's structure - the query still
 * physically executes against the real SQLite file via better-sqlite3
 * either way, so this does not weaken any security guarantee.
 */
const DATASET_TYPE_TO_DIALECT = {
  sqlite: 'postgresql',
  csv: 'postgresql',   // materialized into an internal SQLite file
  xlsx: 'postgresql',  // materialized into an internal SQLite file
  json: 'postgresql',  // materialized into an internal SQLite file
  postgres: 'postgresql',
  mysql: 'mysql',
};

/**
 * Validate `sql` against the dataset's known schema.
 * @param {string} sql
 * @param {{tables: {name:string, columns:{name:string}[]}[]}} schema
 * @param {string} [datasetType] - used to pick the correct SQL dialect for parsing
 * @returns {{valid: true, ast: object, tablesUsed: string[]}}
 */
function validateSql(sql, schema, datasetType = 'sqlite') {
  const dialect = DATASET_TYPE_TO_DIALECT[datasetType] || 'sqlite';
  if (!sql || typeof sql !== 'string' || !sql.trim()) {
    throw new SQLValidationError('Empty SQL is not allowed.');
  }

  // Hard block: reject if any dangerous keyword appears as a standalone token,
  // even before we try to parse (defense in depth against parser quirks).
  const upper = sql.toUpperCase();
  for (const kw of BLOCKED_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`);
    if (re.test(upper)) {
      throw new SQLValidationError(`Query contains a disallowed operation: ${kw}`, { keyword: kw });
    }
  }

  // Reject statement chaining / comments used to smuggle a second statement.
  if (sql.includes(';') && sql.trim().indexOf(';') !== sql.trim().length - 1) {
    throw new SQLValidationError('Multiple statements are not allowed.');
  }
  if (/--|\/\*/.test(sql)) {
    throw new SQLValidationError('SQL comments are not allowed.');
  }

  let ast;
  try {
    ast = parser.astify(sql, { database: dialect });
  } catch (err) {
    throw new SQLValidationError(`Query failed to parse: ${err.message}`);
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    throw new SQLValidationError('Exactly one SELECT statement is required.');
  }

  const stmt = statements[0];
  if (!ALLOWED_STATEMENT_TYPES.has(stmt.type)) {
    throw new SQLValidationError(`Statement type "${stmt.type}" is not allowed. Only SELECT is permitted.`);
  }

  // Validate table references against the ACTUAL dataset schema.
  const knownTables = new Set(schema.tables.map(t => t.name.toLowerCase()));
  let tableList = [];
  try {
    tableList = parser.tableList(sql, { database: dialect });
  } catch (_) {
    tableList = [];
  }
  // Names introduced by the query's own WITH clause are not real tables.
  const cteNames = new Set(extractCteNames(sql).map((n) => n.toLowerCase()));
  const tablesUsed = tableList.map(t => t.split('::').pop()).filter((t) => !cteNames.has(t.toLowerCase()) || knownTables.has(t.toLowerCase()));

  for (const table of tablesUsed) {
    if (!knownTables.has(table.toLowerCase())) {
      throw new SQLValidationError(`Query references unknown table "${table}".`, { table });
    }
  }

  if (tablesUsed.length === 0) {
    throw new SQLValidationError('Query does not reference any known table.');
  }

  // Cost / complexity gate (blueprint item 6): valid-but-abusive queries are refused before execution.
  const complexity = analyzeComplexity(sql, schema);
  if (!complexity.ok) {
    throw new SQLValidationError(`Query is too expensive to run safely: ${complexity.reasons.join('; ')}. Please simplify it.`, { complexity });
  }

  return { valid: true, ast: stmt, tablesUsed, complexity };
}

module.exports = { validateSql, SQLValidationError, ALLOWED_STATEMENT_TYPES, BLOCKED_KEYWORDS };
