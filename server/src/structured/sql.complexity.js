/**
 * SQL COST / COMPLEXITY CHECK (blueprint item 6)
 * Runs after syntax/safety validation and before execution. It rejects queries that are
 * technically valid SELECTs but would be expensive or abusive on a real database:
 *   - cartesian products (CROSS JOIN, or comma-joined tables with no join condition)
 *   - too many joins, too deeply nested subqueries, enormous statements
 *   - estimated join fan-out (product of joined table row counts without a key condition)
 * Heuristic by design (no EXPLAIN dependency, works on every dialect) and configurable.
 * Returns an advisory `score` so callers can show "query cost: low/medium/high".
 */
const { tokenize } = require('./sql.analyzer');

const LIMITS = {
  maxLength: parseInt(process.env.SQL_MAX_LENGTH || '4000', 10),
  maxJoins: parseInt(process.env.SQL_MAX_JOINS || '6', 10),
  maxDepth: parseInt(process.env.SQL_MAX_SUBQUERY_DEPTH || '4', 10),
  maxEstimatedRows: parseFloat(process.env.SQL_MAX_ESTIMATED_ROWS || '5e9'),
};

class SQLComplexityError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'SQLComplexityError'; this.details = details; }
}

const lc = (s) => String(s).toLowerCase();

function analyzeComplexity(sql, schema) {
  const tokens = tokenize(sql);
  const words = tokens.filter((t) => t.t === 'word').map((t) => lc(t.v));
  const joinCount = words.filter((w) => w === 'join').length;
  const crossJoin = tokens.some((t, i) => t.t === 'word' && lc(t.v) === 'cross' && lc(tokens[i + 1]?.v || '') === 'join');

  // subquery depth = number of "( select" nestings
  let depth = 0, maxDepth = 0;
  const stack = [];
  tokens.forEach((t, i) => {
    if (t.v === '(' && t.t === 'p') { const isSel = lc(tokens[i + 1]?.v || '') === 'select'; stack.push(isSel); if (isSel) { depth++; maxDepth = Math.max(maxDepth, depth); } }
    if (t.v === ')' && t.t === 'p') { if (stack.pop()) depth--; }
  });

  // comma joins in a FROM list: "FROM a, b" with no relating predicate
  let commaJoin = false;
  tokens.forEach((t, i) => {
    if (t.t === 'p' && t.v === ',') {
      for (let j = i - 1; j >= 0 && tokens[j].depth >= t.depth; j--) {
        if (tokens[j].depth > t.depth) continue;
        const w = tokens[j].t === 'word' ? lc(tokens[j].v) : '';
        if (w === 'from') { commaJoin = tokens[i + 1]?.t !== undefined; break; }
        if (['select', 'where', 'group', 'order', 'having', 'on', 'by', 'limit'].includes(w)) break;
      }
    }
  });
  const hasWhereOrOn = words.includes('where') || words.includes('on') || words.includes('using');

  // estimated fan-out: multiply row counts of referenced tables when they are joined without keys
  const rowCounts = new Map((schema?.tables || []).map((t) => [lc(t.name), Math.max(1, t.rowCount || 1)]));
  // every table OCCURRENCE in FROM/JOIN position counts (a self cross-join multiplies the same table)
  const referenced = tokens.filter((t, i) => (t.t === 'word' || t.t === 'qid') && rowCounts.has(lc(t.v)) && i > 0 && (['from', 'join'].includes(lc(tokens[i - 1].v)) || (tokens[i - 1].v === ',' && tokens[i - 1].t === 'p'))).map((t) => lc(t.v));
  const unkeyedJoin = (crossJoin || (commaJoin && !hasWhereOrOn));
  const estimatedRows = unkeyedJoin ? referenced.reduce((p, n) => p * rowCounts.get(n), 1) : Math.max(...referenced.map((n) => rowCounts.get(n)), 1);

  const reasons = [];
  if (sql.length > LIMITS.maxLength) reasons.push(`the statement is ${sql.length} characters long (limit ${LIMITS.maxLength})`);
  if (joinCount + (commaJoin ? 1 : 0) > LIMITS.maxJoins) reasons.push(`it joins ${joinCount} tables (limit ${LIMITS.maxJoins})`);
  if (maxDepth > LIMITS.maxDepth) reasons.push(`subqueries are nested ${maxDepth} levels deep (limit ${LIMITS.maxDepth})`);
  if (unkeyedJoin) reasons.push('it combines tables without a join condition (a cartesian product)');
  if (estimatedRows > LIMITS.maxEstimatedRows) reasons.push(`it could produce about ${estimatedRows.toExponential(1)} intermediate rows`);

  const score = Math.min(1, joinCount / 6 + maxDepth / 6 + (unkeyedJoin ? 0.6 : 0) + Math.min(0.4, sql.length / 10000));
  return { ok: reasons.length === 0, reasons, level: score < 0.34 ? 'low' : score < 0.67 ? 'medium' : 'high', score: +score.toFixed(2), joinCount, maxDepth, estimatedRows };
}

function assertWithinComplexity(sql, schema) {
  const r = analyzeComplexity(sql, schema);
  if (!r.ok) throw new SQLComplexityError(`Query is too expensive to run safely: ${r.reasons.join('; ')}. Please simplify it.`, r);
  return r;
}

module.exports = { analyzeComplexity, assertWithinComplexity, SQLComplexityError, LIMITS };
