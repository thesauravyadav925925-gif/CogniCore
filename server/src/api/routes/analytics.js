const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { requireAuth, requireDatasetAccess, requireCapability } = require('../../security/rbac');
const { AuthRegistry } = require('../../security/auth.registry');
const { resolvePolicy } = require('../../security/data.policy');
const { resolveValidatedResult } = require('../../tools/shared');
const { createAdapter } = require('../../ingestion/adapters');
const { generateKpis } = require('../../analytics/kpi');
const { exploreQuestions } = require('../../analytics/exploration');
const { selectChart } = require('../../analytics/viz');
const { generateInsights } = require('../../analytics/insights');
const { buildManagementReport } = require('../../report/report.builder');
const exporters = require('../../report/report.exporters');
const { renderChartSvg } = require('../../report/chart.svg');
const { runDataScience, OPS } = require('../../python/python.tool');
const { runSafeSql, policyRestrictsAggregates, isColumnDenied } = require('../../agent/safe.query');
const { redactEvidence } = require('../../guardrails/pii');
const { DatasetRegistry } = require('../../ingestion/dataset.registry');
const { canRead } = require('../../security/rbac');
const { buildBriefing } = require('../../analytics/briefing');
const { buildDashboard } = require('../../analytics/dashboard');
const { buildCatalog } = require('../../semantic/catalog');
const { Meanings } = require('../../semantic/meanings.store');
const { toolsFor, schemaTool, profilerTool, validationTool } = require('../../tools/catalog');
const { can } = require('../../security/rbac');

const router = express.Router();
router.use(requireAuth);

const policyOf = (req) => resolvePolicy({ datasetId: req.dataset.dataset_id, user: req.user });
const needSemantic = (req, res) => {
  if (!req.dataset.profile?.semantic) { res.status(400).json({ error: true, message: 'This dataset has no semantic model (document datasets are not analysed this way).' }); return false; }
  return true;
};
const audit = (req, action, details = {}) => AuthRegistry.appendAudit({ userId: req.user.user_id, action, resourceType: 'dataset', resourceId: req.dataset?.dataset_id, success: true, details });

// Columns a role may not see are removed from the semantic model it receives.
function filterSemantic(semantic, policy) {
  const denied = new Set((policy.deniedColumns || []).map((d) => d.column.toLowerCase()));
  return { ...semantic, tables: semantic.tables.map((t) => ({ ...t, columns: t.columns.filter((c) => !denied.has(c.name.toLowerCase())).map((c) => ({ ...c, samples: [] })) })) };
}

// ---- cross-dataset endpoints (declared before the /:datasetId routes) ----

// GET /api/analytics/briefing  - "Today's Intelligence" across every dataset you can read
router.get('/briefing', asyncHandler(async (req, res) => {
  const all = req.user.role === 'admin' ? DatasetRegistry.list() : DatasetRegistry.list(req.user.user_id).concat(
    AuthRegistry.listGrantsForUser(req.user.user_id).map((g) => DatasetRegistry.get(g.dataset_id)).filter(Boolean));
  const seen = new Set();
  const datasets = all.filter((d) => d && !seen.has(d.dataset_id) && seen.add(d.dataset_id) && canRead(req.user, d));
  const briefing = await buildBriefing({ datasets, policyFor: (id) => resolvePolicy({ datasetId: id, user: req.user }) });
  AuthRegistry.appendAudit({ userId: req.user.user_id, action: 'briefing.generate', success: true, details: { datasets: datasets.length, alerts: briefing.alerts.length } });
  res.json({ briefing });
}));

// GET /api/analytics/registry  - the tools your role may use
router.get('/registry', (req, res) => res.json({ tools: toolsFor(req.user), role: req.user.role }));

// GET /api/analytics/:datasetId/semantic
router.get('/:datasetId/semantic', requireDatasetAccess('read'), (req, res) => {
  if (!needSemantic(req, res)) return;
  res.json({ semantic: filterSemantic(req.dataset.profile.semantic, policyOf(req)) });
});

// GET /api/analytics/:datasetId/quality
router.get('/:datasetId/quality', requireDatasetAccess('read'), (req, res) => {
  const q = req.dataset.profile?.quality;
  if (!q) return res.status(400).json({ error: true, message: 'No data-quality report is available for this dataset.' });
  if (policyRestrictsAggregates(policyOf(req))) return res.status(403).json({ error: true, message: 'Dataset-wide quality statistics are not available for roles with row-level restrictions.' });
  const policy = policyOf(req);
  res.json({ quality: { ...q, tables: q.tables.map((t) => ({ ...t, issues: t.issues.filter((i) => !i.column || !isColumnDenied(policy, t.name, i.column)) })) } });
});

