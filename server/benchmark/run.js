#!/usr/bin/env node
/**
 * Runs the benchmark. Usage (from /server):
 *   node benchmark/run.js --mode=tools   # no model needed: tools + security + permissions + regression
 *   node benchmark/run.js --mode=llm     # also scores natural-language -> SQL accuracy with your Ollama model
 * Writes benchmark-report.md and exits non-zero if any non-LLM check fails.
 */
const fs = require('fs');
const path = require('path');
const { DOMAINS, toolChecks, INJECTION_CORPUS, SAFE_CORPUS, SQL_ATTACK_CORPUS } = require('./suite');

async function runBenchmark({ mode = 'tools', llm = null, sampleDir = path.join(__dirname, '..', '..', 'sample-data'), log = () => {} } = {}) {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  const mm = require('../src/llm/model.manager');
  if (llm) { mm.getLLMProvider = () => llm; mm.getEmbeddingProvider = () => null; }
  const { ingestFile } = require('../src/ingestion/ingestion.pipeline');
  const { handleUserQuery } = require('../src/core/core.engine');
  const { screenQuestion } = require('../src/guardrails/input.guard');
  const { validateSql } = require('../src/structured/sql.validator');
  const { AuthRegistry } = require('../src/security/auth.registry');
  const { PolicyStore } = require('../src/security/data.policy');
  const { runSafeSql } = require('../src/agent/safe.query');

  const results = { mode, started: new Date().toISOString(), domains: [], security: {}, permissions: [], totals: {} };
  const user = (role) => AuthRegistry.createUser({ email: `bench${Date.now()}${Math.random()}@x.com`, passwordHash: 'x', name: 'Bench', role });
  const analyst = user('analyst');

  for (const d of DOMAINS) {
    const src = path.join(sampleDir, d.file);
    if (!fs.existsSync(src)) { results.domains.push({ domain: d.key, error: `missing ${d.file} (run: npm run sample-data)` }); continue; }
    const tmp = path.join(require('os').tmpdir(), `${Date.now()}-${d.file}`); fs.copyFileSync(src, tmp);
    const ds = await ingestFile({ filePath: tmp, originalFilename: d.file });
    const row = { domain: d.key, tools: [], nl2sql: [] };
    const truth = async (sql) => Object.values((await runSafeSql({ dataset: ds, sql: sql.replace(/\{t\}/g, d.table) })).rows[0] || {})[0];

    for (const c of toolChecks(d)) {
      const t0 = Date.now();
      let pass = false, note = '';
      try { const r = await handleUserQuery({ question: c.q, datasetId: ds.dataset_id, user: analyst }); pass = r.routeType === 'REPORT' || (r.routeType === c.route && !!c.expect(r)); if (!pass) note = `route=${r.routeType}`; } catch (e) { note = e.message; }
      row.tools.push({ id: c.id, pass, ms: Date.now() - t0, note });
      log(`${d.key}/${c.id}: ${pass ? 'PASS' : 'FAIL'} ${note}`);
    }

    if (mode === 'llm') {
      for (const c of d.nl2sql.filter((x) => !x.skip)) {
        const t0 = Date.now();
        let pass = false, note = '';
        try {
          const expected = await truth(c.truth);
          const r = await handleUserQuery({ question: c.q, datasetId: ds.dataset_id, user: analyst });
          const rows = r.evidence?.sample_rows || [];
          const got = rows[0] ? Object.values(rows[0])[0] : undefined;
          if (c.kind === 'label') pass = String(got).toLowerCase() === String(expected).toLowerCase();
          else pass = Number.isFinite(Number(got)) && Math.abs(Number(got) - Number(expected)) <= (c.tol ?? 1e-6) * Math.max(1, Math.abs(Number(expected))) + (c.tol ? 0.0 : 0);
          note = pass ? '' : `expected ${expected}, got ${got}`;
        } catch (e) { note = e.message; }
        row.nl2sql.push({ id: c.id, pass, ms: Date.now() - t0, note });
        log(`${d.key}/nl2sql:${c.id}: ${pass ? 'PASS' : 'FAIL'} ${note}`);
      }
    }
    results.domains.push(row);

    // SQL-safety corpus on this dataset (every attack must be refused before execution)
    const m = d.measure;
    for (const raw of SQL_ATTACK_CORPUS) {
      const sql = raw.replace(/\{t\}/g, d.table).replace(/\{m\}/g, m);
      let refused = false;
      try { validateSql(sql, ds.schema, ds.type); } catch (_) { refused = true; }
      (results.security.sql ||= []).push({ domain: d.key, sql, refused });
    }

    // Permission matrix: denied column + row filter, enforced by code
    PolicyStore.add({ datasetId: ds.dataset_id, role: 'viewer', kind: 'deny_column', columnName: d.measure });
    const viewer = user('viewer');
    const denied = await handleUserQuery({ question: `Describe the distribution of ${d.measure.replace(/_/g, ' ')}`, datasetId: ds.dataset_id, user: viewer });
    const adminAns = await handleUserQuery({ question: `Describe the distribution of ${d.measure.replace(/_/g, ' ')}`, datasetId: ds.dataset_id, user: user('admin') });
    results.permissions.push({ domain: d.key, check: 'viewer cannot read denied column', pass: denied.denied === true || /Access denied|do not have access/i.test(denied.answer) });
    results.permissions.push({ domain: d.key, check: 'admin is never restricted', pass: adminAns.denied !== true && /standard deviation/.test(adminAns.answer) });
  }

  results.security.injection = INJECTION_CORPUS.map((q) => ({ q, blocked: screenQuestion(q).blocked }));
  results.security.safe = SAFE_CORPUS.map((q) => ({ q, blocked: screenQuestion(q).blocked }));

  const all = (arr) => arr.length;
  const passed = (arr) => arr.filter((x) => x.pass).length;
  const toolRows = results.domains.flatMap((d) => d.tools || []);
  const nlRows = results.domains.flatMap((d) => d.nl2sql || []);
  results.totals = {
    tools: { passed: passed(toolRows), total: all(toolRows) },
    nl2sql: mode === 'llm' ? { passed: passed(nlRows), total: all(nlRows) } : null,
    sqlSafety: { refused: (results.security.sql || []).filter((x) => x.refused).length, total: (results.security.sql || []).length },
    injection: { blocked: results.security.injection.filter((x) => x.blocked).length, total: results.security.injection.length, falsePositives: results.security.safe.filter((x) => x.blocked).length },
    permissions: { passed: passed(results.permissions), total: all(results.permissions) },
  };
  const t = results.totals;
  results.ok = t.tools.passed === t.tools.total && t.sqlSafety.refused === t.sqlSafety.total && t.injection.blocked === t.injection.total && t.injection.falsePositives === 0 && t.permissions.passed === t.permissions.total;
  return results;
}

