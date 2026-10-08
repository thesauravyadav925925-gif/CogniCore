/**
 * SQL ANALYZER
 * A small, dependency-free SQL tokenizer plus three deterministic checks used by
 * the query-validation / error-recovery layers (Features 17 & 18):
 *   - findUnknownColumns  : identifiers that are not a column/alias/table
 *   - repairColumnNames   : fuzzy-fix misspelled columns ("salaryy" -> "salary")
 *   - repairMissingGroupBy: add the GROUP BY an aggregate query forgot
 * It never widens what a query can do - security validation still happens in
 * sql.validator.js; these only reduce false failures and improve error messages.
 */
const { closestMatch } = require('../utils/strings');

const KEYWORDS = new Set(`select from where group by order having limit offset join inner left right full outer cross on using as and or not in is null like glob between exists case when then else end distinct all union intersect except asc desc with recursive over partition rows range unbounded preceding following current row true false cast collate nocase escape filter nulls first last interval date time timestamp integer int real float double text numeric decimal varchar char boolean signed unsigned natural lateral current_date current_time current_timestamp year month day hour minute second bigint smallint precision values if any some window within ties others no groups fetch next only`.split(/\s+/));

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max', 'total', 'group_concat', 'string_agg', 'stddev', 'variance', 'median']);

function tokenize(sql) {
  const tokens = [];
  let i = 0, depth = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (ch === "'") {
      i++;
      let v = '';
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { v += "'"; i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        v += sql[i++];
      }
      tokens.push({ t: 'str', v, s: start, e: i, depth });
    } else if (ch === '"' || ch === '`') {
      i++;
      let v = '';
      while (i < n && sql[i] !== ch) v += sql[i++];
      i++;
      tokens.push({ t: 'qid', v, s: start, e: i, depth });
    } else if (/[0-9]/.test(ch)) {
      while (i < n && /[0-9.]/.test(sql[i])) i++;
      tokens.push({ t: 'num', v: sql.slice(start, i), s: start, e: i, depth });
    } else if (/[A-Za-z_]/.test(ch)) {
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      tokens.push({ t: 'word', v: sql.slice(start, i), s: start, e: i, depth });
    } else {
      const two = sql.slice(i, i + 2);
      if (['<=', '>=', '<>', '!=', '||', '::'].includes(two)) { i += 2; tokens.push({ t: 'p', v: two, s: start, e: i, depth }); continue; }
      i++;
      if (ch === '(') { tokens.push({ t: 'p', v: ch, s: start, e: i, depth }); depth++; continue; }
      if (ch === ')') { depth = Math.max(0, depth - 1); tokens.push({ t: 'p', v: ch, s: start, e: i, depth }); continue; }
      tokens.push({ t: 'p', v: ch, s: start, e: i, depth });
    }
  }
  return tokens;
}

const lc = (s) => String(s).toLowerCase();
const isIdentTok = (t) => t && (t.t === 'word' || t.t === 'qid');
const isKw = (t, kw) => t && t.t === 'word' && lc(t.v) === kw;

function buildScope(tokens, schema) {
  const tableByName = new Map(schema.tables.map((t) => [lc(t.name), t]));
  const aliasMap = new Map();      // alias/table name -> table
  const usedTables = new Set();
  const consumed = new Set();      // token indexes that are table refs/aliases
  const names = new Set();         // aliases + CTE names tolerated as bare identifiers

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (isKw(tk, 'as')) {
      const before = tokens[i - 1], after = tokens[i + 1];
      if (isIdentTok(after)) names.add(lc(after.v));
      if (isIdentTok(before)) names.add(lc(before.v)); // CTE name: "WITH x AS ("
    }
    if (isKw(tk, 'from') || isKw(tk, 'join') || (tk.v === ',' && tk.t === 'p' && inFromChain(tokens, i))) {
      let j = i + 1;
      const tname = tokens[j];
      if (isIdentTok(tname) && tableByName.has(lc(tname.v)) && tokens[j + 1]?.v !== '(') {
        const table = tableByName.get(lc(tname.v));
        usedTables.add(table.name);
        aliasMap.set(lc(table.name), table);
        consumed.add(j);
        let k = j + 1;
        if (isKw(tokens[k], 'as')) { k++; }
        const al = tokens[k];
        if (isIdentTok(al) && !(al.t === 'word' && KEYWORDS.has(lc(al.v)))) {
          aliasMap.set(lc(al.v), table);
          consumed.add(k);
        }
      }
    }
  }
  return { tableByName, aliasMap, usedTables, consumed, names };
}

