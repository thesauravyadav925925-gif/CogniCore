require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { ingestFile } = require('../../src/ingestion/ingestion.pipeline');
const { createAdapter } = require('../../src/ingestion/adapters');
const { generateKpis } = require('../../src/analytics/kpi');
const { selectChart, histogramBins } = require('../../src/analytics/viz');
const { exploreQuestions, followUpSuggestions } = require('../../src/analytics/exploration');
const { runDataScience } = require('../../src/python/python.tool');

async function load(name, csv) {
  const p = `/tmp/${name}-${Date.now()}.csv`; fs.writeFileSync(p, csv);
  const ds = await ingestFile({ filePath: p, originalFilename: `${name}.csv` }); fs.rmSync(p, { force: true }); return ds;
}
const CSV = ['appt_id,doctor,department,status,fee,visit_date'].concat(
  Array.from({ length: 24 }, (_, i) => `${i + 1},Dr${i % 4},${['Cardiology', 'Neurology', 'Orthopedics'][i % 3]},${['Completed', 'Cancelled', 'Completed', 'No-show'][i % 4]},${100 + i * 10},2026-0${(i % 4) + 1}-1${i % 9}`)).join('\n') + '\n';

test('KPIs are derived from column roles with traceable SQL', async () => {
  const ds = await load('kpi1', CSV);
  const adapter = createAdapter(ds.type, { datasetId: ds.dataset_id, location: ds.location });
  await adapter.connect();
  const groups = await generateKpis({ adapter, semantic: ds.profile.semantic, datasetType: ds.type });
  await adapter.disconnect();
  const k = Object.fromEntries(groups[0].kpis.map((x) => [x.id, x]));
  assert.equal(k['kpi1:count'].value, 24);
  assert.equal(k['kpi1:sum:fee'].value, 24 * 100 + 10 * (23 * 24 / 2));
  const completed = groups[0].kpis.find((x) => x.kind === 'rate' && x.value !== null && /Completed/.test(x.label));
  assert.equal(completed.value, 50);
  assert.ok(groups[0].kpis.find((x) => x.kind === 'growth'));
  assert.ok(groups[0].kpis.every((x) => x.kind === 'quality' || x.sql));
});

test('chart selection follows result shape', () => {
  assert.equal(selectChart({ columns: ['total'], rows: [{ total: 5 }] }).type, 'kpi');
  assert.equal(selectChart({ question: 'monthly revenue', columns: ['month', 'revenue'], rows: [{ month: '2026-01', revenue: 1 }, { month: '2026-02', revenue: 2 }, { month: '2026-03', revenue: 3 }] }).type, 'line');
  assert.equal(selectChart({ question: 'revenue by department', columns: ['department', 'revenue'], rows: [{ department: 'A', revenue: 1 }, { department: 'B', revenue: 2 }] }).type, 'bar');
  assert.equal(selectChart({ question: 'expense distribution', columns: ['category', 'amount'], rows: [{ category: 'A', amount: 1 }, { category: 'B', amount: 2 }, { category: 'C', amount: 3 }] }).type, 'pie');
  assert.equal(selectChart({ columns: ['a', 'b'], rows: Array.from({ length: 12 }, (_, i) => ({ a: i, b: i * 2 })), question: 'a vs b' }).type, 'scatter');
  assert.equal(selectChart({ columns: ['salary'], rows: Array.from({ length: 30 }, (_, i) => ({ salary: 100 + i })) }).type, 'histogram');
  assert.equal(histogramBins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5).reduce((s, b) => s + b.count, 0), 10);
});

test('exploration questions come from the semantic model; suggestions from the answer', async () => {
  const ds = await load('exp1', CSV);
  const qs = exploreQuestions(ds.profile.semantic);
  assert.ok(qs.length >= 8);
  assert.ok(qs.some((q) => /percentage of records have status/i.test(q.question)));
  assert.ok(qs.some((q) => /Forecast fee/i.test(q.question)));
  const s = followUpSuggestions({ question: 'appointments by department', evidence: { source_type: 'database', columns: ['department', 'total'], sample_rows: [{ department: 'Cardiology', total: 9 }, { department: 'Neurology', total: 7 }] } });
  assert.ok(s.includes('Compare Cardiology with Neurology.'));
});

test('python tool runs the whitelisted worker (or the JS fallback) and rejects unknown ops', async () => {
  const r = await runDataScience({ op: 'correlation', columns: { a: [1, 2, 3, 4, 5], b: [2, 4, 6, 8, 10.5], c: [5, 4, 3, 2, 1] } });
  assert.ok(['python', 'javascript-fallback'].includes(r.engine));
  const ab = r.result.pairs.find((p) => p.a === 'a' && p.b === 'b');
  assert.equal(ab.direction, 'positive');
  const f = await runDataScience({ op: 'forecast', values: [1, 2, 3, 4, 5, 6], horizon: 2 });
  assert.ok(Math.abs(f.result.predictions[0].value - 7) < 0.01);
  const o = await runDataScience({ op: 'outliers', values: [10, 11, 10, 12, 11, 10, 300] });
  assert.equal(o.result.outliers[0].index, 6);
  await assert.rejects(() => runDataScience({ op: '__import__("os").system("id")' }), /op must be one of/);
});
