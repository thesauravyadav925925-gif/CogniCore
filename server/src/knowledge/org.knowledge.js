/**
 * PERSISTENT ORGANIZATIONAL KNOWLEDGE (Level 3)
 * Business definitions that survive across sessions and users, e.g.
 *   "Active customer" = "a customer with at least one order in the last 90 days"
 *   "Revenue"         = "sum of amount where status is Completed"
 * They are injected into the SQL-generation prompt as authoritative context.
 * Scope: a specific dataset, or '*' for every dataset in the organization.
 * Managed by managers/admins; every change is audit-logged by the route.
 */
const { getRegistryDb } = require('../config/registry.db');
const { v4: uuidv4 } = require('uuid');

const DDL = `
  CREATE TABLE IF NOT EXISTS org_knowledge (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT '*',      -- dataset_id or '*'
    kind TEXT NOT NULL DEFAULT 'glossary',-- glossary | metric | rule | fact
    term TEXT NOT NULL,
    definition TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
`;
const getDb = () => getRegistryDb('knowledge', (d) => d.exec(DDL));

const KINDS = ['glossary', 'metric', 'rule', 'fact'];

const OrgKnowledge = {
  add({ scope = '*', kind = 'glossary', term, definition, createdBy = null }) {
    if (!term || !definition) throw new Error('term and definition are required');
    if (!KINDS.includes(kind)) throw new Error(`kind must be one of: ${KINDS.join(', ')}`);
    const id = 'kn_' + uuidv4().slice(0, 8);
    getDb().prepare(`INSERT INTO org_knowledge VALUES (?,?,?,?,?,?,?)`)
      .run(id, scope, kind, String(term).slice(0, 120), String(definition).slice(0, 1000), createdBy, new Date().toISOString());
    return id;
  },
  list(datasetId = null) {
    const rows = datasetId
      ? getDb().prepare(`SELECT * FROM org_knowledge WHERE scope IN ('*', ?) ORDER BY created_at`).all(datasetId)
      : getDb().prepare(`SELECT * FROM org_knowledge ORDER BY created_at`).all();
    return rows;
  },
  remove(id) { getDb().prepare(`DELETE FROM org_knowledge WHERE id = ?`).run(id); },

  /** Text block for prompts: entries whose term appears in the question, or all if the set is small. */
  renderForPrompt(datasetId, question = '') {
    const all = this.list(datasetId);
    if (!all.length) return '';
    const q = String(question).toLowerCase();
    const relevant = all.filter((k) => q.includes(k.term.toLowerCase()) || k.kind === 'rule');
    const chosen = (relevant.length ? relevant : all.slice(0, 8)).slice(0, 12);
    return chosen.map((k) => `- ${k.term}: ${k.definition}`).join('\n');
  },
};

module.exports = { OrgKnowledge, KINDS };
