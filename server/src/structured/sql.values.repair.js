/**
 * VALUE-LITERAL REPAIR (Feature 17/19)
 * Fixes filters like  status = 'cancelled'  when the data holds  'Cancelled'
 * (or 'No show' vs 'No-show'), using the *measured* distinct values from the
 * semantic model. Only substitutes toward a value that provably exists.
 * The same probe powers the "empty result caused by capitalisation" check.
 */
const { tokenize } = require('./sql.analyzer');
const { norm, closestMatch } = require('../utils/strings');

/** Map of lower-cased column name -> array of known string values (only for low-cardinality columns). */
function buildValueIndex(semantic) {
  const idx = new Map();
  for (const t of semantic?.tables || []) {
    for (const c of t.columns) {
      if (!c.values?.length || c.stats?.distinct > c.values.length) continue;
      const key = c.name.toLowerCase();
      const vals = c.values.map((v) => String(v.value));
      idx.set(key, [...new Set([...(idx.get(key) || []), ...vals])]);
    }
  }
  return idx;
}

function resolveLiteral(literal, known) {
  if (known.includes(literal)) return null;                                   // already exact
  const ci = known.find((k) => k.toLowerCase().trim() === literal.toLowerCase().trim());
  if (ci) return ci;
  const nm = known.find((k) => norm(k) === norm(literal));
  if (nm) return nm;
  return closestMatch(literal, known, { maxDistance: literal.length >= 6 ? 2 : 1 });
}

function repairValueLiterals(sql, semantic) {
  const idx = buildValueIndex(semantic);
  if (!idx.size) return { sql, repaired: false, corrections: [] };
  const tokens = tokenize(sql);
  const edits = [];

  const colName = (tok) => (tok && (tok.t === 'word' || tok.t === 'qid') ? tok.v.toLowerCase() : null);

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (!(tk.t === 'word' || tk.t === 'qid')) continue;
    const key = colName(tk);
    if (!key || !idx.has(key)) continue;
    const known = idx.get(key);
    const op = tokens[i + 1];
    if (op && op.t === 'p' && ['=', '!=', '<>'].includes(op.v) && tokens[i + 2]?.t === 'str') {
      const lit = tokens[i + 2];
      const fix = resolveLiteral(lit.v, known);
      if (fix !== null && fix !== undefined) edits.push({ s: lit.s, e: lit.e, to: `'${fix.replace(/'/g, "''")}'`, from: lit.v, column: tk.v, value: fix });
    } else if (op && op.t === 'word' && op.v.toLowerCase() === 'in' && tokens[i + 2]?.v === '(') {
      for (let j = i + 3; j < tokens.length && tokens[j].v !== ')'; j++) {
        if (tokens[j].t !== 'str') continue;
        const fix = resolveLiteral(tokens[j].v, known);
        if (fix !== null && fix !== undefined) edits.push({ s: tokens[j].s, e: tokens[j].e, to: `'${fix.replace(/'/g, "''")}'`, from: tokens[j].v, column: tk.v, value: fix });
      }
    }
  }
  if (!edits.length) return { sql, repaired: false, corrections: [] };
  let out = sql;
  for (const ed of edits.sort((a, b) => b.s - a.s)) out = out.slice(0, ed.s) + ed.to + out.slice(ed.e);
  return { sql: out, repaired: true, corrections: edits.map((e) => ({ column: e.column, from: e.from, to: e.value })) };
}

/** Lists (column, literal) equality filters in a query - used to diagnose empty results. */
function listStringFilters(sql) {
  const tokens = tokenize(sql);
  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if ((tk.t === 'word' || tk.t === 'qid') && tokens[i + 1]?.t === 'p' && ['=', '!=', '<>'].includes(tokens[i + 1].v) && tokens[i + 2]?.t === 'str') {
      found.push({ column: tk.v, literal: tokens[i + 2].v });
    }
  }
  return found;
}

module.exports = { repairValueLiterals, buildValueIndex, listStringFilters, resolveLiteral };
