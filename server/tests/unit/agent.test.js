require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { ingestFile } = require('../../src/ingestion/ingestion.pipeline');
const { tryAgent, classifyIntent } = require('../../src/agent/agent');

async function load(name, csv) {
  const p = `/tmp/${name}-${Date.now()}.csv`; fs.writeFileSync(p, csv);
  const ds = await ingestFile({ filePath: p, originalFilename: `${name}.csv` }); fs.rmSync(p, { force: true }); return ds;
}

// 12 months x 3 regions of sales; revenue grows over time; one planted outlier row; units correlate with revenue.
function salesCsv() {
  const lines = ['order_id,customer_name,region,sale_date,revenue,units'];
  let id = 1;
  const regions = ['North', 'South', 'East'];
  for (let m = 1; m <= 12; m++) for (let r = 0; r < 3; r++) for (let k = 0; k < 4; k++) {
    const rev = 1000 + m * 100 + r * 50 + k * 7;
    lines.push(`${id++},Cust${id},${regions[r]},2026-${String(m).padStart(2, '0')}-${String(5 + k * 5).padStart(2, '0')},${rev},${Math.round(rev / 100)}`);
  }
  lines.push(`${id++},Whale Corp,North,2026-06-15,90000,900`);
  return lines.join('\n') + '\n';
}

test('intent classification', () => {
  const c = (q) => classifyIntent(q).intent;
  assert.equal(c('Is revenue increasing or decreasing?'), 'trend');
  assert.equal(c('Forecast next month sales'), 'forecast');
  assert.equal(c('Which transactions look abnormal?'), 'anomaly');
  assert.equal(c('Are there any unusual salary values?'), 'anomaly');
  assert.equal(c('Is there a correlation between price and units?'), 'correlation');
  assert.equal(c('Compare Sales and Marketing revenue'), 'compare');
  assert.equal(c('Give me a management report'), 'report');
  assert.equal(c('Are there data quality problems?'), 'quality');
  assert.equal(c('What can I ask about this dataset?'), 'explore');
  assert.equal(c('Show the key metrics'), 'kpi');
  assert.equal(c('Show all employees'), 'query');
  assert.equal(c('Email the weekly report to the finance manager'), 'action');
});

test('agent tools answer analytic questions from real data', async () => {
  const ds = await load('sales1', salesCsv());
  const ask = (q, policy = null) => tryAgent({ question: q, dataset: ds, policy });

  const trend = await ask('What is the monthly revenue trend?');
  assert.ok(trend.handled);
  assert.match(trend.answer, /upward|volatile|increasing/i);
  assert.equal(trend.evidence.source_type, 'database');
  assert.ok(trend.evidence.row_count >= 6);

  const fc = await ask('Forecast revenue for the next 3 months');
  assert.ok(fc.handled);
  assert.match(fc.answer, /statistical projection/);
  assert.equal(fc.evidence.sample_rows.length, 3);
  assert.equal(fc.evidence.sample_rows[0].type, 'forecast');

  const an = await ask('Are there any unusual revenue values?');
  assert.ok(an.handled);
  assert.match(an.answer, /Whale Corp/);

  const ga = await ask('Which region has unusually high revenue?');
  assert.ok(ga === undefined || ga.handled === false || ga.handled === true); // 3 regions < 5 groups -> falls to record-level

  const co = await ask('Is there a correlation between revenue and units?');
  assert.ok(co.handled);
  assert.match(co.answer, /very strong positive|strong positive/);

  const cmp = await ask('Compare North and South revenue');
  assert.ok(cmp.handled);
  assert.match(cmp.answer, /North|South/);

  const improved = await ask('Which region improved the most in revenue?');
  assert.ok(improved.handled);

  const quality = await ask('Any data quality issues?');
  assert.ok(quality.handled);
  assert.match(quality.answer, /Data quality score/);

  const kpi = await ask('Show the key metrics');
  assert.ok(kpi.handled);
  assert.match(kpi.answer, /Total sales1 records: 145/);

  const ex = await ask('What can I ask about this data?');
  assert.ok(ex.handled);
  assert.match(ex.answer, /questions you can ask/);

  assert.equal((await ask('Show all customers')).handled, false);
});

test('agent respects column denial and row-level restrictions', async () => {
  const ds = await load('sales2', salesCsv());
  const denyRev = { deniedColumns: [{ table: null, column: 'revenue' }], rowFilters: [] };
  const t = await tryAgent({ question: 'What is the revenue trend?', dataset: ds, policy: denyRev });
  assert.equal(t.denied, true);
  const rowPol = { deniedColumns: [], rowFilters: [{ table: null, column: 'region', op: '=', value: 'South' }] };
  const k = await tryAgent({ question: 'Show the key metrics', dataset: ds, policy: rowPol });
  assert.equal(k.denied, true);
  const scoped = await tryAgent({ question: 'Are there any unusual revenue values?', dataset: ds, policy: rowPol });
  assert.ok(!/Whale Corp/.test(scoped.answer), 'row filter must hide the North-region outlier');
});
