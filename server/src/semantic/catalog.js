/**
 * SEMANTIC DATA CATALOG (blueprint #4)
 * A metadata layer above the raw data: for each dataset a "card" (owner, source, type, freshness,
 * quality score), its entities (tables), attributes (columns with role + business meaning) and
 * relationships. Built from facts already measured at ingestion; nothing is guessed by an LLM.
 */
const { AuthRegistry } = require('../security/auth.registry');
const { Meanings } = require('./meanings.store');
const { isColumnDenied } = require('../agent/safe.query');

function hostOf(location) { try { return new URL(location).host; } catch (_) { return null; } }

function freshness(dataset, semantic) {
  let latest = null;
  for (const t of semantic?.tables || []) for (const c of t.columns) if (c.role === 'temporal' && c.stats?.max) { const v = String(c.stats.max); if (!latest || v > latest) latest = v; }
  return { ingested_at: dataset.updated_at || dataset.created_at || null, latest_record_date: latest };
}

function buildCatalog({ dataset, policy = null }) {
  const semantic = dataset.profile?.semantic;
  const owner = dataset.owner_id ? AuthRegistry.getUserById(dataset.owner_id) : null;
  const meanings = new Map(Meanings.list(dataset.dataset_id).map((m) => [`${m.table_name}.${m.column_name}`.toLowerCase(), m]));
  const relationships = dataset.profile?.relationships || semantic?.relationships || [];
  const entities = (semantic?.tables || []).map((t) => {
    const attrs = t.columns.filter((c) => !isColumnDenied(policy, t.name, c.name)).map((c) => {
      const m = meanings.get(`${t.name}.${c.name}`.toLowerCase());
      return {
        name: c.name, role: c.role, sql_type: c.sqlType, pii: c.pii || null,
        auto_description: c.description?.replace(/^[^:]+:\s*/, '').split(';')[0] || c.role,
        business_meaning: m?.meaning || null, meaning_by: m?.updated_by || null,
        distinct: c.stats?.distinct, missing: c.stats?.missing, min: c.stats?.min ?? null, max: c.stats?.max ?? null,
        values: c.role === 'categorical' ? (c.values || []).slice(0, 8).map((v) => v.value) : undefined,
      };
    });
    const key = t.columns.find((c) => c.role === 'identifier');
    return { entity: t.name, rows: t.rowCount, key: key?.name || null, attributes: attrs, relationships: relationships.filter((r) => r.fromTable === t.name || r.toTable === t.name) };
  });
  const documentInfo = !semantic ? { sections: dataset.profile?.sections || [], pages: dataset.profile?.pageCount ?? null } : null;
  return {
    dataset: {
      dataset_id: dataset.dataset_id, name: dataset.name, type: dataset.type, status: dataset.status,
      owner: owner ? { name: owner.name || owner.email, email: owner.email } : null,
      source: { kind: dataset.source, host: dataset.source === 'connection' ? hostOf(dataset.location) : null },
      freshness: freshness(dataset, semantic),
      quality_score: dataset.profile?.quality?.overallScore ?? null,
      tables: entities.length, total_rows: entities.reduce((s, e) => s + (e.rows || 0), 0),
      annotated_attributes: [...meanings.keys()].length,
    },
    entities, relationships, document: documentInfo,
  };
}

module.exports = { buildCatalog };
