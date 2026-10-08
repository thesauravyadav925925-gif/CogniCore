const express = require('express');
const { resolveValidatedResult } = require('../../tools/shared');
const { buildChartSpec } = require('../../tools/chart.tool');
const { toCsvBuffer, toXlsxBuffer } = require('../../tools/export.tool');
const { calculateMetric } = require('../../tools/calculate.tool');
const { buildPdfReport } = require('../../tools/report.tool');
const { TOOLS } = require('../../tools/tool.registry');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireDatasetAccess, requireCapability } = require('../../security/rbac');
const { AuthRegistry } = require('../../security/auth.registry');

const router = express.Router();
router.use(requireAuth);

// GET /api/tools - list available tools (Section 22 of the spec)
router.get('/', (req, res) => {
  res.json({ tools: TOOLS });
});

// POST /api/tools/chart  { datasetId, sql, chartType, xField, yFields, title? }
router.post('/chart', requireCapability('chart'), requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const { sql, chartType, xField, yFields, title } = req.body || {};
  const { result } = await resolveValidatedResult({ datasetId: req.dataset.dataset_id, sql, user: req.user });
  const spec = buildChartSpec(result, { chartType, xField, yFields, title });
  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'tool.chart', resourceType: 'dataset', resourceId: req.dataset.dataset_id, success: true, details: { chartType } });
  res.json({ chart: spec, rowCount: result.rowCount, truncated: result.truncated });
}));

// POST /api/tools/calculate  { datasetId, sql, column, metric }
router.post('/calculate', requireCapability('chart'), requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const { sql, column, metric } = req.body || {};
  const { result } = await resolveValidatedResult({ datasetId: req.dataset.dataset_id, sql, user: req.user });
  const computed = calculateMetric(result, { column, metric });
  res.json({ ...computed, rowCount: result.rowCount });
}));

// POST /api/tools/export  { datasetId, sql, format: 'csv'|'xlsx', filename? }
router.post('/export', requireCapability('export'), requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const { sql, format, filename } = req.body || {};
  if (!['csv', 'xlsx'].includes(format)) {
    return res.status(400).json({ error: true, message: 'format must be "csv" or "xlsx"' });
  }

  const { dataset, result } = await resolveValidatedResult({ datasetId: req.dataset.dataset_id, sql, user: req.user });
  const baseName = (filename || dataset.name || 'export').replace(/[^A-Za-z0-9_-]/g, '_');

  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'tool.export', resourceType: 'dataset', resourceId: dataset.dataset_id, success: true, details: { format } });

  if (format === 'csv') {
    const buffer = toCsvBuffer(result);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.csv"`);
    return res.send(buffer);
  }

  const buffer = toXlsxBuffer(result, dataset.name);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);
  res.send(buffer);
}));

// POST /api/tools/report  { datasetId, sql, question?, answer?, title? }
router.post('/report', requireCapability('export'), requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const { sql, question, answer, title } = req.body || {};
  const { dataset, result } = await resolveValidatedResult({ datasetId: req.dataset.dataset_id, sql, user: req.user });

  const buffer = await buildPdfReport({
    title: title || `CogniCore Report — ${dataset.name}`,
    question,
    answer,
    sql,
    columns: result.columns,
    rows: result.rows,
  });

  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'tool.report', resourceType: 'dataset', resourceId: dataset.dataset_id, success: true });

  const baseName = (dataset.name || 'report').replace(/[^A-Za-z0-9_-]/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}_report.pdf"`);
  res.send(buffer);
}));

module.exports = router;