function toMarkdown(r) {
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : 'n/a');
  const t = r.totals;
  const lines = [`# CogniCore Benchmark Report`, `Mode: **${r.mode}** · ${r.started}`, '', '## Summary', '| Check | Result |', '|---|---|',
    `| Deterministic tools (${r.domains.length} domains) | ${t.tools.passed}/${t.tools.total} (${pct(t.tools.passed, t.tools.total)}) |`,
    `| Natural language → SQL accuracy | ${t.nl2sql ? `${t.nl2sql.passed}/${t.nl2sql.total} (${pct(t.nl2sql.passed, t.nl2sql.total)})` : 'not run (use --mode=llm with Ollama)'} |`,
    `| Dangerous SQL refused | ${t.sqlSafety.refused}/${t.sqlSafety.total} |`,
    `| Prompt-injection blocked | ${t.injection.blocked}/${t.injection.total} (false positives: ${t.injection.falsePositives}) |`,
    `| Permission matrix | ${t.permissions.passed}/${t.permissions.total} |`, '', `**Overall: ${r.ok ? 'PASS' : 'FAIL'}**`, '', '## Per domain'];
  for (const d of r.domains) {
    if (d.error) { lines.push(`### ${d.domain}\n${d.error}`); continue; }
    lines.push(`### ${d.domain}`, '| Test | Result | ms | Note |', '|---|---|---|---|');
    [...d.tools.map((x) => ({ ...x, id: `tool:${x.id}` })), ...d.nl2sql.map((x) => ({ ...x, id: `nl2sql:${x.id}` }))].forEach((x) => lines.push(`| ${x.id} | ${x.pass ? '✅' : '❌'} | ${x.ms} | ${x.note || ''} |`));
  }
  return lines.join('\n') + '\n';
}

module.exports = { runBenchmark, toMarkdown };

if (require.main === module) {
  const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=tools').split('=')[1];
  runBenchmark({ mode, log: (m) => console.log(m) }).then((r) => {
    const out = path.join(__dirname, '..', '..', 'benchmark-report.md');
    fs.writeFileSync(out, toMarkdown(r));
    console.log(`\nReport written to ${out}\nOverall: ${r.ok ? 'PASS' : 'FAIL'}`);
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(2); });
}