// GET /api/analytics/:datasetId/kpis
router.get('/:datasetId/kpis', requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  if (!needSemantic(req, res)) return;
  const policy = policyOf(req);
  if (policyRestrictsAggregates(policy)) return res.status(403).json({ error: true, message: 'KPIs summarise the whole dataset, which is not available for roles with row-level restrictions.' });
  const adapter = createAdapter(req.dataset.type, { datasetId: req.dataset.dataset_id, location: req.dataset.location });
  await adapter.connect();
  let groups;
  try { groups = await generateKpis({ adapter, semantic: req.dataset.profile.semantic, datasetType: req.dataset.type }); } finally { await adapter.disconnect(); }
  groups = groups.map((g) => ({ ...g, kpis: g.kpis.filter((k) => !k.column || !isColumnDenied(policy, g.table, k.column)) }));
  audit(req, 'analytics.kpis');
  res.json({ kpis: groups });
}));

// GET /api/analytics/:datasetId/explore  - "What can I ask about this dataset?"
router.get('/:datasetId/explore', requireDatasetAccess('read'), (req, res) => {
  if (!needSemantic(req, res)) return;
  const sem = filterSemantic(req.dataset.profile.semantic, policyOf(req));
  res.json({ questions: exploreQuestions(sem, { limit: 16 }) });
});

// GET /api/analytics/:datasetId/report            (JSON)
// GET /api/analytics/:datasetId/report/download?format=pdf|docx|xlsx|csv
router.get('/:datasetId/report', requireCapability('report'), requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const report = await buildManagementReport({ dataset: req.dataset, policy: policyOf(req) }).catch((e) => { throw Object.assign(e, { status: e.status || 400 }); });
  audit(req, 'report.generate', { format: 'json' });
  res.json({ report });
}));

router.get('/:datasetId/report/download', requireCapability('report'), requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const format = String(req.query.format || 'pdf').toLowerCase();
  if (!['pdf', 'docx', 'xlsx', 'csv'].includes(format)) return res.status(400).json({ error: true, message: 'format must be pdf, docx, xlsx or csv.' });
  const report = await buildManagementReport({ dataset: req.dataset, policy: policyOf(req) }).catch((e) => { throw Object.assign(e, { status: e.status || 400 }); });
  const base = req.dataset.name.replace(/[^A-Za-z0-9_-]/g, '_') + '-management-report';
  const out = { pdf: () => exporters.toPdf(report), docx: () => exporters.toDocx(report), xlsx: () => exporters.toXlsx(report), csv: () => exporters.toCsv(report) };
  const types = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' };
  const buf = await out[format]();
  audit(req, 'report.download', { format });
  res.setHeader('Content-Type', types[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${base}.${format}"`);
  res.send(buf);
}));

// POST /api/analytics/:datasetId/chart-svg  { sql, chartType? }  -> image/svg+xml (rebuilt from live data)
router.post('/:datasetId/chart-svg', requireCapability('chart'), requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const { sql, question } = req.body || {};
  const { result } = await resolveValidatedResult({ datasetId: req.dataset.dataset_id, sql, user: req.user });
  const spec = selectChart({ question: question || '', columns: result.columns, rows: result.rows });
  if (spec.type === 'none' || spec.type === 'table') return res.status(422).json({ error: true, message: 'This result has no chart-friendly shape.', spec });
  const override = req.body?.chartType && req.body.chartType !== 'auto' ? { ...spec, type: req.body.chartType } : spec;
  audit(req, 'chart.svg', { type: override.type });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Content-Disposition', `attachment; filename="chart.svg"`);
  res.send(renderChartSvg(override, result));
}));

// POST /api/analytics/:datasetId/export-analysis  { sql, question?, answer? } -> Excel with data + analysis sheet
router.post('/:datasetId/export-analysis', requireCapability('export'), requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const { sql, question, answer } = req.body || {};
  const { dataset, result } = await resolveValidatedResult({ datasetId: req.dataset.dataset_id, sql, user: req.user });
  const ev = { source_type: 'database', row_count: result.rowCount, columns: result.columns, sample_rows: result.rows.slice(0, 20) };
  const redacted = redactEvidence({ ...ev, sample_rows: result.rows }, dataset.profile?.semantic, req.user.role).evidence;
  const buf = exporters.analysisToXlsx({ question, answer, sql, columns: result.columns, rows: redacted.sample_rows, insights: generateInsights(ev) });
  audit(req, 'export.analysis');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${dataset.name.replace(/[^A-Za-z0-9_-]/g, '_')}-analysis.xlsx"`);
  res.send(buf);
}));

