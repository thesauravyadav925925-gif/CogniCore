require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { ingestFile } = require('../../src/ingestion/ingestion.pipeline');
const { buildManagementReport } = require('../../src/report/report.builder');
const { reportBlocks, toDocx } = require('../../src/report/report.exporters');
const { renderChartSvg } = require('../../src/report/chart.svg');
const { selectChart } = require('../../src/analytics/viz');

async function load(name, csv) {
  const p = `/tmp/${name}-${Date.now()}.csv`; fs.writeFileSync(p, csv);
  const ds = await ingestFile({ filePath: p, originalFilename: `${name}.csv` }); fs.rmSync(p, { force: true }); return ds;
}
function csv() {
  const l = ['txn_id,branch,txn_date,amount,status'];
  let id = 1;
  const branches = ['Chennai', 'Coimbatore', 'Madurai'];
  for (let m = 1; m <= 10; m++) for (let b = 0; b < 3; b++) for (let k = 0; k < 3; k++) {
    const amt = b === 0 ? 5000 - m * 300 + k : 2000 + m * 50 + k; // Chennai declines
    l.push(`${id++},${branches[b]},2026-${String(m).padStart(2, '0')}-${10 + k},${amt},${k === 2 ? 'Failed' : 'Success'}`);
  }
  l.push(`${id++},Madurai,2026-05-20,250000,Success`);
  l.push(`${id - 1},Madurai,2026-05-20,250000,Success`); // duplicate row
  return l.join('\n') + '\n';
}

test('management report has all sections with computed content', async () => {
  const ds = await load('fin1', csv());
  const r = await buildManagementReport({ dataset: ds });
  assert.match(r.executiveSummary, /records from/);
  assert.ok(r.keyMetrics.length >= 5);
  assert.ok(r.trends.length === 1 && r.trends[0].data.length >= 6);
  assert.ok(r.categoryAnalysis[0].sentence.includes('leads'));
  assert.ok(r.problems.some((p) => p.type === 'duplicate_rows'));
  assert.ok(r.problems.some((p) => p.type === 'anomaly'));
  assert.ok(r.recommendations.length >= 2);
  assert.ok(r.supportingData.length >= 2);
  const blocks = reportBlocks(r);
  assert.ok(['Executive Summary', 'Key Metrics', 'Major Trends', 'Problems Identified', 'Recommendations / Areas for Investigation', 'Supporting Data'].every((h) => blocks.some((b) => b.type === 'h1' && b.text === h)));
  const docx = toDocx(r);
  assert.equal(docx.slice(0, 2).toString(), 'PK');
});

test('report is refused for row-restricted roles', async () => {
  const ds = await load('fin2', csv());
  await assert.rejects(() => buildManagementReport({ dataset: ds, policy: { deniedColumns: [], rowFilters: [{ table: null, column: 'branch', op: '=', value: 'Chennai' }] } }), /row-level restrictions/);
});

test('SVG charts render for every chart type', () => {
  const cases = [
    [{ type: 'bar', x: 'c', y: ['v'], title: 'T' }, [{ c: 'A', v: 1 }, { c: 'B', v: 3 }]],
    [{ type: 'horizontal_bar', x: 'c', y: ['v'], title: 'T' }, [{ c: 'A', v: 1 }, { c: 'B', v: 3 }]],
    [{ type: 'line', x: 'm', y: ['v'], title: 'T' }, [{ m: '2026-01', v: 1 }, { m: '2026-02', v: 3 }, { m: '2026-03', v: 2 }]],
    [{ type: 'area', x: 'm', y: ['v'], title: 'T' }, [{ m: '2026-01', v: 1 }, { m: '2026-02', v: 3 }]],
    [{ type: 'pie', label: 'c', value: 'v', title: 'T' }, [{ c: 'A', v: 1 }, { c: 'B', v: 3 }]],
    [{ type: 'scatter', x: 'a', y: 'b', title: 'T' }, [{ a: 1, b: 2 }, { a: 2, b: 5 }, { a: 3, b: 4 }]],
    [{ type: 'histogram', value: 'v', bins: 3, title: 'T' }, [{ v: 1 }, { v: 2 }, { v: 2 }, { v: 9 }]],
    [{ type: 'stacked_bar', x: 'c', series: 's', y: 'v', title: 'T' }, [{ c: 'A', s: 'x', v: 1 }, { c: 'A', s: 'y', v: 2 }, { c: 'B', s: 'x', v: 3 }]],
    [{ type: 'multi_line', x: 'm', series: 's', y: 'v', title: 'T' }, [{ m: '1', s: 'x', v: 1 }, { m: '2', s: 'x', v: 2 }, { m: '1', s: 'y', v: 3 }, { m: '2', s: 'y', v: 1 }]],
    [{ type: 'kpi', cards: [{ label: 'Total', value: 1234.5 }] }, []],
  ];
  for (const [spec, rows] of cases) {
    const svg = renderChartSvg(spec, { rows });
    assert.match(svg, /^<svg[\s\S]*<\/svg>$/, spec.type);
    assert.ok(!svg.includes('NaN'), `${spec.type} produced NaN`);
  }
});
