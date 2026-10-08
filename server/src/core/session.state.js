/**
 * CONVERSATION STATE STORE (Features 6 & 7)
 * One small JSON document per chat session: previous question/SQL/result preview,
 * active filters and time period. Bounded in size; lives in the registry DB.
 */
const { getRegistryDb } = require('../config/registry.db');

const DDL = `CREATE TABLE IF NOT EXISTS session_state (session_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);`;
const db = () => getRegistryDb('session_state', (d) => d.exec(DDL));

function getState(sessionId) {
  const row = db().prepare(`SELECT state_json FROM session_state WHERE session_id = ?`).get(sessionId);
  if (!row) return {};
  try { return JSON.parse(row.state_json); } catch (_) { return {}; }
}

function saveState(sessionId, state) {
  const json = JSON.stringify(state).slice(0, 8000);
  db().prepare(`INSERT INTO session_state (session_id, state_json, updated_at) VALUES (?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
    .run(sessionId, json, new Date().toISOString());
}

module.exports = { getState, saveState };
