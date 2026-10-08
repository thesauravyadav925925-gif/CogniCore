require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { runBenchmark, toMarkdown } = require('../../benchmark/run');
const { DOMAINS } = require('../../benchmark/suite');

// A "perfect model" stub that answers each NL question with its ground-truth SQL: it proves the harness,
// the pipeline and the scoring work end to end (with a real model you get real accuracy via `npm run benchmark:llm`).
const truthByQuestion = new Map(DOMAINS.flatMap((d) => d.nl2sql.map((c) => [c.q, c.truth.replace(/\{t\}/g, d.table)])));
const perfect = { async complete(prompt) { const q = (prompt.match(/QUESTION:\s*(.*)\n/) || [])[1]; return truthByQuestion.get(q) || 'NO_QUERY_POSSIBLE'; } };

test('benchmark: all deterministic checks, security corpus and permission matrix pass across five domains', async () => {
  const r = await runBenchmark({ mode: 'tools', llm: perfect });
  assert.equal(r.domains.length, 5);
  assert.ok(!r.domains.some((d) => d.error));
  const failed = r.domains.flatMap((d) => d.tools.filter((t) => !t.pass).map((t) => `${d.domain}/${t.id}: ${t.note}`));
  assert.deepEqual(failed, []);
  assert.equal(r.totals.sqlSafety.refused, r.totals.sqlSafety.total);
  assert.equal(r.totals.injection.blocked, r.totals.injection.total);
  assert.equal(r.totals.injection.falsePositives, 0);
  assert.equal(r.totals.permissions.passed, r.totals.permissions.total);
  assert.equal(r.ok, true);
  assert.match(toMarkdown(r), /Overall: PASS/);
});

test('benchmark: NL->SQL scoring against SQL ground truth works (perfect-model stub scores 100%)', async () => {
  const r = await runBenchmark({ mode: 'llm', llm: perfect });
  const failed = r.domains.flatMap((d) => d.nl2sql.filter((t) => !t.pass).map((t) => `${d.domain}/${t.id}: ${t.note}`));
  assert.deepEqual(failed, []);
  assert.ok(r.totals.nl2sql.total >= 15);
});
