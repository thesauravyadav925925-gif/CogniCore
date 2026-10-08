const { verifyToken } = require('./auth');
const { AuthRegistry } = require('./auth.registry');

/**
 * RBAC
 * RULE #9: Enforce permissions outside the LLM. Everything in this file
 * is plain deterministic code - route handlers call these functions
 * BEFORE any dataset/query logic runs, and the LLM never sees or
 * influences the decision.
 *
 * Roles (matching the spec's own example, Section 27):
 *   admin   - full access to every dataset and to user management
 *   manager - full access to datasets they own or are granted 'manage' on
 *   analyst - query/read access to datasets they own or are granted access to
 *   user    - same as analyst; the distinction exists for future tool-level
 *             restrictions (e.g. only analysts can build reports) which
 *             Phase 6 does not yet need to enforce differently
 */

/** Express middleware: requires a valid JWT, attaches req.user. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: true, message: 'Authentication required. Include "Authorization: Bearer <token>".' });
  }
  try {
    const payload = verifyToken(token);
    // Server-side session check: a signed-out / revoked token stops working immediately.
    if (payload.jti && !AuthRegistry.isSessionActive(payload.jti)) {
      return res.status(401).json({ error: true, message: 'This session has been signed out. Please sign in again.' });
    }
    // Prefer the live account record so role changes take effect immediately (not at token expiry).
    const live = AuthRegistry.getUserById(payload.sub);
    req.user = live
      ? { user_id: live.user_id, email: live.email, role: live.role, name: live.name || '', session_id: payload.jti || null }
      : { user_id: payload.sub, email: payload.email, role: payload.role, name: '', session_id: payload.jti || null };
    next();
  } catch (err) {
    return res.status(401).json({ error: true, message: 'Invalid or expired token.' });
  }
}

/**
 * ROLE CAPABILITIES (Feature 22)
 *   admin    everything
 *   manager  upload/connect, share, query, charts, exports, reports, python, propose + APPROVE actions,
 *            manage knowledge and data policies
 *   analyst  upload/connect, query, charts, exports, reports, python, propose actions
 *   user     legacy alias of analyst
 *   employee query, charts, exports  (typically confined to own records by row-level policies)
 *   viewer   query, charts  (read-only; PII masked)
 * Dataset-level access (ownership / grants) is checked separately by canRead/canManage.
 */
const CAPABILITIES = {
  admin: ['*'],
  manager: ['upload', 'connect', 'share', 'query', 'chart', 'export', 'report', 'python', 'action.propose', 'action.approve', 'knowledge.manage', 'policy.manage'],
  analyst: ['upload', 'connect', 'query', 'chart', 'export', 'report', 'python', 'action.propose'],
  user: ['upload', 'connect', 'query', 'chart', 'export', 'report', 'python', 'action.propose'],
  employee: ['query', 'chart', 'export'],
  viewer: ['query', 'chart'],
};

function can(user, capability) {
  if (!user) return false;
  const caps = CAPABILITIES[user.role] || [];
  return caps.includes('*') || caps.includes(capability);
}

/** Express middleware factory: requires a capability (role-based, independent of any dataset). */
function requireCapability(capability) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: true, message: 'Authentication required.' });
    if (!can(req.user, capability)) {
      AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'capability.denied', success: false, details: { capability, role: req.user.role } });
      return res.status(403).json({ error: true, message: `Your role (${req.user.role}) is not allowed to perform this action (${capability}).` });
    }
    next();
  };
}

/** Express middleware factory: requires one of the given roles. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: true, message: 'Authentication required.' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: true, message: `This action requires one of these roles: ${roles.join(', ')}.` });
    }
    next();
  };
}

/**
 * Returns the effective permission level a user has on a dataset:
 * 'manage' | 'read' | null (no access).
 */
function getEffectivePermission(user, dataset) {
  if (!user || !dataset) return null;
  if (user.role === 'admin') return 'manage';
  if (dataset.owner_id === user.user_id) return 'manage';
  const granted = AuthRegistry.getGrantedPermission(dataset.dataset_id, user.user_id);
  return granted || null;
}

function canRead(user, dataset) {
  const level = getEffectivePermission(user, dataset);
  return level === 'read' || level === 'manage';
}

function canManage(user, dataset) {
  return getEffectivePermission(user, dataset) === 'manage';
}

/** Express middleware factory: loads req.dataset and 403s if the user can't read it. */
function requireDatasetAccess(level = 'read') {
  const { DatasetRegistry } = require('../ingestion/dataset.registry');
  return (req, res, next) => {
    const datasetId = req.params.id || req.params.datasetId || req.body?.datasetId;
    const dataset = datasetId ? DatasetRegistry.get(datasetId) : null;
    if (!dataset) {
      return res.status(404).json({ error: true, message: 'Dataset not found.' });
    }
    const allowed = level === 'manage' ? canManage(req.user, dataset) : canRead(req.user, dataset);
    if (!allowed) {
      AuthRegistry.appendAudit({
        userId: req.user?.user_id, action: 'dataset.access_denied',
        resourceType: 'dataset', resourceId: datasetId, success: false,
        details: { requiredLevel: level },
      });
      return res.status(403).json({ error: true, message: 'You do not have access to this dataset.' });
    }
    req.dataset = dataset;
    next();
  };
}

module.exports = { CAPABILITIES, can, requireCapability, requireAuth, requireRole, getEffectivePermission, canRead, canManage, requireDatasetAccess };
