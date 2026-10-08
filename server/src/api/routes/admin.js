const express = require('express');
const { AuthRegistry } = require('../../security/auth.registry');
const { requireAuth, requireRole } = require('../../security/rbac');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/users
router.get('/users', asyncHandler(async (req, res) => {
  res.json({ users: AuthRegistry.listUsers() });
}));

// PATCH /api/admin/users/:id/role  { role }
router.patch('/users/:id/role', asyncHandler(async (req, res) => {
  const { role } = req.body || {};
  if (!AuthRegistry.ROLES.includes(role)) {
    return res.status(400).json({ error: true, message: `role must be one of: ${AuthRegistry.ROLES.join(', ')}` });
  }
  const updated = AuthRegistry.updateUserRole(req.params.id, role);
  AuthRegistry.appendAudit({
    userId: req.user.user_id, action: 'admin.role_change', resourceType: 'user', resourceId: req.params.id,
    success: true, details: { newRole: role },
  });
  res.json({ user: updated });
}));

// GET /api/admin/audit?userId=&resourceId=&limit=
router.get('/audit', asyncHandler(async (req, res) => {
  const { userId, resourceId, limit } = req.query;
  const entries = AuthRegistry.listAudit({
    userId: userId || null,
    resourceId: resourceId || null,
    limit: limit ? parseInt(limit, 10) : 100,
  });
  res.json({ entries });
}));

// GET /api/admin/models  - which model each task routes to (blueprint #11)
router.get('/models', asyncHandler(async (req, res) => {
  const { describeRouting } = require('../../llm/model.manager');
  res.json({ routing: describeRouting() });
}));

module.exports = router;
