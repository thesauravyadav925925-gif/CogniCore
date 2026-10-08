/**
 * AUTH REGISTRY
 * ------------------------------------------------------------------
 * Owns three things, kept deliberately separate from dataset.registry.js:
 *   - users (identity + role)
 *   - dataset_permissions (who can access which dataset, beyond ownership)
 *   - audit_log (append-only record of security-relevant actions)
 *
 * RULE #9: Enforce permissions outside the LLM. Every function here is
 * plain deterministic SQL - the LLM is never involved in deciding who can
 * see what.
 * ------------------------------------------------------------------
 */
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');

require('fs').mkdirSync(require('path').dirname(config.paths.registryDb), { recursive: true });
const db = new Database(config.paths.registryDb);
db.pragma('journal_mode = WAL');

const ROLES = ['admin', 'manager', 'analyst', 'employee', 'viewer', 'user'];

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'user', -- admin | manager | analyst | employee | viewer | user (legacy = analyst)
    created_at TEXT NOT NULL
  );

  -- Explicit grants on top of ownership. A dataset's owner (datasets.owner_id)
  -- always has full access; this table covers sharing beyond that.
  CREATE TABLE IF NOT EXISTS dataset_permissions (
    dataset_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    permission TEXT NOT NULL,   -- 'read' (query/chat) | 'manage' (also delete/reshare)
    granted_by TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (dataset_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    action TEXT NOT NULL,          -- e.g. 'auth.login', 'dataset.upload', 'chat.query', 'dataset.delete'
    resource_type TEXT,            -- 'dataset' | 'user' | null
    resource_id TEXT,
    success INTEGER NOT NULL DEFAULT 1,
    details_json TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id);
`);

function now() { return new Date().toISOString(); }

const AuthRegistry = {
  ROLES,

  countUsers() {
    return db.prepare(`SELECT COUNT(*) AS c FROM users`).get().c;
  },

  createUser({ email, passwordHash, name, role }) {
    const user_id = 'usr_' + uuidv4().slice(0, 8);
    db.prepare(`
      INSERT INTO users (user_id, email, password_hash, name, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user_id, email.toLowerCase().trim(), passwordHash, name || null, role, now());
    return this.getUserById(user_id);
  },

  getUserByEmail(email) {
    const row = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase().trim());
    return row || null;
  },

  getUserById(userId) {
    const row = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(userId);
    return row ? this._sanitizeUser(row) : null;
  },

  listUsers() {
    return db.prepare(`SELECT * FROM users ORDER BY created_at ASC`).all().map(this._sanitizeUser);
  },

  updateUserRole(userId, role) {
    if (!ROLES.includes(role)) throw new Error(`Invalid role "${role}". Must be one of: ${ROLES.join(', ')}`);
    db.prepare(`UPDATE users SET role = ? WHERE user_id = ?`).run(role, userId);
    return this.getUserById(userId);
  },

  _sanitizeUser(row) {
    // NEVER return password_hash to any API caller.
    const { password_hash, ...safe } = row;
    return safe;
  },

  // ---- Dataset permissions ----
  grantAccess(datasetId, userId, permission, grantedBy) {
    db.prepare(`
      INSERT INTO dataset_permissions (dataset_id, user_id, permission, granted_by, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(dataset_id, user_id) DO UPDATE SET permission = excluded.permission, granted_by = excluded.granted_by
    `).run(datasetId, userId, permission, grantedBy, now());
  },

  revokeAccess(datasetId, userId) {
    db.prepare(`DELETE FROM dataset_permissions WHERE dataset_id = ? AND user_id = ?`).run(datasetId, userId);
  },

  getGrantedPermission(datasetId, userId) {
    const row = db.prepare(`SELECT permission FROM dataset_permissions WHERE dataset_id = ? AND user_id = ?`).get(datasetId, userId);
    return row ? row.permission : null;
  },

  listGrantsForDataset(datasetId) {
    return db.prepare(`SELECT * FROM dataset_permissions WHERE dataset_id = ?`).all(datasetId);
  },

  listGrantsForUser(userId) {
    return db.prepare(`SELECT * FROM dataset_permissions WHERE user_id = ?`).all(userId);
  },

  removeAllGrantsForDataset(datasetId) {
    db.prepare(`DELETE FROM dataset_permissions WHERE dataset_id = ?`).run(datasetId);
  },

  // ---- Audit log ----
  appendAudit({ userId, action, resourceType = null, resourceId = null, success = true, details = null, ip = null }) {
    db.prepare(`
      INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, success, details_json, ip, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), userId, action, resourceType, resourceId, success ? 1 : 0, details ? JSON.stringify(details) : null, ip, now());
  },

  listAudit({ userId = null, resourceId = null, limit = 100 } = {}) {
    let query = `SELECT * FROM audit_log WHERE 1=1`;
    const params = [];
    if (userId) { query += ` AND user_id = ?`; params.push(userId); }
    if (resourceId) { query += ` AND resource_id = ?`; params.push(resourceId); }
    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    return db.prepare(query).all(...params).map((r) => ({ ...r, details: r.details_json ? JSON.parse(r.details_json) : null, success: !!r.success }));
  },
};

db.exec(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id TEXT PRIMARY KEY,      -- the JWT "jti"
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
`);

// SESSION MANAGEMENT (blueprint #17): tokens can be listed and revoked server-side.
AuthRegistry.createSession = function createSession({ userId, expiresAt = null, ip = null, userAgent = null }) {
  const id = uuidv4();
  db.prepare(`INSERT INTO auth_sessions (session_id, user_id, created_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?)`)
    .run(id, userId, new Date().toISOString(), expiresAt, ip, userAgent ? String(userAgent).slice(0, 200) : null);
  return id;
};
AuthRegistry.isSessionActive = function isSessionActive(sessionId) {
  const r = db.prepare(`SELECT revoked_at, expires_at FROM auth_sessions WHERE session_id = ?`).get(sessionId);
  if (!r) return false;
  if (r.revoked_at) return false;
  return !(r.expires_at && new Date(r.expires_at) < new Date());
};
AuthRegistry.listSessions = function listSessions(userId) {
  return db.prepare(`SELECT session_id, created_at, expires_at, revoked_at, ip, user_agent FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).all(userId)
    .map((r) => ({ ...r, active: !r.revoked_at && !(r.expires_at && new Date(r.expires_at) < new Date()) }));
};
AuthRegistry.revokeSession = function revokeSession(sessionId, userId) {
  return db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), sessionId, userId).changes > 0;
};
AuthRegistry.revokeAllSessions = function revokeAllSessions(userId, exceptId = null) {
  return db.prepare(`UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND session_id <> ?`).run(new Date().toISOString(), userId, exceptId || '').changes;
};

module.exports = { AuthRegistry, ROLES };
