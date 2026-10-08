const express = require('express');
const { analyzeSchema } = require('../../schema/schema.analyzer');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireDatasetAccess } = require('../../security/rbac');

const router = express.Router();
const DOCUMENT_TYPES = new Set(['pdf', 'docx', 'txt']);

// GET /api/schema/:datasetId
router.get('/:datasetId', requireAuth, requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const dataset = req.dataset;
  if (dataset.status !== 'ready') {
    return res.status(409).json({ error: true, message: `Dataset is not ready (status: ${dataset.status})` });
  }

  if (DOCUMENT_TYPES.has(dataset.type)) {
    return res.json({
      datasetId: dataset.dataset_id,
      isDocument: true,
      documentProfile: dataset.schema?.documentProfile || dataset.profile,
    });
  }

  const analyzed = analyzeSchema(dataset.schema, dataset.profile);
  res.json({ datasetId: dataset.dataset_id, isDocument: false, ...analyzed });
}));

module.exports = router;
