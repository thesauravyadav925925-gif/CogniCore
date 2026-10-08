/**
 * JOIN PLANNER (Feature 5: multi-table reasoning)
 * Treats detected relationships as an undirected graph and finds the shortest
 * join chain between any two tables, so the LLM is handed ready-made JOIN
 * conditions instead of having to discover them:
 *   customers -> orders -> order_items -> products
 * Pure functions; no domain knowledge.
 */
function buildGraph(relationships) {
  const g = new Map();
  const add = (a, b, rel) => {
    if (!g.has(a)) g.set(a, []);
    g.get(a).push({ to: b, rel });
  };
  for (const r of relationships) {
    add(r.fromTable, r.toTable, r);
    add(r.toTable, r.fromTable, r);
  }
  return g;
}

function shortestJoinPath(relationships, from, to) {
  if (from === to) return [];
  const g = buildGraph(relationships);
  const q = [[from, []]];
  const seen = new Set([from]);
  while (q.length) {
    const [node, path] = q.shift();
    for (const edge of g.get(node) || []) {
      if (seen.has(edge.to)) continue;
      const next = [...path, edge.rel];
      if (edge.to === to) return next;
      seen.add(edge.to);
      q.push([edge.to, next]);
    }
  }
  return null;
}

const cond = (r) => `"${r.fromTable}"."${r.fromColumn}" = "${r.toTable}"."${r.toColumn}"`;

/** Tables the question probably refers to (by table or column name appearing in it). */
function selectRelevantTables(question, schema) {
  const words = new Set(String(question).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(s)$/, '');
  const stems = new Set([...words].map(stem));
  const hits = [];
  for (const t of schema.tables) {
    const tn = t.name.toLowerCase().split(/[^a-z0-9]+/).map(stem);
    let score = tn.some((p) => stems.has(p)) ? 2 : 0;
    for (const c of t.columns) {
      const cn = c.name.toLowerCase().split(/[^a-z0-9]+/).map(stem).filter((p) => p.length > 2 && p !== 'id');
      if (cn.some((p) => stems.has(p))) score += 1;
    }
    if (score > 0) hits.push({ name: t.name, score });
  }
  return hits.sort((a, b) => b.score - a.score).map((h) => h.name);
}

function renderJoinHints(question, schema, relationships) {
  if (schema.tables.length < 2 || !relationships.length) return '';
  const relevant = selectRelevantTables(question, schema).slice(0, 5);
  const lines = [];
  const seen = new Set();
  for (let i = 0; i < relevant.length; i++) {
    for (let j = i + 1; j < relevant.length; j++) {
      const path = shortestJoinPath(relationships, relevant[i], relevant[j]);
      if (!path || !path.length) continue;
      const key = path.map(cond).join(' AND ');
      if (seen.has(key)) continue;
      seen.add(key);
      const chain = [relevant[i], ...path.map((r) => (r.fromTable === relevant[i] || lines.length ? r.toTable : r.fromTable))];
      lines.push(`To combine "${relevant[i]}" with "${relevant[j]}": JOIN using ${path.map(cond).join(' AND ')} (via ${[...new Set(path.flatMap((r) => [r.fromTable, r.toTable]))].join(' -> ')})`);
    }
  }
  if (!lines.length && schema.tables.length <= 6) {
    relationships.forEach((r) => lines.push(`"${r.fromTable}" joins "${r.toTable}" on ${cond(r)}`));
  }
  return lines.join('\n');
}

module.exports = { shortestJoinPath, selectRelevantTables, renderJoinHints, buildGraph };