// POST /api/analytics/:datasetId/python  { op, table, columns:[..], x?, y?, column?, horizon? }
// Whitelisted operations only; data is pulled through the policy-enforced SQL path.
router.post('/:datasetId/python', requireCapability('python'), requireDatasetAccess('read'), asyncHandler(async (req, res) => {
  const { op, table, columns = [], column, x, y, horizon } = req.body || {};
  if (!OPS.includes(op)) return res.status(400).json({ error: true, message: `op must be one of: ${OPS.join(', ')}` });
  const sem = req.dataset.profile?.semantic?.tables?.find((t) => t.name === table);
  if (!sem) return res.status(400).json({ error: true, message: 'Unknown table.' });
  const cols = (op === 'regression' ? [x, y] : op === 'outliers' || op === 'forecast' ? [column] : columns).filter(Boolean);
  const valid = cols.filter((c) => sem.columns.some((sc) => sc.name === c && ['monetary', 'measure', 'count', 'percentage'].includes(sc.role)));
  if (!valid.length || valid.length !== cols.length) return res.status(400).json({ error: true, message: 'All columns must be numeric columns of the table.' });
  if (cols.some((c) => isColumnDenied(policyOf(req), table, c))) return res.status(403).json({ error: true, message: 'Your role does not have access to one of those columns.' });
  const sql = `SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}" LIMIT 50000`;
  const data = await runSafeSql({ dataset: req.dataset, sql, policy: policyOf(req), maxRows: 50000 });
  const colData = Object.fromEntries(cols.map((c) => [c, data.rows.map((r) => r[c])]));
  const payload = op === 'regression' ? { op, x: colData[x], y: colData[y] } : op === 'outliers' || op === 'forecast' ? { op, values: colData[column], horizon: Math.min(Math.max(parseInt(horizon || 3, 10), 1), 24) } : { op, columns: colData };
  const out = await runDataScience(payload);
  audit(req, 'python.tool', { op, table });
  res.json({ op, rowsAnalysed: data.rows.length, ...out });
}));

// GET /api/analytics/:datasetId/catalog  - dataset card, entities, attributes, business meanings
router.get('/:datasetId/catalog', requireDatasetAccess('read'), (req, res) => {
  res.json({ catalog: buildCatalog({ dataset: req.dataset, policy: policyOf(req) }) });
});

// PUT /api/analytics/:datasetId/catalog/meaning  { table, column, meaning }  (managers/admins)
router.put('/:datasetId/catalog/meaning', requireCapability('knowledge.manage'), requireDatasetAccess('read'), (req, res) => {
  const { table, column, meaning } = req.body || {};
  const t = req.dataset.schema?.tables?.find((x) => x.name === table);
  if (!t || !t.columns.some((c) => c.name === column)) return res.status(400).json({ error: true, message: 'Unknown table or column.' });
  try { Meanings.set({ datasetId: req.dataset.dataset_id, table, column, meaning, userId: req.user.user_id }); } catch (e) { return res.status(400).json({ error: true, message: e.message }); }
  audit(req, 'catalog.meaning_set', { table, column });
  res.json({ ok: true });
});

router.delete('/:datasetId/catalog/meaning', requireCapability('knowledge.manage'), requireDatasetAccess('read'), (req, res) => {
  Meanings.remove(req.dataset.dataset_id, req.query.table, req.query.column);
  audit(req, 'catalog.meaning_removed', { table: req.query.table, column: req.query.column });
  res.json({ ok: true });
});

// GET /api/analytics/:datasetId/dashboard?filters={"department":"Sales"}
router.get('/:datasetId/dashboard', requireDatasetAccess('read'), (req, res) => {
  let filters = {};
  try { filters = req.query.filters ? JSON.parse(req.query.filters) : {}; } catch (_) { return res.status(400).json({ error: true, message: 'filters must be JSON.' }); }
  const d = buildDashboard({ dataset: req.dataset, policy: policyOf(req), filters });
  if (!d) return res.status(400).json({ error: true, message: 'Dashboards are available for structured datasets.' });
  res.json({ dashboard: d });
});

// Meta tools: Schema / Profiler / Validation
router.get('/:datasetId/tool/schema', requireDatasetAccess('read'), (req, res) => res.json(schemaTool(req.dataset, policyOf(req))));
router.get('/:datasetId/tool/profile', requireDatasetAccess('read'), (req, res) => {
  const p = profilerTool(req.dataset, policyOf(req));
  if (!p) return res.status(400).json({ error: true, message: 'No profile for this dataset type.' });
  res.json(p);
});
router.post('/:datasetId/tool/validate', requireDatasetAccess('read'), (req, res) => res.json(validationTool(req.dataset, req.body?.sql)));

module.exports = router;
