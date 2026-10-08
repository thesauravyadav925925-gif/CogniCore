require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { ingestFile } = require('../../src/ingestion/ingestion.pipeline');
const { buildCatalog } = require('../../src/semantic/catalog');
const { Meanings, applyMeanings } = require('../../src/semantic/meanings.store');
const { renderSemanticPrompt } = require('../../src/semantic/semantic.builder');
const { toolsFor, TOOL_CATALOG, schemaTool, profilerTool, validationTool } = require('../../src/tools/catalog');
const { buildDashboard } = require('../../src/analytics/dashboard');
const { buildManagementReport } = require('../../src/report/report.builder');
const { reportBlocks, toXlsx } = require('../../src/report/report.exporters');
const { renderChartSvg } = require('../../src/report/chart.svg');
const { selectChart } = require('../../src/analytics/viz');
const { runSafeSql } = require('../../src/agent/safe.query');
const { describeRouting, getLLMProvider } = require('../../src/llm/model.manager');

async function load(name, csv) {
  const p = `/tmp/${name}-${Date.now()}.csv`; fs.writeFileSync(p, csv);
  const ds = await ingestFile({ filePath: p, originalFilename: `${name}.csv` }); fs.rmSync(p, { force: true }); return ds;
}
const CSV = () => ['student_id,course,attendance_pct,score,term_date'].concat(Array.from({ length: 30 }, (_, i) => `${i + 1},${['Math', 'Physics', 'CS'][i % 3]},${60 + (i % 40)},${50 + (i % 45)},2026-0${(i % 6) + 1}-1${i % 9}`)).join('\n') + '\n';

test('catalog: dataset card, entities and attributes; business meanings override auto text and reach the prompt', async () => {
  const ds = await load('cat1', CSV());
  Meanings.set({ datasetId: ds.dataset_id, table: 'cat1', column: 'attendance_pct', meaning: 'percentage of classes the student attended', userId: 'u1' });
  const c = buildCatalog({ dataset: ds });
  assert.equal(c.dataset.name, 'cat1');
  assert.equal(c.dataset.tables, 1);
  assert.equal(c.dataset.total_rows, 30);
  assert.ok(c.dataset.quality_score >= 0);
  assert.equal(c.dataset.freshness.latest_record_date !== null, true);
  const attr = c.entities[0].attributes.find((a) => a.name === 'attendance_pct');
  assert.equal(attr.business_meaning, 'percentage of classes the student attended');
  assert.equal(c.entities[0].key, 'student_id');
  assert.equal(c.dataset.annotated_attributes, 1);
  const sem = applyMeanings(ds.profile.semantic, Meanings.list(ds.dataset_id));
  assert.match(renderSemanticPrompt(sem), /attendance_pct: percentage of classes the student attended/);
  const hidden = buildCatalog({ dataset: ds, policy: { deniedColumns: [{ table: null, column: 'score' }], rowFilters: [] } });
  assert.ok(!hidden.entities[0].attributes.some((a) => a.name === 'score'));
});

test('tool registry is role-filtered and the meta tools work', async () => {
  assert.ok(TOOL_CATALOG.length >= 20);
  const names = (r) => toolsFor({ role: r }).map((t) => t.name);
  assert.ok(names('viewer').includes('sql') && !names('viewer').includes('report') && !names('viewer').includes('export'));
  assert.ok(names('analyst').includes('report') && !names('analyst').includes('file') === false);
  assert.ok(names('admin').length === TOOL_CATALOG.length);
  const ds = await load('reg1', CSV());
  const sch = schemaTool(ds, null);
  assert.equal(sch.tables[0].columns.length, 5);
  assert.ok(profilerTool(ds, null).tables[0].columns.find((c) => c.name === 'score').distribution);
  assert.equal(validationTool(ds, 'SELECT COUNT(*) FROM reg1').valid, true);
  const bad = validationTool(ds, 'DROP TABLE reg1');
  assert.equal(bad.valid, false);
  const costly = validationTool(ds, 'SELECT * FROM reg1 CROSS JOIN reg1 b');
  assert.equal(costly.valid, false);
  assert.match(costly.error, /too expensive/);
});

test('model router: per-task models and optional providers, default stays local', () => {
  const rows = describeRouting();
  assert.ok(['default', 'sql', 'reasoning', 'rewrite', 'planner', 'embedding', 'rerank'].every((t) => rows.some((r) => r.task === t)));
  assert.equal(rows.find((r) => r.task === 'sql').provider, 'ollama');
  process.env.OLLAMA_MODEL_SQL = 'qwen2.5-coder:7b';
  process.env.OLLAMA_MODEL_REASONING = 'llama3.1:8b';
  assert.equal(describeRouting().find((r) => r.task === 'sql').model, 'qwen2.5-coder:7b');
  assert.notEqual(getLLMProvider('sql'), getLLMProvider('reasoning'));
  process.env.LLM_PROVIDER_PLANNER = 'openai';
  assert.match(getLLMProvider('planner').name, /^openai:/);
  process.env.LLM_PROVIDER_PLANNER = 'bogus';
  assert.throws(() => getLLMProvider('planner'), /Unknown LLM provider/);
  delete process.env.LLM_PROVIDER_PLANNER; delete process.env.OLLAMA_MODEL_SQL; delete process.env.OLLAMA_MODEL_REASONING;
});

test('dashboard panels are valid SQL, honour filters (drill-down) and render charts', async () => {
  const ds = await load('dash1', CSV());
  const d = buildDashboard({ dataset: ds });
  assert.ok(d.panels.length >= 4);
  assert.ok(d.filters.some((f) => f.column === 'course'));
  for (const p of d.panels) {
    const res = await runSafeSql({ dataset: ds, sql: p.sql });
    assert.ok(res.rowCount > 0, p.title);
    const spec = selectChart({ question: p.question, columns: res.columns, rows: res.rows });
    assert.notEqual(spec.type, 'none', p.title);
    if (!['table', 'kpi'].includes(spec.type)) assert.match(renderChartSvg(spec, res), /<svg/);
  }
  const drilled = buildDashboard({ dataset: ds, filters: { course: 'Math' } });
  assert.ok(drilled.panels.every((p) => p.sql.includes("\"course\" = 'Math'")));
  const total = (await runSafeSql({ dataset: ds, sql: drilled.panels.find((p) => p.id.endsWith('composition')).sql })).rows.reduce((s, r) => s + r.records, 0);
  assert.equal(total, 10);
  const restricted = buildDashboard({ dataset: ds, policy: { deniedColumns: [{ table: null, column: 'score' }], rowFilters: [] } });
  assert.ok(restricted.panels.every((p) => !p.sql.includes('"score"')));
});

test('report includes anomalies section and an evidence appendix with every query', async () => {
  const ds = await load('rep2', CSV() + '99,Math,99,5000000,2026-03-01\n');
  const r = await buildManagementReport({ dataset: ds });
  assert.ok(r.anomalies.length >= 1);
  assert.ok(r.appendix.queries.length >= 4 && r.appendix.queries.every((q) => /SELECT/i.test(q.sql)));
  assert.ok(r.appendix.methodology.length >= 3);
  const heads = reportBlocks(r).filter((b) => b.type === 'h1').map((b) => b.text);
  assert.ok(heads.includes('Anomalies') && heads.includes('Appendix: Evidence & Methodology'));
  assert.equal(typeof toXlsx, 'function'); // workbook writing needs the real xlsx package (covered when you run npm test)
});