/** true when the comma at index i separates FROM-clause tables (not select-list items) */
function inFromChain(tokens, i) {
  const d = tokens[i].depth;
  for (let j = i - 1; j >= 0; j--) {
    const t = tokens[j];
    if (t.depth < d) return false;
    if (t.depth > d) continue;
    if (isKw(t, 'from') || isKw(t, 'join')) return true;
    if (isKw(t, 'select') || isKw(t, 'where') || isKw(t, 'group') || isKw(t, 'order') || isKw(t, 'on') || isKw(t, 'having')) return false;
  }
  return false;
}

function findUnknownColumns(sql, schema) {
  const tokens = tokenize(sql);
  const scope = buildScope(tokens, schema);
  const scopeTables = scope.usedTables.size ? [...scope.usedTables].map((n) => scope.tableByName.get(lc(n))) : schema.tables;
  const bareColumns = new Set();
  scopeTables.forEach((t) => t.columns.forEach((c) => bareColumns.add(lc(c.name))));

  const unknown = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (!isIdentTok(tk) || scope.consumed.has(i)) continue;
    if (tk.t === 'word' && KEYWORDS.has(lc(tk.v))) continue;
    const next = tokens[i + 1], prev = tokens[i - 1];
    if (next && next.v === '(' && tk.t === 'word') continue;                    // function call
    if (next && next.v === '.' && next.t === 'p') continue;                     // qualifier
    if (isKw(prev, 'as')) continue;                                              // alias / cast type
    if (prev && prev.v === '::' && prev.t === 'p') continue;                     // PG cast type
    const nm = lc(tk.v);

    if (prev && prev.v === '.' && prev.t === 'p') {
      const q = tokens[i - 2];
      const table = q && scope.aliasMap.get(lc(q.v));
      if (table && !table.columns.some((c) => lc(c.name) === nm)) unknown.push({ name: tk.v, qualifier: q.v, index: i, start: tk.s, end: tk.e });
      continue;
    }
    if (tk.t === 'qid' && next && (next.v === ')' || next.v === ',') && isStringContext(tokens, i)) continue;
    if (bareColumns.has(nm) || scope.names.has(nm) || scope.aliasMap.has(nm) || scope.tableByName.has(nm)) continue;
    unknown.push({ name: tk.v, qualifier: null, index: i, start: tk.s, end: tk.e });
  }
  return unknown;
}

// SQLite lets "double quoted" text act as a string literal; treat it as unknown only if it looks like a column.
function isStringContext(tokens, i) {
  const prev = tokens[i - 1];
  return prev && ['=', 'in', '(', ','].includes(lc(prev.v)) && tokens[i].t === 'qid' && /\s/.test(tokens[i].v);
}

function repairColumnNames(sql, schema) {
  const unknown = findUnknownColumns(sql, schema);
  if (!unknown.length) return { sql, repaired: false, corrections: [], unresolved: [] };
  const tokens = tokenize(sql);
  const scope = buildScope(tokens, schema);
  const pool = (scope.usedTables.size ? [...scope.usedTables] : schema.tables.map((t) => t.name))
    .flatMap((n) => scope.tableByName.get(lc(n)).columns.map((c) => c.name));

  const corrections = [];
  const unresolved = [];
  let out = sql;
  for (const u of [...unknown].sort((a, b) => b.start - a.start)) {
    let candidates = pool;
    if (u.qualifier) {
      const table = scope.aliasMap.get(lc(u.qualifier));
      if (table) candidates = table.columns.map((c) => c.name);
    }
    const fix = closestMatch(u.name, candidates);
    if (fix) {
      const original = out.slice(u.start, u.end);
      const quoted = original.startsWith('"') || original.startsWith('`') ? original[0] + fix + original[0] : fix;
      out = out.slice(0, u.start) + quoted + out.slice(u.end);
      corrections.push({ from: u.name, to: fix });
    } else {
      unresolved.push({ name: u.name, suggestions: candidates.slice(0, 8) });
    }
  }
  return { sql: out, repaired: corrections.length > 0, corrections: corrections.reverse(), unresolved };
}

