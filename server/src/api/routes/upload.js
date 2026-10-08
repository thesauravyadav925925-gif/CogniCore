const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const config = require('../../config/env');
const { ingestFile } = require('../../ingestion/ingestion.pipeline');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireCapability } = require('../../security/rbac');
const { AuthRegistry } = require('../../security/auth.registry');
const { validateUpload, sanitizeFilename } = require('../../security/file.validator');

const router = express.Router();

fs.mkdirSync(config.paths.uploads, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.paths.uploads),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.upload.maxFileSizeMb * 1024 * 1024 },
});

// POST /api/upload  (multipart/form-data, field name: "file")
router.post('/', requireAuth, requireCapability('upload'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: true, message: 'No file uploaded. Use multipart field name "file".' });
  }

  // Content must match the claimed type BEFORE anything parses it (blueprint #17).
  try { validateUpload(req.file.path, req.file.originalname); } catch (err) {
    fs.rmSync(req.file.path, { force: true });
    AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'dataset.upload', success: false, details: { reason: err.message, name: sanitizeFilename(req.file.originalname) } });
    return res.status(err.status || 400).json({ error: true, message: err.message });
  }

  const dataset = await ingestFile({
    filePath: req.file.path,
    originalFilename: sanitizeFilename(req.file.originalname),
    ownerId: req.user.user_id,
  });

  AuthRegistry.appendAudit({
    userId: req.user.user_id, action: 'dataset.upload', resourceType: 'dataset', resourceId: dataset.dataset_id,
    success: dataset.status === 'ready', details: { name: dataset.name, type: dataset.type, status: dataset.status },
  });

  res.status(201).json({ dataset });
}));

module.exports = router;
