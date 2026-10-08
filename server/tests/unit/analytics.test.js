const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/analytics/stats');
const A = require('../../src/analytics/anomaly');
const T = require('../../src/analytics/trend');
const F = require('../../src/analytics/forecast');
const C = require('../../src/analytics/compare');
const { generateInsights } = require('../../src/analytics/insights');

test('stats primitives', () => {
  assert.equal(S.mean([1, 2, 3]), 2);
  assert.equal(S.median([1, 9, 3]), 3);
  assert.equal(S.round(S.pctChange(50, 59), 2), 18);
  assert.equal(S.pctChange(0, 5), null);
  assert.ok(Math.abs(S.pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
  assert.deepEqual(S.movingAverage([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.deepEqual(S.cumulative([1, 2, 3]), [1, 3, 6]);
});

test('anomaly detection: IQR/MAD/z flag the planted outlier, time-series flags a spike', () => {
  const v = [10, 11, 9, 10, 12, 10, 11, 9, 10, 500];
  assert.equal(A.detectIqr(v)[0].index, 9);
  assert.equal(A.detectMad(v)[0].index, 9);
  const merged = A.detectAnomalies(v);
  assert.equal(merged[0].index, 9);
  assert.equal(merged[0].confidence, 'high');
  const ts = A.detectTimeSeries([100, 102, 99, 101, 100, 98, 101, 160, 100]);
  assert.equal(ts[0].index, 7);
  assert.equal(ts[0].direction, 'spike');
  assert.deepEqual(A.detectIqr([5, 5, 5, 5, 5]), []);
});

test('isolation forest isolates a multivariate outlier', () => {
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push([50 + (i % 7), 200 + (i % 5)]);
  rows.push([500, 5]);
  const r = A.isolationForest(rows);
  assert.ok(r.anomalies.some((a) => a.index === 100), 'planted outlier should be flagged');
});

test('trend analysis and description', () => {
  const up = [10, 12, 14, 15, 18, 21].map((value, i) => ({ label: `2026-0${i + 1}`, value }));
  const t = T.analyzeTrend(up);
  assert.equal(t.direction, 'increasing');
  assert.equal(t.totalChangePct, 110);
  assert.match(T.describeTrend(t, { measure: 'revenue' }), /upward/);
  assert.equal(T.analyzeTrend([{ label: 'a', value: 1 }]).direction, 'insufficient_data');
  const b = T.bucketSeries([{ date: '2026-01-05', value: 1 }, { date: '2026-01-20', value: 2 }, { date: '2026-02-03', value: 5 }], { grain: 'month' });
  assert.deepEqual(b.series, [{ label: '2026-01', value: 3 }, { label: '2026-02', value: 5 }]);
  const rank = T.rankByImprovement({ A: [{ label: '1', value: 1 }, { label: '2', value: 9 }], B: [{ label: '1', value: 5 }, { label: '2', value: 4 }] });
  assert.equal(rank[0].name, 'A');
});

test('forecast is labelled, backtested and sane on a linear series', () => {
  const values = [100, 110, 120, 130, 140, 150, 160, 170];
  const f = F.forecast(values, { horizon: 2 });
  assert.equal(f.type, 'forecast');
  assert.ok(Math.abs(f.predictions[0].value - 180) < 5, `got ${f.predictions[0].value}`);
  assert.ok(f.predictions[0].lower <= f.predictions[0].value && f.predictions[0].upper >= f.predictions[0].value);
  assert.ok(f.disclaimer);
  assert.ok(F.forecast([1, 2], { horizon: 1 }).error);
  assert.deepEqual(F.nextLabels('2026-11', 'month', 3), ['2026-12', '2027-01', '2027-02']);
  const seasonal = [10, 20, 10, 20, 10, 20, 10, 20, 10, 20, 10, 20];
  const fs = F.forecast(seasonal, { horizon: 2, seasonLength: 2 });
  assert.ok(fs.predictions[0].value < fs.predictions[1].value, 'seasonal pattern low then high');
});

test('comparisons are deterministic', () => {
  const c = C.compareTwo({ label: '2025', value: 200 }, { label: '2026', value: 250 }, { measure: 'revenue' });
  assert.equal(c.difference, 50);
  assert.equal(c.percentChange, 25);
  assert.equal(c.leader, '2026');
  const g = C.compareGroups([{ label: 'Sales', value: 30 }, { label: 'Marketing', value: 70 }]);
  assert.equal(g.leader, 'Marketing');
  assert.equal(g.items[0].shareOfTotalPct, 70);
});

test('insights: period change, concentration and extremes from a result set', () => {
  const ev = { source_type: 'database', row_count: 4, columns: ['month', 'revenue'], sample_rows: [
    { month: '2026-01', revenue: 100 }, { month: '2026-02', revenue: 110 }, { month: '2026-03', revenue: 118 }, { month: '2026-04', revenue: 150 }] };
  const ins = generateInsights(ev);
  const change = ins.find((i) => i.kind === 'period_change');
  assert.match(change.text, /increased 27\.12%|increased 27\.1/);
  const ev2 = { source_type: 'database', row_count: 3, columns: ['dept', 'total'], sample_rows: [{ dept: 'A', total: 900 }, { dept: 'B', total: 50 }, { dept: 'C', total: 50 }] };
  const ins2 = generateInsights(ev2);
  assert.ok(ins2.some((i) => i.kind === 'concentration' && /90%/.test(i.text)));
  assert.ok(ins2.some((i) => i.kind === 'highest'));
});
