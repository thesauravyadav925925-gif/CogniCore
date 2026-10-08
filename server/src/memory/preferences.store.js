/**
 * USER PREFERENCES MEMORY (blueprint #19)
 * Remembers *how* a user likes answers presented. Hard rule: preferences are FORMATTING ONLY.
 * They are whitelisted, enum-validated, and injected into the prompt as a style hint that the
 * prompt itself declares can never change rules - so memory can never override security policy.
 */
const { getRegistryDb } = require('../config/registry.db');

const DDL = `CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, key));`;
const db = () => getRegistryDb('user_prefs', (d) => d.exec(DDL));

const SCHEMA = {
  output_format: { values: ['default', 'concise', 'detailed', 'bullets', 'table'], hint: { concise: 'Answer in one or two sentences.', detailed: 'Give a thorough explanation of the numbers, still using only the evidence.', bullets: 'Use short bullet points.', table: 'Present multi-row results as a compact markdown table.' } },
  detail_level: { values: ['default', 'brief', 'standard', 'deep'], hint: { brief: 'Keep it brief.', deep: 'Include the supporting numbers for each claim.' } },
  default_chart: { values: ['auto', 'bar', 'line', 'pie'], hint: {} },
};

const Preferences = {
  SCHEMA,
  get(userId) {
    const out = Object.fromEntries(Object.keys(SCHEMA).map((k) => [k, SCHEMA[k].values[0]]));
    if (!userId) return out;
    for (const r of db().prepare(`SELECT key, value FROM user_preferences WHERE user_id = ?`).all(userId)) if (SCHEMA[r.key]?.values.includes(r.value)) out[r.key] = r.value;
    return out;
  },
  set(userId, patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!SCHEMA[k]) throw new Error(`Unknown preference "${k}". Allowed: ${Object.keys(SCHEMA).join(', ')}.`);
      if (!SCHEMA[k].values.includes(v)) throw new Error(`"${v}" is not valid for ${k}. Allowed: ${SCHEMA[k].values.join(', ')}.`);
      db().prepare(`INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(userId, k, v, new Date().toISOString());
    }
    return this.get(userId);
  },
  /** Prompt hint text (formatting only), or null when everything is default. */
  toPromptText(userId) {
    const p = this.get(userId);
    const hints = ['output_format', 'detail_level'].map((k) => SCHEMA[k].hint[p[k]]).filter(Boolean);
    return hints.length ? hints.join(' ') : null;
  },
};

module.exports = { Preferences };
