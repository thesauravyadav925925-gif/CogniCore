const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireDatasetAccess, requireCapability } = require('../../security/rbac');
const { AuthRegistry } = require('../../security/auth.registry');
const { PolicyStore } = require('../../security/data.policy');

const router = express.Router();
router.use(requireAuth);
const ROLES = ['*', 'manager', 'analyst', 'user', 'employee', 'viewer'];

// GET /api/policies/:datasetId
router.get('/:datasetId', requireCapability('policy.manage'), requireDatasetAccess('manage'), (req, res) => {
  res.json({ policies: PolicyStore.list(req.dataset.dataset_id), roles: ROLES });
});

// POST /api/policies/:datasetId  { role, kind:'deny_column'|'row_filter', columnName, tableName?, op?, value? }
router.post('/:datasetId', requireCapability('policy.manage'), requireDatasetAccess('manage'), asyncHandler(async (req, res) => {
  const { role = '*', kind, columnName, tableName = null, op = null, value = null } = req.body || {};
  if (!ROLES.includes(role)) return res.status(400).json({ error: true, message: `role must be one of: ${ROLES.join(', ')} (admins are never restricted).` });
  const tables = req.dataset.schema?.tables || [];
  const t = tableName ? tables.find((x) => x.name === tableName) : null;
  if (tableName && !t) return res.status(400).json({ error: true, message: 'Unknown table.' });
  const exists = (t ? [t] : tables).some((x) => x.columns.some((c) => c.name.toLowerCase() === String(columnName).toLowerCase()));
  if (!exists) return res.status(400).json({ error: true, message: `Column "${columnName}" does not exist in this dataset.` });
  let id;
  try { id = PolicyStore.add({ datasetId: req.dataset.dataset_id, role, kind, tableName, columnName, op, value, createdBy: req.user.user_id }); }
  catch (err) { return res.status(400).json({ error: true, message: err.message }); }
  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'policy.create', resourceType: 'dataset', resourceId: req.dataset.dataset_id, success: true, details: { policyId: id, role, kind, columnName, op } });
  res.status(201).json({ policyId: id });
}));

// DELETE /api/policies/:datasetId/:policyId
router.delete('/:datasetId/:policyId', requireCapability('policy.manage'), requireDatasetAccess('manage'), (req, res) => {
  const exists = PolicyStore.list(req.dataset.dataset_id).some((p) => p.policy_id === req.params.policyId);
  if (!exists) return res.status(404).json({ error: true, message: 'Policy not found for this dataset.' });
  PolicyStore.remove(req.params.policyId);
  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'policy.delete', resourceType: 'dataset', resourceId: req.dataset.dataset_id, success: true, details: { policyId: req.params.policyId } });
  res.json({ ok: true });
});

module.exports = router;
