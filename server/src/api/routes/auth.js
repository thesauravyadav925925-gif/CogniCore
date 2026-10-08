const express = require('express');
const { AuthRegistry } = require('../../security/auth.registry');
const { hashPassword, verifyPassword, signToken } = require('../../security/auth');
const { requireAuth } = require('../../security/rbac');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();
const config = require('../../config/env');

/** Creates a server-side session row and signs a token bound to it (so it can be revoked). */
function issueSession(user, req) {
  const days = /^(\d+)d$/.exec(config.auth.jwtExpiry || '7d');
  const expiresAt = days ? new Date(Date.now() + parseInt(days[1], 10) * 86400000).toISOString() : null;
  const jti = AuthRegistry.createSession({ userId: user.user_id, expiresAt, ip: req.ip, userAgent: req.headers['user-agent'] });
  return signToken(user, jti);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/auth/register  { email, password, name? }
router.post('/register', asyncHandler(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: true, message: 'A valid email is required.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: true, message: 'Password must be at least 8 characters.' });
  }
  if (AuthRegistry.getUserByEmail(email)) {
    return res.status(409).json({ error: true, message: 'An account with this email already exists.' });
  }

  // Bootstrap: the very first user to register becomes admin. Everyone
  // after that starts as a plain 'user' - an admin can promote them later.
  const isFirstUser = AuthRegistry.countUsers() === 0;
  const role = isFirstUser ? 'admin' : 'user';

  const passwordHash = await hashPassword(password);
  const user = AuthRegistry.createUser({ email, passwordHash, name, role });
  const token = issueSession(user, req);

  AuthRegistry.appendAudit({ userId: user.user_id, action: 'auth.register', success: true, details: { isFirstUser } });

  res.status(201).json({ user, token });
}));

// POST /api/auth/login  { email, password }
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: true, message: 'Email and password are required.' });
  }

  const row = AuthRegistry.getUserByEmail(email);
  const valid = row && await verifyPassword(password, row.password_hash);

  if (!valid) {
    AuthRegistry.appendAudit({ userId: row?.user_id || null, action: 'auth.login', success: false, details: { email } });
    return res.status(401).json({ error: true, message: 'Invalid email or password.' });
  }

  const user = AuthRegistry.getUserById(row.user_id);
  const token = issueSession(user, req);
  AuthRegistry.appendAudit({ userId: user.user_id, action: 'auth.login', success: true });

  res.json({ user, token });
}));

// GET /api/auth/me
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = AuthRegistry.getUserById(req.user.user_id);
  if (!user) return res.status(404).json({ error: true, message: 'User not found.' });
  res.json({ user });
}));

// GET /api/auth/sessions  - your devices/sessions
router.get('/sessions', requireAuth, asyncHandler(async (req, res) => {
  res.json({ sessions: AuthRegistry.listSessions(req.user.user_id).map((s) => ({ ...s, current: s.session_id === req.user.session_id })) });
}));

// DELETE /api/auth/sessions/:id  - sign out one session
router.delete('/sessions/:id', requireAuth, asyncHandler(async (req, res) => {
  const ok = AuthRegistry.revokeSession(req.params.id, req.user.user_id);
  if (!ok) return res.status(404).json({ error: true, message: 'Session not found or already ended.' });
  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'auth.session_revoked', success: true, details: { sessionId: req.params.id } });
  res.json({ ok: true });
}));

// POST /api/auth/logout  - sign out this session
router.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  if (req.user.session_id) AuthRegistry.revokeSession(req.user.session_id, req.user.user_id);
  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'auth.logout', success: true });
  res.json({ ok: true });
}));

// POST /api/auth/logout-all  - sign out every other session
router.post('/logout-all', requireAuth, asyncHandler(async (req, res) => {
  const n = AuthRegistry.revokeAllSessions(req.user.user_id, req.user.session_id);
  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'auth.logout_all', success: true, details: { revoked: n } });
  res.json({ ok: true, revoked: n });
}));

module.exports = router;
