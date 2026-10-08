require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const mm = require('../../src/llm/model.manager');
mm.getLLMProvider = () => ({ async complete() { return 'unused: deterministic tools need no model'; } });
mm.getEmbeddingProvider = () => null;
const { handleUserQuery } = require('../../src/core/core.engine');
const { ingestFile } = require('../../src/ingestion/ingestion.pipeline');
const { analyzeSchema } = require('../../src/schema/schema.analyzer');
const { renderJoinHints } = require('../../src/schema/join.planner');
const { AuthRegistry } = require('../../src/security/auth.registry');

const SAMPLE = path.join(__dirname, '..', '..', '..', 'sample-data');
const user = () => AuthRegistry.createUser({ email: `demo${Date.now()}${Math.random()}@x.com`, passwordHash: 'x', name: 'Demo', role: 'analyst' });

// The SAME question templates, asked of five unrelated domains. The engine has no domain code.
const GENERIC_QUESTIONS = {
  quality: 'Are there any data quality problems?',
  anomaly: 'Are there any unusual values?',
  trend: 'Is the monthly trend increasing or decreasing?',
  forecast: 'Forecast the next 3 months',
  kpi: 'Show the key metrics',
  explore: 'What can I ask about this dataset?',
  report: 'Give me a management report',
};

const DOMAINS = [
  { file: 'hospital_appointments.csv', name: 'Healthcare', flaw: /duplicate|inconsistent|missing|invalid|mixed/i, outlier: 95000 },
  { file: 'hr_employees.csv', name: 'HR', flaw: /missing|outlier/i, outlier: 9800000 },
  { file: 'finance_expenses.csv', name: 'Finance', flaw: /duplicate/i, outlier: 1250000 },
  { file: 'retail_orders.csv', name: 'Retail', flaw: null, outlier: null },
  { file: 'education_students.csv', name: 'Education', flaw: null, outlier: null },
];

for (const d of DOMAINS) {
  test(`domain-agnostic: ${d.name} (${d.file}) - same engine, same questions`, async () => {
    const src = path.join(SAMPLE, d.file);
    assert.ok(fs.existsSync(src), 'run: node server/scripts/generate-sample-data.js');
    const tmp = `/tmp/${Date.now()}-${d.file}`; fs.copyFileSync(src, tmp);
    const ds = await ingestFile({ filePath: tmp, originalFilename: d.file });
    assert.equal(ds.status, 'ready');
    const u = user();
    const ask = (q) => handleUserQuery({ question: q, datasetId: ds.dataset_id, user: u });

    const quality = await ask(GENERIC_QUESTIONS.quality);
    assert.equal(quality.routeType, 'AGENT', quality.answer);
    assert.match(quality.answer, /Data quality score: \d+\/100/);
    if (d.flaw) assert.match(quality.evidence.sample_rows.map((r) => r.detail).join(' '), d.flaw);
    else assert.match(quality.answer, /No missing values|issue/);

    const anomaly = await ask(GENERIC_QUESTIONS.anomaly);
    assert.equal(anomaly.routeType, 'AGENT', anomaly.answer);
    if (d.outlier) assert.ok(anomaly.evidence.sample_rows.some((r) => Object.values(r).includes(d.outlier)), `planted outlier ${d.outlier} should be flagged: ${anomaly.answer}`);

    const kpi = await ask(GENERIC_QUESTIONS.kpi);
    assert.equal(kpi.routeType, 'AGENT');
    assert.ok(kpi.analytics.kpiGroups[0].kpis.length >= 4);

    const explore = await ask(GENERIC_QUESTIONS.explore);
    assert.ok(explore.analytics.questions.length >= 8);

    const trend = await ask(GENERIC_QUESTIONS.trend);
    assert.equal(trend.routeType, 'AGENT', trend.answer);
    assert.match(trend.answer, /trending|flat|volatile|periods/);

    const fc = await ask(GENERIC_QUESTIONS.forecast);
    assert.equal(fc.routeType, 'AGENT', fc.answer);
    assert.match(fc.answer, /statistical projection|can't forecast/);

    const report = await ask(GENERIC_QUESTIONS.report);
    assert.equal(report.routeType, 'REPORT', report.answer);
    assert.match(report.answer, /Recommendations/);
  });
}

test('multi-table reasoning: relationships from declared keys, join path customers -> products', async () => {
  const tmp = `/tmp/${Date.now()}-retail_multitable.db`; fs.copyFileSync(path.join(SAMPLE, 'retail_multitable.db'), tmp);
  const ds = await ingestFile({ filePath: tmp, originalFilename: 'retail_multitable.db' });
  assert.equal(ds.schema.tables.length, 5);
  const { relationships } = analyzeSchema(ds.schema, ds.profile);
  assert.ok(relationships.length >= 4);
  const hints = renderJoinHints('Which customers generated the highest revenue from electronics products?', ds.schema, relationships);
  assert.match(hints, /customers/);
  assert.match(hints, /products/);
  assert.match(hints, /orders/);
  assert.match(hints, /order_items/);
  // the semantic layer understands each table without domain code
  const sem = ds.profile.semantic.tables.find((t) => t.name === 'products');
  assert.equal(sem.columns.find((c) => c.name === 'category').role, 'categorical');
  assert.equal(sem.columns.find((c) => c.name === 'unit_price').role, 'monetary');
});
