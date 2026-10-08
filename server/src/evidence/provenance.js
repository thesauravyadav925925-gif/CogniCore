/**
 * PROVENANCE (blueprint item 14): "Where did this answer come from?"
 * Built deterministically from the executed query + schema; nothing here is LLM-written.
 *   source, dataset, tables, columns, query, calculation, rows scanned/returned, timestamp.
 */
const { tokenize } = require('../structured/sql.analyzer');

const lc = (s) => String(s).toLowerCase();
const AGG = { count: 'count of records', sum: 'total', avg: 'average', min: 'minimum', max: 'maximum' };

function columnsUsed(sql, schema) {
  const tokens = tokenize(sql || '');
  const names = new Set(tokens.filter((t) => t.t === 'word' || t.t === 'qid').map((t) => lc(t.v)));
  const tablesInQuery = schema.tables.filter((t) => names.has(lc(t.name)));
  const scope = tablesInQuery.length ? tablesInQuery : schema.tables;
  const out = [];
  for (const t of scope) for (const c of t.columns) if (names.has(lc(c.name))) out.push(`${t.name}.${c.name}`);
  return out;
}

/** Plain-English description of the calculation derived from the SQL structure. */
function describeCalculation(sql) {
  if (!sql || sql.startsWith('(')) return null;
  const tokens = tokenize(sql);
  const parts = [];
  const aggs = [];
  tokens.forEach((t, i) => {
    if (t.t === 'word' && AGG[lc(t.v)] && tokens[i + 1]?.v === '(') {
      const arg = tokens[i + 2];
      aggs.push(lc(t.v) === 'count' ? 'count of records' : `${AGG[lc(t.v)]} of ${arg ? String(arg.v).replace(/^["`]|["`]$/g, '') : 'values'}`);
    }
  });
  if (aggs.length) parts.push([...new Set(aggs)].join(', '));
  const top = tokens.filter((t) => t.depth === 0);
  const idx = (kw) => top.findIndex((t) => t.t === 'word' && lc(t.v) === kw);
  const grab = (kw, stops) => {
    const i = idx(kw); if (i < 0) return null;
    const out = [];
    for (let j = i + 1; j < top.length; j++) { if (top[j].t === 'word' && stops.includes(lc(top[j].v))) break; out.push(sql.slice(top[j].s, top[j].e)); }
    return out.join(' ').replace(/\s+,/g, ',');
  };
  const where = grab('where', ['group', 'order', 'having', 'limit']);
  const group = idx('group') >= 0 ? grab('by', ['order', 'having', 'limit']) : null;
  if (where) parts.push(`filtered where ${where.slice(0, 120)}`);
  if (group) parts.push(`grouped by ${group.slice(0, 80)}`);
  if (/\bOVER\s*\(/i.test(sql)) parts.push('using window functions');
  if (/\bJOIN\b/i.test(sql)) parts.push('joining related tables');
  return parts.length ? parts.join('; ') : 'direct selection of matching records';
}

function buildProvenance({ dataset, sql, schema, tablesUsed = [], rowsReturned = 0, extra = {} }) {
  const rowsScanned = tablesUsed.reduce((s, n) => s + (schema.tables.find((t) => lc(t.name) === lc(n))?.rowCount || 0), 0);
  return {
    source: dataset.name, dataset_id: dataset.dataset_id, source_type: dataset.type,
    tables: tablesUsed, columns: columnsUsed(sql, schema),
    query: sql || null, calculation: describeCalculation(sql),
    rows_scanned: rowsScanned, rows_returned: rowsReturned,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

module.exports = { buildProvenance, columnsUsed, describeCalculation };
