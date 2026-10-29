'use strict';

/**
 * S4 RUNNER — Dependency and Relationship Leakage (per PREREG_S4)
 *
 * Deterministic, zero LLM. Two parts:
 *   Part A (O4-1): 3 declared FD arms x 4 preregistered allowed-column queries
 *     + 2 control queries = 14 executions. Oracle reconstructs denied dependent
 *     cells from released rows (exact declared-FD inference; chained variant is
 *     a recorded secondary).
 *   Part B (O4-2): 10 preregistered referential probes (unjoined no-tenant-key
 *     child, joins, subqueries, FK chains depth 1-3, orphan probes, unfiltered
 *     listings) compared against a materialised PURGED CLONE DATABASE: the
 *     identical SQL executes on both the sandbox and the clone and result
 *     MULTISETS are compared (C1 fix, 2026-10-27 — projection/JOIN-safe;
 *     formerly a full-row comparison that guaranteed LEAK). Purged snapshot
 *     counts + orphan accounting still reported from buildPurgedSnapshot.
 *   O4-3: CanaryScanner cross-check over all released rows (canaries are
 *     belt-and-braces; their absence in the fixture degrades honestly).
 *
 * Ladder: --rung 6f2dd4c | 8205910 | HEAD (PREREG_S4 §7).
 * Preflight aborts (exit 2) when the fixture or declarations are missing, and
 * (exit 3) when the fixture SHA-256 does not match the declarations record,
 * unless --dry-run (which executes nothing).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const JsonlLogger = require('../oracles/jsonl_logger');
const ManifestWriter = require('../oracles/manifest_writer');
const SandboxManager = require('../oracles/sandbox_manager');
const CanaryScanner = require('../oracles/canary_scanner');
const StatsCalculator = require('../oracles/stats');
const { S4InferenceOracle, buildPurgedSnapshot, materializePurgedClone } = require('../oracles/s4_inference_oracle');

const SPEC_RUNGS = ['6f2dd4c', '8205910', 'HEAD'];
const DECLARATIONS_PATH = path.resolve(__dirname, '../../data/s4/fd_declarations.json');
const FIXTURE_PATH = path.resolve(__dirname, '../../data/fixtures/fd_leak.sqlite');
const PART_A_EXPECTED = 14; // PREREG_S4 §6
const PART_B_EXPECTED = 10; // PREREG_S4 §6

function extractSchema(db) {
  const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const tables = tableNames.map((name) => {
    const cols = db.prepare(`PRAGMA table_info("${String(name).replace(/"/g, '""')}")`).all().map((c) => ({
      name: c.name, type: c.type, nullable: !c.notnull, primaryKey: Boolean(c.pk),
    }));
    return { name, columns: cols };
  });
  return { tables };
}

function collectCanaryTokens(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const tokens = [];
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info("${String(t).replace(/"/g, '""')}")`).all().map((c) => c.name);
      for (const c of cols) {
        const rows = db.prepare(`SELECT "${String(c).replace(/"/g, '""')}" AS v FROM "${String(t).replace(/"/g, '""')}"`).all();
        for (const r of rows) {
          const m = /CANARY_[A-Za-z0-9_]+/.exec(String(r.v ?? ''));
          if (m) tokens.push({ token: m[0], table: t, column: c, role: 'employee' });
        }
      }
    }
  } finally { db.close(); }
  return tokens;
}

async function runS4Suite(opts = {}) {
  const rung = opts.rung || 'HEAD';
  const worktreeDir = rung === 'HEAD'
    ? path.resolve(__dirname, '../../../')
    : path.resolve(__dirname, `../../../../cognicore-ladder/${rung}`);
  const dryRun = Boolean(opts.dryRun);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(__dirname, `../../runs/${timestamp}_s4_${rung}`);
  const logger = new JsonlLogger(runDir, 's4_results.jsonl');
  const failSummary = (error, code) => {
    const s = { suite: 'S4', rung, valid: false, error, runDir };
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 's4_summary.json'), JSON.stringify(s, null, 2), 'utf8');
    if (require.main === module) process.exitCode = code;
    return s;
  };

  console.log(`=== S4 (Dependency & Relationship Leakage, deterministic) — rung ${rung} ===`);
  console.log(`Worktree: ${worktreeDir}\nDeclarations: ${DECLARATIONS_PATH}\nFixture: ${FIXTURE_PATH}`);

  const { validateSql } = require(path.resolve(worktreeDir, 'server/src/structured/sql.validator.js'));
  const { executeValidatedQuery } = require(path.resolve(worktreeDir, 'server/src/structured/sql.executor.js'));
  const { enforcePolicy, PolicyError } = require(path.resolve(worktreeDir, 'server/src/security/data.policy.js'));

  // --- Declarations (strict; emitted by setup/09 and committed) ------------
  if (!fs.existsSync(DECLARATIONS_PATH)) {
    return failSummary(`Declarations missing at ${DECLARATIONS_PATH} — run harness/setup/09_build_fd_fixture.js and commit both artifacts first.`, 2);
  }
  const declarations = JSON.parse(fs.readFileSync(DECLARATIONS_PATH, 'utf8'));

  // --- Fixture preflight (SHA-256 pinned to declarations) -------------------
  const fixtureExists = fs.existsSync(FIXTURE_PATH);
  let fixtureSha = null;
  if (fixtureExists) {
    fixtureSha = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE_PATH)).digest('hex');
  }
  if (!dryRun) {
    if (!fixtureExists) {
      return failSummary(`Preflight: fixture missing at ${FIXTURE_PATH} — run harness/setup/09_build_fd_fixture.js and commit the built file.`, 2);
    }
    if (fixtureSha !== declarations.fixtureSha256) {
      return failSummary(`Fixture SHA-256 ${fixtureSha} != declarations ${declarations.fixtureSha256}. Rebuild via setup/09 and re-commit, or file a dated prereg amendment.`, 3);
    }
  } else if (!fixtureExists) {
    console.log('DRY-RUN: fixture missing (preflight waived).');
  }

  fs.mkdirSync(runDir, { recursive: true });
  ManifestWriter.writeManifest(runDir, {
    suite: 'S4', rung, worktree: worktreeDir, dryRun,
    declarationsPath: DECLARATIONS_PATH, fixturePath: FIXTURE_PATH, fixtureSha256: fixtureSha,
    specRungs: SPEC_RUNGS,
  }, fixtureExists ? [FIXTURE_PATH, DECLARATIONS_PATH] : [DECLARATIONS_PATH]);

  const policy = declarations.policy;
  const totals = declarations.totals || { partAQueryExecutions: PART_A_EXPECTED, partBQueries: PART_B_EXPECTED };

  const partAVerdicts = {};
  const partBVerdicts = {};
  let partAEvaluated = 0;
  let partBEvaluated = 0;
  let partBLeaks = 0;
  const releasedByArm = new Map(); // fdId -> union of released rows (with source query id)
  let processedCount = 0;
  const totalExecutions = (totals.partAQueryExecutions || PART_A_EXPECTED) + (totals.partBQueries || PART_B_EXPECTED);

  const execOne = async (queryId, sql, sandboxDbPath, schema) => {
    let execSql = sql;
    try {
      validateSql(execSql, schema, 'sqlite');
      execSql = enforcePolicy({ sql: execSql, schema, policy, datasetType: 'sqlite' });
    } catch (err) {
      const stop = err instanceof PolicyError || (err && err.name === 'PolicyError') ? 'POLICY_BLOCKED' : 'PARSER_OR_VALIDATOR_BLOCKED';
      return { status: 'BLOCKED', stop, error: err.message };
    }
    try {
      const adapter = { location: sandboxDbPath, datasetType: 'sqlite', db: true };
      const res = await executeValidatedQuery(adapter, execSql, { maxRows: 2000, timeoutMs: 15000 });
      return { status: 'EXECUTED', columns: res.columns, rows: res.rows, rowCount: res.rowCount, execSql };
    } catch (err) {
      return { status: 'EXECUTION_ERROR', stop: /timed out/i.test(err.message) ? 'TIMEOUT_ABORTED' : 'EXECUTOR_ERROR', error: err.message };
    }
  };

  // ==========================================================================
  // PART A — FD reconstruction (O4-1)
  // ==========================================================================
  let fixtureTruthLoaded = false;
  if (fixtureExists) {
    const db = new Database(FIXTURE_PATH, { readonly: true });
    try {
      const empRows = db.prepare('SELECT * FROM employees').all();
      oracle.setFixtureTruth(empRows, declarations.identityColumn);
      fixtureTruthLoaded = true;
    } finally { db.close(); }
  }

  for (const [armId, queries] of Object.entries(declarations.partA)) {
    for (const q of queries) {
      processedCount++;
      const base = { part: 'A', arm: armId, queryId: q.id, sql: q.sql, rung };
      if (dryRun) {
        logger.log({ ...base, status: 'DRY_RUN' });
        logger.saveCheckpoint({ processedCount, total: totalExecutions });
        continue;
      }
      partAEvaluated++;
      const sb = SandboxManager.createSandbox(FIXTURE_PATH, `s4_a_${q.id.replace(/[^A-Za-z0-9]/g, '_')}_`);
      let record;
      try {
        const dbHandle = new Database(sb.dbPath, { readonly: true });
        const schema = extractSchema(dbHandle);
        dbHandle.close();
        const res = await execOne(q.id, q.sql, sb.dbPath, schema);
        if (res.status === 'EXECUTED') {
          const bucket = releasedByArm.get(armId) || [];
          for (const row of res.rows) bucket.push({ ...row, __sourceQuery: q.id });
          releasedByArm.set(armId, bucket);
          record = { ...base, status: 'EXECUTED', rowsReleased: res.rowCount, columns: res.columns };
        } else if (res.status === 'BLOCKED') {
          record = { ...base, status: 'OVER_BLOCKED', stop: res.stop, error: res.error };
        } else {
          record = { ...base, status: 'EXECUTION_ERROR', stop: res.stop, error: res.error };
        }
      } finally { sb.cleanup(); }
      logger.log(record);
      logger.saveCheckpoint({ processedCount, total: totalExecutions });
    }
  }

  // Per-arm oracle assessment (after all arm queries executed).
  // PREREG_S4 §6 verdict vocabulary: FD_LEAK / PARTIAL_RECONSTRUCTION /
  // NO_RECONSTRUCTION / OVER_BLOCKED / EXECUTION_ERROR / ORACLE_INCOMPLETE.
  const armOutcomes = {};
  if (!dryRun) {
    for (const dep of declarations.dependencies) {
      const armKey = `fd_${dep.id.split('-')[1].toLowerCase()}`;
      const released = (releasedByArm.get(armKey) || []);
      const direct = oracle.reconstructDirect(released, dep, oracle.truthById, declarations.identityColumn, null);
      const chained = dep.preDependencies && dep.preDependencies.length
        ? oracle.reconstructChained(released, dep, declarations.identityColumn)
        : null;
      let verdict = direct.outcome === 'FULL_RECONSTRUCTION' ? 'FD_LEAK'
        : direct.outcome === 'PARTIAL_RECONSTRUCTION' ? 'PARTIAL_RECONSTRUCTION'
        : direct.outcome === 'ORACLE_INCOMPLETE' ? 'ORACLE_INCOMPLETE'
        : direct.outcome === 'NO_ROWS_RELEASED' ? 'OVER_BLOCKED'
        : 'NO_RECONSTRUCTION';
      if (verdict === 'NO_RECONSTRUCTION' && released.length === 0) verdict = 'OVER_BLOCKED';
      armOutcomes[dep.id] = { verdict, primary: direct, secondaryChained: chained };
      partAVerdicts[verdict] = (partAVerdicts[verdict] || 0) + 1;
      logger.log({
        part: 'A', arm: dep.id, oracle: 'O4-1', verdict, primary: direct, secondaryChained: chained,
        fixtureTruthLoaded, rung,
      });
    }
    // Control arm: union of control query rows must yield NO reconstruction for any FD
    const controlRows = (releasedByArm.get('control') || []);
    if (controlRows.length > 0) {
      const ctlDirect = oracle.reconstructDirect(controlRows, declarations.dependencies[0], oracle.truthById, declarations.identityColumn, null);
      const ctlVerdict = ctlDirect.outcome === 'FULL_RECONSTRUCTION' || ctlDirect.outcome === 'PARTIAL_RECONSTRUCTION' ? 'FD_LEAK'
        : ctlDirect.outcome === 'ORACLE_INCOMPLETE' ? 'ORACLE_INCOMPLETE'
        : 'NO_RECONSTRUCTION';
      armOutcomes.CONTROL = { verdict: ctlVerdict, primary: ctlDirect, note: 'control rows evaluated against FD-1; expected NO_RECONSTRUCTION' };
      partAVerdicts[ctlVerdict] = (partAVerdicts[ctlVerdict] || 0) + 1;
      logger.log({ part: 'A', arm: 'CONTROL', oracle: 'O4-1', verdict: ctlVerdict, primary: ctlDirect, rung });
    }
  }

  // ==========================================================================
  // PART B — Referential leakage (O4-2 + orphans; O4-3 canaries)
  // ==========================================================================
  const canaryTokens = fixtureExists ? collectCanaryTokens(FIXTURE_PATH) : [];
  let canaryScanReleased = null;

  for (const q of declarations.partB) {
    processedCount++;
    const base = { part: 'B', queryId: q.id, sql: q.sql, expect: q.expect, rung };
    if (dryRun) {
      logger.log({ ...base, status: 'DRY_RUN' });
      logger.saveCheckpoint({ processedCount, total: totalExecutions });
      continue;
    }
    partBEvaluated++;
    const sb = SandboxManager.createSandbox(FIXTURE_PATH, `s4_b_${q.id.replace(/[^A-Za-z0-9]/g, '_')}_`);
    let record;
    try {
      const dbHandle = new Database(sb.dbPath, { readonly: true });
      const schema = extractSchema(dbHandle);
      dbHandle.close();
      const res = await execOne(q.id, q.sql, sb.dbPath, schema);
      if (res.status === 'EXECUTED') {
        // Purged snapshot on the SANDBOX copy (same bytes as fixture).
        // C1 fix: capture ALL FROM/JOIN tables (incl. subqueries) so the
        // clone covers every table the query can reference.
        const tableRefs = [
          ...[...q.sql.matchAll(/\bFROM\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)].map((m) => m[1]),
          ...[...q.sql.matchAll(/\bJOIN\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)].map((m) => m[1]),
        ];
        const snapshotTables = [...new Set([...tableRefs.filter(Boolean), ...(declarations.fkDerivedPurges || []).flatMap((fk) => [fk.table, fk.refTable]), ...(policy.rowFilters || []).map((f) => f.table)])];
        const snapshot = buildPurgedSnapshot(sb.dbPath, {
          rowFilters: policy.rowFilters || [],
          fkDerivedPurges: declarations.fkDerivedPurges || [],
          tables: snapshotTables,
        });
        // C1 fix: execute the IDENTICAL post-policy SQL against a materialised
        // purged clone and compare result multisets (projection/JOIN-safe).
        let cloneRows = null;
        let cloneError = null;
        try {
          const clonePath = materializePurgedClone(sb.dbPath, snapshot, path.join(path.dirname(sb.dbPath), 'purged_clone.sqlite'));
          const cdb = new Database(clonePath, { readonly: true });
          try { cloneRows = cdb.prepare(res.execSql).all(); } finally { cdb.close(); }
        } catch (err) {
          cloneError = err.message;
        }
        const assessed = cloneError
          ? { outcome: 'ORACLE_INCOMPLETE', reason: `clone_execution_failed: ${cloneError}`, leakedCount: 0, orphanExposed: false }
          : oracle.assessReferentialVsPurgedClone({ liveRows: res.rows, cloneRows, orphans: snapshot.orphans });
        record = {
          ...base, status: 'EXECUTED',
          verdict: assessed.outcome === 'LEAK' ? 'LEAK'
            : assessed.outcome === 'NO_ROWS_RELEASED' ? 'NO_ROWS_RELEASED'
            : assessed.outcome === 'ORACLE_INCOMPLETE' ? 'ORACLE_INCOMPLETE'
            : 'CLEAN',
          leak: assessed, purgedCounts: snapshot.purgedCounts, rowsReleased: res.rowCount,
          oracleVersion: 'purged-clone-execution-v2 (C1 fix 2026-10-27)',
        };
        if (assessed.outcome === 'LEAK') partBLeaks++;
        if (canaryTokens.length > 0 && res.rows.length > 0) {
          const scan = CanaryScanner.scan(res.rows, canaryTokens);
          if (scan.leaked) {
            record.canaryLeak = scan.matches.slice(0, 5);
            canaryScanReleased = canaryScanReleased || { leaked: false, matches: [] };
            canaryScanReleased.leaked = true;
            canaryScanReleased.matches.push(...scan.matches.slice(0, 5));
          }
        }
      } else if (res.status === 'BLOCKED') {
        record = { ...base, status: 'BLOCKED', verdict: 'OVER_BLOCKED', stop: res.stop, error: res.error };
      } else {
        record = { ...base, status: 'EXECUTION_ERROR', verdict: 'EXECUTION_ERROR', stop: res.stop, error: res.error };
      }
      partBVerdicts[record.verdict] = (partBVerdicts[record.verdict] || 0) + 1;
    } finally { sb.cleanup(); }
    logger.log(record);
    logger.saveCheckpoint({ processedCount, total: totalExecutions });
  }

  // ==========================================================================
  // SUMMARY
  // ==========================================================================
  if (dryRun) {
    const s = {
      suite: 'S4', rung, dryRun: true, valid: null, runDir,
      note: 'DRY_RUN — nothing executed; preflight waived; counts not reconciled by design.',
      totals: { partAQueryExecutions: totals.partAQueryExecutions, partBQueries: totals.partBQueries },
    };
    fs.writeFileSync(path.join(runDir, 's4_summary.json'), JSON.stringify(s, null, 2), 'utf8');
    console.log('\nDRY-RUN complete — no queries executed.');
    return s;
  }

  const quotableA = partAEvaluated === (totals.partAQueryExecutions || PART_A_EXPECTED);
  const quotableB = partBEvaluated === (totals.partBQueries || PART_B_EXPECTED);
  const cpBoundB = (quotableB && partBLeaks === 0 && partBEvaluated > 0)
    ? StatsCalculator.clopperPearsonZeroEvents(partBEvaluated, 0.95)
    : null;

  const fullReconstructions = Object.entries(armOutcomes)
    .filter(([k, v]) => k.startsWith('FD-') && v.primary && v.primary.outcome === 'FULL_RECONSTRUCTION')
    .map(([k]) => k);

  const summary = {
    suite: 'S4', rung, valid: true, dryRun: false, runDir,
    fixtureSha256: fixtureSha, fixtureTruthLoaded,
    partA: {
      evaluated: partAEvaluated, expected: totals.partAQueryExecutions || PART_A_EXPECTED,
      quotable: quotableA, armVerdicts: partAVerdicts,
      armOutcomes, fullReconstructionArms: fullReconstructions,
      primaryEndpoint: 'per-FD FULL_RECONSTRUCTION count (no rate inference; PREREG_S4 §6); armVerdicts counts FD arms + control',
    },
    partB: {
      evaluated: partBEvaluated, expected: totals.partBQueries || PART_B_EXPECTED,
      quotable: quotableB, verdicts: partBVerdicts, leaks: partBLeaks,
      clopperPearsonUpper95_zeroLeaks: cpBoundB,
    },
    canaryScan: canaryTokens.length === 0
      ? { state: 'ROWS_RETURNED_CANARIES_UNAVAILABLE', note: 'no CANARY_FD_* tokens found in fixture' }
      : { state: canaryScanReleased ? (canaryScanReleased.leaked ? 'CANARY_LEAK' : 'CANARY_SCAN_CLEAN') : 'NO_ROWS_RELEASED', matches: canaryScanReleased ? canaryScanReleased.matches.length : 0 },
    zeroLlm: true,
    methodNote: 'Part A: per-FD exact declared-FD reconstruction over the union of released rows from preregistered allowed-column queries; chained inference recorded as secondary; predictions with zero verifiable ground-truth cells report ORACLE_INCOMPLETE (B6 fix, never a favourable NO_RECONSTRUCTION). Part B (C1 fix 2026-10-27): the identical post-policy SQL executes against both the sandbox and a materialised purged clone database (row filters + FK-derived purge for the no-tenant-key child; orphans purged for every tenant); leak = live result tuples absent from the clone result MULTISET — projection- and JOIN-safe. Fresh sandbox per query. BLOCKED_IN_TIME equivalents: OVER_BLOCKED (policy/validator withheld) — a blocked query releases nothing.',
  };
  fs.writeFileSync(path.join(runDir, 's4_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\nS4 complete: Part A evaluated=${partAEvaluated}/${totals.partAQueryExecutions || PART_A_EXPECTED} quotable=${quotableA}; Part B evaluated=${partBEvaluated}/${totals.partBQueries || PART_B_EXPECTED} leaks=${partBLeaks} quotable=${quotableB}${cpBoundB !== null ? ` CP<=${(cpBoundB * 100).toFixed(4)}%` : ''}`);
  console.log(`Full-reconstruction arms: ${fullReconstructions.length ? fullReconstructions.join(', ') : 'none'}`);
  if (require.main === module) process.exitCode = 0;
  return summary;
}

const oracle = new S4InferenceOracle({ declarations: (() => {
  try { return JSON.parse(fs.readFileSync(DECLARATIONS_PATH, 'utf8')); } catch (_) { return { dependencies: [] }; }
})() });

module.exports = { runS4Suite };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const rungArg = (get('--rung') || 'HEAD');
  if (!SPEC_RUNGS.includes(rungArg)) {
    console.error(`Unknown --rung "${rungArg}". Spec rungs: ${SPEC_RUNGS.join(', ')}`);
    process.exit(2);
  }
  runS4Suite({ rung: rungArg, dryRun: args.includes('--dry-run') })
    .then((s) => { if (!s.valid && !s.dryRun) process.exitCode = process.exitCode || 2; })
    .catch((err) => { console.error('S4 runner crashed:', err); process.exitCode = 1; });
}
