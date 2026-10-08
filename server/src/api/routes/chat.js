const express = require('express');
const { handleUserQuery } = require('../../core/core.engine');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, canRead, requireCapability } = require('../../security/rbac');
const { rateLimit } = require('../../guardrails/rate.limit');
const { AuthRegistry } = require('../../security/auth.registry');
const { DatasetRegistry } = require('../../ingestion/dataset.registry');

const router = express.Router();

// POST /api/chat  { question, datasetId?, datasetIds?, sessionId?, analysisMode? }
router.post('/', requireAuth, requireCapability('query'), rateLimit(), asyncHandler(async (req, res) => {
  const { question, datasetId, datasetIds, sessionId, analysisMode } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: true, message: '"question" (string) is required in the request body.' });
  }

  // A chat request can touch multiple datasets at once (hybrid queries) -
  // every one of them must pass a read-access check before the query runs,
  // not just the first. This is enforced here rather than via a single
  // requireDatasetAccess middleware because the dataset list is inside the
  // request body and can have more than one entry.
  const ids = Array.isArray(datasetIds) && datasetIds.length > 0 ? datasetIds : (datasetId ? [datasetId] : []);
  for (const id of ids) {
    const dataset = DatasetRegistry.get(id);
    if (!dataset) {
      return res.status(404).json({ error: true, message: `Dataset "${id}" not found.` });
    }
    if (!canRead(req.user, dataset)) {
      AuthRegistry.appendAudit({
        userId: req.user.user_id, action: 'dataset.access_denied', resourceType: 'dataset', resourceId: id,
        success: false, details: { via: 'chat' },
      });
      return res.status(403).json({ error: true, message: `You do not have access to dataset "${dataset.name}".` });
    }
  }

  const result = await handleUserQuery({ question, datasetId, datasetIds, sessionId, userId: req.user.user_id, user: req.user, analysisMode: !!analysisMode });

  AuthRegistry.appendAudit({
    userId: req.user.user_id, action: 'chat.query', resourceType: 'dataset', resourceId: ids[0] || null,
    success: result.audit?.success !== false,
    details: {
      question, routeType: result.routeType, datasetIds: ids, analysisMode: !!analysisMode,
      sql: result.audit?.sql || result.generatedSql || null, tables: result.audit?.tables || null, rows: result.audit?.rows ?? null,
      tool: result.audit?.tool || result.tool || null, denied: !!result.denied, repairs: result.audit?.repairs || 0,
      guardrails: result.guardrail?.flags || null, redactedFields: result.redactedFields || 0, role: req.user.role,
    },
  });

  const { audit: _audit, ...publicResult } = result;
  res.json(publicResult);
}));

module.exports = router;
