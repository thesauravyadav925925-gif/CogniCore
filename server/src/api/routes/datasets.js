const express = require('express');
const fs = require('fs');
const path = require('path');
const { DatasetRegistry } = require('../../ingestion/dataset.registry');
const { createAdapter } = require('../../ingestion/adapters');
const { VectorStore } = require('../../documents/vector.store');
const { asyncHandler } = require('../middleware/asyncHandler');
const config = require('../../config/env');
const { requireAuth, requireDatasetAccess } = require('../../security/rbac');
const { AuthRegistry } = require('../../security/auth.registry');

const MATERIALIZED_TYPES = new Set(['csv', 'xlsx', 'json']);
const DOCUMENT_TYPES = new Set(['pdf', 'docx', 'txt']);

const router = express.Router();
router.use(requireAuth);

// GET /api/datasets - only datasets the user owns, is granted access to, or (if admin) all of them
router.get('/', asyncHandler(async (req, res) => {
  if (req.user.role === 'admin') {
    return res.json({ datasets: DatasetRegistry.list() });
  }
  const owned = DatasetRegistry.list(req.user.user_id);
  const grants = AuthRegistry.listGrantsForUser(req.user.user_id);
  const ownedIds = new Set(owned.map((d) => d.dataset_id));
  const grantedDatasets = grants
    .map((g) => g.dataset_id)
    .filter((id) => !ownedIds.has(id))
    .map((id) => DatasetRegistry.get(id))
    .filter(Boolean);
  res.json({ datasets: [...owned, ...grantedDatasets] });
}));

// GET /api/datasets/:id
router.get('/:id', requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  res.json({ dataset: req.dataset });
}));

// GET /api/datasets/:id/preview?table=X&limit=10
router.get('/:id/preview', requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const dataset = req.dataset;

  if (DOCUMENT_TYPES.has(dataset.type)) {
    const chunks = VectorStore.listChunks(dataset.dataset_id, parseInt(req.query.limit || '10', 10));
    return res.json({ documentChunks: chunks });
  }

  const tableName = req.query.table || dataset.schema?.tables?.[0]?.name;
  if (!tableName) return res.status(400).json({ error: true, message: 'No table available to preview' });

  const adapter = createAdapter(dataset.type, { datasetId: dataset.dataset_id, location: dataset.location });
  await adapter.connect();
  try {
    const preview = await adapter.preview(tableName, parseInt(req.query.limit || '10', 10));
    res.json({ table: tableName, ...preview });
  } finally {
    await adapter.disconnect();
  }
}));

// POST /api/datasets/:id/share  { email, permission: 'read'|'manage' }  - owner/admin only
router.post('/:id/share', requireDatasetAccess('manage'), asyncHandler(async (req, res) => {
  const { email, permission } = req.body || {};
  if (!email || !['read', 'manage'].includes(permission)) {
    return res.status(400).json({ error: true, message: 'email and permission ("read" or "manage") are required.' });
  }
  const targetUser = AuthRegistry.getUserByEmail(email);
  if (!targetUser) {
    return res.status(404).json({ error: true, message: `No user found with email "${email}".` });
  }
  AuthRegistry.grantAccess(req.dataset.dataset_id, targetUser.user_id, permission, req.user.user_id);
  AuthRegistry.appendAudit({
    userId: req.user.user_id, action: 'dataset.share', resourceType: 'dataset', resourceId: req.dataset.dataset_id,
    success: true, details: { grantedTo: email, permission },
  });
  res.json({ success: true });
}));

// DELETE /api/datasets/:id/share/:userId  - owner/admin only
router.delete('/:id/share/:userId', requireDatasetAccess('manage'), asyncHandler(async (req, res) => {
  AuthRegistry.revokeAccess(req.dataset.dataset_id, req.params.userId);
  AuthRegistry.appendAudit({
    userId: req.user.user_id, action: 'dataset.unshare', resourceType: 'dataset', resourceId: req.dataset.dataset_id,
    success: true, details: { revokedFrom: req.params.userId },
  });
  res.json({ success: true });
}));

// GET /api/datasets/:id/shares - list who has access (owner/admin only)
router.get('/:id/shares', requireDatasetAccess('manage'), asyncHandler(async (req, res) => {
  const grants = AuthRegistry.listGrantsForDataset(req.dataset.dataset_id);
  res.json({ shares: grants });
}));

// DELETE /api/datasets/:id  - owner/admin only
router.delete('/:id', requireDatasetAccess('manage'), asyncHandler(async (req, res) => {
  const dataset = req.dataset;

  DatasetRegistry.remove(dataset.dataset_id);
  AuthRegistry.removeAllGrantsForDataset(dataset.dataset_id);

  try { if (dataset.source === 'upload' && fs.existsSync(dataset.location)) fs.unlinkSync(dataset.location); } catch (_) {}
  if (MATERIALIZED_TYPES.has(dataset.type)) {
    const internalDb = path.join(config.paths.data, `${dataset.dataset_id}.db`);
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { if (fs.existsSync(internalDb + suffix)) fs.unlinkSync(internalDb + suffix); } catch (_) {}
    }
  }
  if (DOCUMENT_TYPES.has(dataset.type)) {
    VectorStore.deleteForDataset(dataset.dataset_id);
  }

  AuthRegistry.appendAudit({
    userId: req.user.user_id, action: 'dataset.delete', resourceType: 'dataset', resourceId: dataset.dataset_id, success: true,
  });

  res.json({ success: true });
}));

module.exports = router;
