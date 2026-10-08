/**
 * DATASET REGISTRY
 * ------------------------------------------------------------------
 * Every dataset CogniCore ever touches gets an internal identity here.
 * This file owns NO domain knowledge - it only stores what type of
 * dataset it is, where it lives, and what its (dynamically discovered)
 * schema looks like.
 *
 * RULE #2: Never hardcode table names.
 * RULE #5: Never assume the dataset's domain.
 * ------------------------------------------------------------------
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');

fs.mkdirSync(config.paths.data, { recursive: true });
fs.mkdirSync(config.paths.uploads, { recursive: true });

const db = new Database(config.paths.registryDb);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS datasets (
    dataset_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,          -- sqlite | postgres | mysql | csv | xlsx | json | pdf | docx | txt
    source TEXT NOT NULL,        -- upload | connection
    location TEXT,               -- file path or connection string reference
    status TEXT NOT NULL DEFAULT 'processing', -- processing | ready | error
    schema_json TEXT,            -- dynamically discovered schema (JSON)
    profile_json TEXT,           -- dataset profile / stats (JSON)
    error_message TEXT,
    owner_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT,
    active_dataset_id TEXT,
    state_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Connection credentials are kept in a SEPARATE table from "datasets"
  -- and are NEVER included in _hydrate()/API responses (Rule #10: never
  -- expose secrets to the frontend). Only used internally by adapters.
  CREATE TABLE IF NOT EXISTS connection_credentials (
    dataset_id TEXT PRIMARY KEY,
    credentials_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversation_turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,          -- user | assistant
    content TEXT NOT NULL,
    evidence_json TEXT,
    created_at TEXT NOT NULL
  );
`);

function now() {
  return new Date().toISOString();
}

const DatasetRegistry = {
  /** Register a brand-new dataset. Returns the created record. */
  create({ name, type, source, location, ownerId = null }) {
    const dataset_id = 'ds_' + uuidv4().slice(0, 8);
    const ts = now();
    db.prepare(`
      INSERT INTO datasets (dataset_id, name, type, source, location, status, owner_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?)
    `).run(dataset_id, name, type, source, location, ownerId, ts, ts);
    return this.get(dataset_id);
  },

  /** Mark a dataset ready and attach its discovered schema + profile. */
  markReady(datasetId, { schema, profile }) {
    db.prepare(`
      UPDATE datasets
      SET status = 'ready', schema_json = ?, profile_json = ?, updated_at = ?
      WHERE dataset_id = ?
    `).run(JSON.stringify(schema || {}), JSON.stringify(profile || {}), now(), datasetId);
    return this.get(datasetId);
  },

  markError(datasetId, message) {
    db.prepare(`
      UPDATE datasets SET status = 'error', error_message = ?, updated_at = ? WHERE dataset_id = ?
    `).run(String(message), now(), datasetId);
    return this.get(datasetId);
  },

  get(datasetId) {
    const row = db.prepare(`SELECT * FROM datasets WHERE dataset_id = ?`).get(datasetId);
    return row ? this._hydrate(row) : null;
  },

  list(ownerId = null) {
    const rows = ownerId
      ? db.prepare(`SELECT * FROM datasets WHERE owner_id = ? ORDER BY created_at DESC`).all(ownerId)
      : db.prepare(`SELECT * FROM datasets ORDER BY created_at DESC`).all();
    return rows.map(this._hydrate);
  },

  remove(datasetId) {
    db.prepare(`DELETE FROM datasets WHERE dataset_id = ?`).run(datasetId);
    db.prepare(`DELETE FROM connection_credentials WHERE dataset_id = ?`).run(datasetId);
  },

  // ---- Connection credentials (Postgres/MySQL). Internal use ONLY. ----
  // RULE #10: never expose secrets to the frontend. No public route ever
  // calls getCredentials() - only adapters, server-side.
  storeCredentials(datasetId, credentials) {
    db.prepare(`
      INSERT INTO connection_credentials (dataset_id, credentials_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(dataset_id) DO UPDATE SET credentials_json = excluded.credentials_json
    `).run(datasetId, JSON.stringify(credentials), now());
  },

  getCredentials(datasetId) {
    const row = db.prepare(`SELECT credentials_json FROM connection_credentials WHERE dataset_id = ?`).get(datasetId);
    return row ? JSON.parse(row.credentials_json) : null;
  },

  _hydrate(row) {
    return {
      dataset_id: row.dataset_id,
      name: row.name,
      type: row.type,
      source: row.source,
      location: row.location,
      status: row.status,
      schema: row.schema_json ? JSON.parse(row.schema_json) : null,
      profile: row.profile_json ? JSON.parse(row.profile_json) : null,
      error_message: row.error_message,
      owner_id: row.owner_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  },

  // ---- Session / conversation memory (bounded) ----
  createSession(userId = null) {
    const session_id = 'sess_' + uuidv4().slice(0, 8);
    const ts = now();
    db.prepare(`
      INSERT INTO sessions (session_id, user_id, active_dataset_id, state_json, created_at, updated_at)
      VALUES (?, ?, NULL, '{}', ?, ?)
    `).run(session_id, userId, ts, ts);
    return this.getSession(session_id);
  },

  getSession(sessionId) {
    const row = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId);
    if (!row) return null;
    return {
      session_id: row.session_id,
      user_id: row.user_id,
      active_dataset_id: row.active_dataset_id,
      state: row.state_json ? JSON.parse(row.state_json) : {},
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  },

  updateSession(sessionId, { activeDatasetId, state }) {
    const existing = this.getSession(sessionId);
    if (!existing) return null;
    const nextDatasetId = activeDatasetId !== undefined ? activeDatasetId : existing.active_dataset_id;
    const nextState = state !== undefined ? state : existing.state;
    db.prepare(`
      UPDATE sessions SET active_dataset_id = ?, state_json = ?, updated_at = ? WHERE session_id = ?
    `).run(nextDatasetId, JSON.stringify(nextState || {}), now(), sessionId);
    return this.getSession(sessionId);
  },

  appendTurn(sessionId, role, content, evidence = null) {
    const turn_id = 'turn_' + uuidv4().slice(0, 8);
    db.prepare(`
      INSERT INTO conversation_turns (turn_id, session_id, role, content, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(turn_id, sessionId, role, content, evidence ? JSON.stringify(evidence) : null, now());
    return turn_id;
  },

  /** Bounded recent history (Rule: memory should be bounded and controlled). */
  getRecentTurns(sessionId, limit = 8) {
    const rows = db.prepare(`
      SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(sessionId, limit);
    return rows.reverse().map(r => ({
      role: r.role,
      content: r.content,
      evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null,
      created_at: r.created_at,
    }));
  },
};

module.exports = { DatasetRegistry, _db: db };
