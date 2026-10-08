/**
 * BUSINESS MEANINGS (blueprint #4: semantic catalog - "business meanings")
 * Humans can tell CogniCore what a column MEANS ("attendance_percentage = percentage of attended
 * classes"). A user-written meaning always overrides the auto-detected description, and is
 * injected into the SQL-generation prompt, which makes natural-language querying more reliable.
 */
const { getRegistryDb } = require('../config/registry.db');

const DDL = `CREATE TABLE IF NOT EXISTS column_meanings (
  dataset_id TEXT NOT NULL, table_name TEXT NOT NULL, column_name TEXT NOT NULL, meaning TEXT NOT NULL,
  updated_by TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (dataset_id, table_name, column_name));`;
const db = () => getRegistryDb('column_meanings', (d) => d.exec(DDL));

const Meanings = {
  list(datasetId) { return db().prepare(`SELECT * FROM column_meanings WHERE dataset_id = ?`).all(datasetId); },
  set({ datasetId, table, column, meaning, userId = null }) {
    const m = String(meaning || '').trim().slice(0, 400);
    if (!m) throw new Error('A meaning is required.');
    db().prepare(`INSERT INTO column_meanings VALUES (?,?,?,?,?,?) ON CONFLICT(dataset_id, table_name, column_name) DO UPDATE SET meaning = excluded.meaning, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(datasetId, table, column, m, userId, new Date().toISOString());
  },
  remove(datasetId, table, column) { db().prepare(`DELETE FROM column_meanings WHERE dataset_id = ? AND table_name = ? AND column_name = ?`).run(datasetId, table, column); },
};

/** Returns a copy of the semantic model whose column descriptions use the human meanings where present. */
function applyMeanings(semantic, meanings) {
  if (!semantic || !meanings?.length) return semantic;
  const idx = new Map(meanings.map((m) => [`${m.table_name}.${m.column_name}`.toLowerCase(), m.meaning]));
  return {
    ...semantic,
    tables: semantic.tables.map((t) => ({
      ...t,
      columns: t.columns.map((c) => {
        const m = idx.get(`${t.name}.${c.name}`.toLowerCase());
        if (!m) return c;
        const vals = c.role === 'categorical' && c.values?.length ? `; possible values: ${c.values.slice(0, 12).map((v) => v.value).join(' | ')}` : '';
        return { ...c, business_meaning: m, description: `${c.name}: ${m}${vals}` };
      }),
    })),
  };
}

module.exports = { Meanings, applyMeanings };
