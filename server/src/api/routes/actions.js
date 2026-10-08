const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireCapability, can } = require('../../security/rbac');
const { AuthRegistry } = require('../../security/auth.registry');
const { ActionRegistry } = require('../../actions/action.registry');
const { approveAndExecute, reject } = require('../../actions/action.executor');

const router = express.Router();
router.use(requireAuth);

router.get('/types', (req, res) => res.json({ types: ActionRegistry.describeTypes() }));

// GET /api/actions?status=pending  - approvers see all, others only their own
router.get('/', (req, res) => {
  const all = can(req.user, 'action.approve');
  res.json({ actions: ActionRegistry.list({ status: req.query.status || null, requestedBy: all ? null : req.user.user_id }), canApprove: all });
});

// POST /api/actions  { type, params }  -> pending request (never executes)
router.post('/', requireCapability('action.propose'), asyncHandler(async (req, res) => {
  const { type, params } = req.body || {};
  let action;
  try { action = ActionRegistry.propose({ type, params, requestedBy: req.user.user_id }); } catch (e) { return res.status(400).json({ error: true, message: e.message }); }
  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'action.proposed', resourceType: 'action', resourceId: action.action_id, success: true, details: { type } });
  res.status(201).json({ action });
}));

router.post('/:id/approve', asyncHandler(async (req, res) => {
  const out = await approveAndExecute(req.params.id, req.user, req.body?.note || null).catch((e) => { throw Object.assign(e, { status: e.status || 400 }); });
  res.json({ action: out, outbox: ActionRegistry.listOutbox(req.params.id) });
}));

router.post('/:id/reject', asyncHandler(async (req, res) => {
  const out = reject(req.params.id, req.user, req.body?.note || null);
  res.json({ action: out });
}));

module.exports = router;