/** Adds GROUP BY for aggregate queries that mix aggregates with bare columns (SQLite silently returns wrong rows). */
function repairMissingGroupBy(sql) {
  const tokens = tokenize(sql);
  const top = tokens.filter((t) => t.depth === 0);
  if (top.some((t) => isKw(t, 'group') || isKw(t, 'union') || isKw(t, 'intersect') || isKw(t, 'except'))) return { sql, repaired: false };
  const selIdx = tokens.findIndex((t) => isKw(t, 'select') && t.depth === 0);
  const fromIdx = tokens.findIndex((t) => isKw(t, 'from') && t.depth === 0);
  if (selIdx !== 0 || fromIdx < 0) return { sql, repaired: false };

  // split select list on top-level commas
  const items = [];
  let cur = [];
  for (let i = selIdx + 1; i < fromIdx; i++) {
    const t = tokens[i];
    if (t.depth === 0 && t.v === ',' && t.t === 'p') { items.push(cur); cur = []; } else cur.push(t);
  }
  items.push(cur);

  let hasAgg = false, hasOver = false;
  const plain = [];
  let nonAggComplex = false;
  for (const item of items) {
    if (!item.length) continue;
    const isAgg = item.some((t, k) => t.t === 'word' && AGGREGATES.has(lc(t.v)) && item[k + 1]?.v === '(');
    if (item.some((t) => isKw(t, 'over'))) hasOver = true;
    if (isAgg) { hasAgg = true; continue; }
    // strip alias
    const asIdx = item.findIndex((t) => isKw(t, 'as'));
    const expr = asIdx >= 0 ? item.slice(0, asIdx) : item;
    if (expr.length === 1 && expr[0].v === '*') { nonAggComplex = true; continue; }
    const simple = expr.length === 1 && isIdentTok(expr[0]) || (expr.length === 3 && isIdentTok(expr[0]) && expr[1].v === '.' && isIdentTok(expr[2]));
    if (simple) plain.push(sql.slice(expr[0].s, expr[expr.length - 1].e));
    else nonAggComplex = true;
  }
  if (!hasAgg || hasOver || nonAggComplex || plain.length === 0) return { sql, repaired: false };

  const tail = tokens.find((t, i) => i > fromIdx && t.depth === 0 && (isKw(t, 'having') || isKw(t, 'order') || isKw(t, 'limit') || isKw(t, 'window')));
  const insertAt = tail ? tail.s : sql.length;
  const groupBy = ` GROUP BY ${plain.join(', ')} `;
  const out = (sql.slice(0, insertAt).trimEnd() + groupBy + sql.slice(insertAt).trimStart()).trim();
  return { sql: out, repaired: true, groupBy: plain };
}

/** Names defined by a leading WITH [RECURSIVE] a AS (...), b AS (...) clause. */
function extractCteNames(sql) {
  const tokens = tokenize(sql);
  const names = [];
  if (!isKw(tokens[0], 'with')) return names;
  let i = 1;
  if (isKw(tokens[i], 'recursive')) i++;
  for (;;) {
    const nameTok = tokens[i];
    if (!isIdentTok(nameTok)) break;
    names.push(nameTok.v);
    i++;
    if (tokens[i]?.v === '(') { // optional column list
      let d = tokens[i].depth;
      i++;
      while (i < tokens.length && !(tokens[i].v === ')' && tokens[i].depth === d)) i++;
      i++;
    }
    if (!isKw(tokens[i], 'as')) break;
    i++;
    if (isKw(tokens[i], 'not')) i++;
    if (isKw(tokens[i], 'materialized')) i++;
    if (tokens[i]?.v !== '(') break;
    const d = tokens[i].depth;
    i++;
    while (i < tokens.length && !(tokens[i].v === ')' && tokens[i].depth === d)) i++;
    i++;
    if (tokens[i]?.v === ',') { i++; continue; }
    break;
  }
  return names;
}

module.exports = { tokenize, findUnknownColumns, repairColumnNames, repairMissingGroupBy, extractCteNames, KEYWORDS };
