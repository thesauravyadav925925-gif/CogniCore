const express = require('express');
const { ingestConnection } = require('../../ingestion/connection.pipeline');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireCapability } = require('../../security/rbac');
const { AuthRegistry } = require('../../security/auth.registry');

const router = express.Router();

// POST /api/connections
// { type: 'postgres'|'mysql', name?, host, port, database, user, password, ssl? }
router.post('/', requireAuth, requireCapability('connect'), asyncHandler(async (req, res) => {
  const { type, name, host, port, database, user, password, ssl } = req.body || {};

  const missing = ['type', 'host', 'database', 'user'].filter((k) => !req.body?.[k]);
  if (missing.length) {
    return res.status(400).json({ error: true, message: `Missing required field(s): ${missing.join(', ')}` });
  }

  const dataset = await ingestConnection({
    type, name, host,
    port: port ? parseInt(port, 10) : undefined,
    database, user, password, ssl: !!ssl, ownerId: req.user.user_id,
  });

  AuthRegistry.appendAudit({
    userId: req.user.user_id, action: 'dataset.connect', resourceType: 'dataset', resourceId: dataset.dataset_id,
    success: true, details: { type, name: dataset.name },
  });

  // dataset already excludes credentials (see dataset.registry.js _hydrate) -
  // safe to return directly.
  res.status(201).json({ dataset });
}));

// POST /api/connections/api  { url, name?, method?, headers?, body?, graphql?: {query, variables}, recordsPath? }
// REST/GraphQL source (Feature 31). Credentials in headers are used once and never stored.
router.post('/api', requireAuth, requireCapability('connect'), asyncHandler(async (req, res) => {
  const { ingestApi } = require('../../ingestion/api.connector');
  const { url, name, method, headers, body, graphql, recordsPath } = req.body || {};
  if (!url) return res.status(400).json({ error: true, message: '"url" is required.' });
  let out;
  try { out = await ingestApi({ url, name, method, headers, body, graphql, recordsPath, ownerId: req.user.user_id }); }
  catch (err) { return res.status(400).json({ error: true, message: err.message }); }
  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'dataset.connect_api', resourceType: 'dataset', resourceId: out.dataset.dataset_id, success: true, details: { host: new URL(url).host, records: out.recordCount } });
  res.status(201).json({ dataset: out.dataset, recordCount: out.recordCount });
}));

module.exports = router;
