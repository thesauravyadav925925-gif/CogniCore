'use strict';
/**
 * s3_runner.js — Suite S3: Inference and cumulative disclosure (deterministic
 * variant, PREREG_S3). No LLM anywhere in this runner.
 *
 * Replays each SecureSQL sample's `queries` in order through the production
 * chain (prepareSql -> validateSql -> enforcePolicy -> executeValidatedQuery)
 * on a fresh sandbox copy of the sample's Spider/BIRD database, then applies
 * the exact per-sample oracles (O3-1..O3-5) to the union of released results.
 *
 * Hard rules enforced here:
 *  - Benchmark SHA-256 must match the preregistered value (mismatch aborts,
 *    exit 3; amendment required per PREREG_S3 §8).
 *  - Policies come ONLY from data/s3/policy_translations.json (hand-authored,
 *    committed). No mapping / unexpressible condition => POLICY_UNEXPRESSIBLE
 *    (a counted result, not an error); recall claims are unquotable at zero
 *    coverage.
 *  - Missing databases abort in preflight (exit 2) unless --dry-run.
 *  - Every sample is logged with per-query step status and full verdict
 *    accounting; summary reconciles and sets valid:false otherwise.
 *
 * Usage:
 *   export NODE_PATH=$PWD/server/node_modules
 *   node security-eval/harness/runners/s3_runner.js --rung 9cde26c [--dry-run] [--limit N]
 *   [--databases-root <dir>] [--mapping <path>] [--benchmark <path>]
 * Ladder rungs per PREREG_S3 §3: 6f2dd4c, 8205910, HEAD.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const JsonlLogger = require('../oracles/jsonl_logger');
const ManifestWriter = require('../oracles/manifest_writer');
const SandboxManager = require('../oracles/sandbox_manager');
const S3InferenceOracle = require('../oracles/s3_inference_oracle');
const StatsCalculator = require('../oracles/stats');

const BENCHMARK_SHA256 = 'c0bf5fbc8d78577b30c56adfc4d4429ec490fa736e9f8f7ef46ba3ffeef6c6a4';
const REQUIRED_KEYS = ['id', 'db_id', 'security_condition', 'questions', 'queries', 'label'];
const VIOLATING_LABELS = new Set(['DI', 'PR', 'RE']);
const SPEC_RUNGS = ['6f2dd4c', '8205910', 'HEAD'];

function parseArgs() {
  const args = process.argv.slice(2);
  const o = { rung: 'HEAD', limit: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rung' && args[i + 1]) o.rung = args[++i];
    else if (args[i] === '--limit' && args[i + 1]) o.limit = parseInt(args[++i], 10);
    else if (args[i] === '--dry-run') o.dryRun = true;
    else if (args[i] === '--databases-root' && args[i + 1]) o.databasesRoot = path.resolve(args[++i]);
    else if (args[i] === '--mapping' && args[i + 1]) o.mappingPath = path.resolve(args[++i]);
    else if (args[i] === '--benchmark' && args[i + 1]) o.benchmarkPath = path.resolve(args[++i]);
  }
  return o;
}

function sha256Buf(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function quoteIdent(name) { return `"${String(name).replace(/"/g, '""')}"`; }
// Mirrors data.policy.js sqlStr quoting semantics for literal values.
function quoteSqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

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

function loadBenchmark(benchmarkPath) {
  const raw = fs.readFileSync(benchmarkPath);
  const digest = sha256Buf(raw);
  let samples;
  try { samples = JSON.parse(raw.toString('utf8')); } catch (e) {
    throw new Error(`Benchmark is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(samples)) throw new Error('Benchmark root is not an array');
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    for (const k of REQUIRED_KEYS) {
      if (!(k in s)) throw new Error(`Benchmark sample[${i}] missing key ${k}`);
    }
    if (!Array.isArray(s.queries) || s.queries.length === 0) {
      throw new Error(`Benchmark sample ${s.id} has empty/invalid queries`);
    }
  }
  return { samples, digest };
}

function loadMapping(mappingPath) {
  if (!fs.existsSync(mappingPath)) return { loaded: false, map: new Map(), counts: { mapped: 0, declaredUnexpressible: 0 } };
  const raw = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  if (!raw || !Array.isArray(raw.translations)) {
    throw new Error(`Mapping file ${mappingPath} must contain a top-level "translations" array`);
  }
  const map = new Map();
  let declaredUnexpressible = 0;
  for (const t of raw.translations) {
    if (!t || typeof t.condition !== 'string') throw new Error('Mapping entry missing "condition" string');
    if (map.has(t.condition)) throw new Error(`Mapping has duplicate condition: "${t.condition.slice(0, 60)}"`);
    if (t.expressible === false) { declaredUnexpressible++; map.set(t.condition, { expressible: false }); continue; }
    const pol = t.policy || {};
    for (const rf of pol.rowFilters || []) {
      if (!rf.table || !rf.column || !rf.op) {
        throw new Error(`Mapping rowFilter for "${t.condition.slice(0, 40)}" needs table, column, op`);
      }
    }
    for (const dc of pol.deniedColumns || []) {
      if (!dc.table || !dc.column) {
        throw new Error(`Mapping deniedColumn for "${t.condition.slice(0, 40)}" needs table, column`);
      }
    }
    map.set(t.condition, { expressible: true, policy: pol, protected: t.protected || null, provenance: t.provenance || null });
  }
  return { loaded: true, map, counts: { mapped: map.size - declaredUnexpressible, declaredUnexpressible } };
}

function resolveDbPath(databasesRoot, dbId) {
  return path.resolve(databasesRoot, String(dbId), `${String(dbId)}.sqlite`);
}

function buildPurgedClone(sourceDbPath, policy, tmpDir) {
  const purgedDbPath = path.join(tmpDir, 'purged.sqlite');
  fs.copyFileSync(sourceDbPath, purgedDbPath);
  const db = new Database(purgedDbPath);
  try {
    for (const rf of (policy.rowFilters || [])) {
      const expr = `${quoteIdent(rf.column)} ${rf.op} ${quoteSqlStr(rf.value)}`;
      db.exec(`DELETE FROM ${quoteIdent(rf.table)} WHERE NOT (${expr});`);
    }
  } finally { db.close(); }
  return purgedDbPath;
}

function seedCanaries(dbPath, protectedInfo, sampleId) {
  const cells = (protectedInfo && protectedInfo.canaryCells) || [];
  const tokens = [];
  if (cells.length === 0 || !protectedInfo || !protectedInfo.rowPredicate || !protectedInfo.table) return tokens;
  const db = new Database(dbPath);
  try {
    cells.forEach((cell, i) => {
      const token = cell.value !== undefined && cell.value !== null
        ? String(cell.value) : `CANARY_S3_${sampleId}_${i}`;
      db.exec(`UPDATE ${quoteIdent(protectedInfo.table)} SET ${quoteIdent(cell.column)} = ${quoteSqlStr(token)} WHERE ${protectedInfo.rowPredicate};`);
      tokens.push({ token, table: protectedInfo.table, column: cell.column });
    });
  } finally { db.close(); }
  return tokens;
}

function computeProtectedInfo(dbPath, protectedInfo) {
  if (!protectedInfo || !protectedInfo.table || !protectedInfo.rowPredicate) {
    return { available: false, reason: 'no protected table/predicate in mapping' };
  }
  const cols = (protectedInfo.columns || []);
  if (cols.length === 0) return { available: false, reason: 'no protected columns in mapping' };
  const db = new Database(dbPath, { readonly: true });
  try {
    const sel = cols.map((c) => quoteIdent(c)).join(', ');
    const rows = db.prepare(`SELECT ${sel} FROM ${quoteIdent(protectedInfo.table)} WHERE ${protectedInfo.rowPredicate};`).all();
    if (rows.length !== 1) {
      return { available: false, reason: `rowPredicate matched ${rows.length} rows (need exactly 1)` };
    }
    const row = rows[0];
    const identity = {};
    for (const c of cols) identity[c] = row[c];
    const firstVal = row[cols[0]];
    return {
      available: true,
      identity,
      value: typeof firstVal === 'number' ? firstVal : null,
      table: protectedInfo.table,
    };
  } finally { db.close(); }
}

function computeComplementProbe(dbPath, protectedInfo) {
  if (!protectedInfo || !protectedInfo.table || !protectedInfo.rowPredicate) {
    return { complementCount: null, complementAggregate: null };
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const cnt = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(protectedInfo.table)} WHERE NOT (${protectedInfo.rowPredicate});`).get();
    const probe = { complementCount: cnt ? cnt.n : null, complementAggregate: null };
    if (probe.complementCount === 1 && (protectedInfo.columns || []).length > 0) {
      const r = db.prepare(`SELECT ${quoteIdent(protectedInfo.columns[0])} AS v FROM ${quoteIdent(protectedInfo.table)} WHERE NOT (${protectedInfo.rowPredicate}) LIMIT 1;`).get();
      probe.complementAggregate = r && typeof r.v === 'number' ? r.v : null;
    }
    return probe;
  } finally { db.close(); }
}

function runQueryOnPurged(purgedDbPath, sql) {
  const db = new Database(purgedDbPath, { readonly: true });
  try {
    const stmt = db.prepare(sql);
    const columns = stmt.columns().map((c) => c.name);
    return { sql, columns, rows: stmt.raw().all() };
  } finally { db.close(); }
}

async function runS3Suite(opts = {}) {
  const rung = opts.rung || 'HEAD';
  const worktreeDir = rung === 'HEAD' || rung === '9cde26c'
    ? path.resolve(__dirname, '../../../')
    : path.resolve(__dirname, `../../../../cognicore-ladder/${rung}`);
  const dryRun = Boolean(opts.dryRun);
  const itemLimit = opts.limit ? parseInt(opts.limit, 10) : null;

  const repoRoot = path.resolve(__dirname, '../../../');
  const benchmarkPath = opts.benchmarkPath
    || path.resolve(repoRoot, 'security-eval/data/downloads/secureSQL/repo/data.json');
  const mappingPath = opts.mappingPath
    || path.resolve(repoRoot, 'security-eval/data/s3/policy_translations.json');
  const databasesRoot = opts.databasesRoot
    || path.resolve(repoRoot, 'security-eval/data/downloads/secureSQL/databases');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.resolve(__dirname, `../../runs/${timestamp}_s3_${rung}`);
  const logger = new JsonlLogger(runDir, 's3_results.jsonl');
  const failSummary = (error, code) => {
    const s = { suite: 'S3', rung, valid: false, error, runDir };
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 's3_summary.json'), JSON.stringify(s, null, 2), 'utf8');
    if (require.main === module) process.exitCode = code;
    return s;
  };

  console.log(`=== S3 (Inference & Cumulative Disclosure, deterministic) — rung ${rung} ===`);
  console.log(`Worktree: ${worktreeDir}\nBenchmark: ${benchmarkPath}\nMapping: ${mappingPath}\nDatabases: ${databasesRoot}`);

  // Dynamically load worktree modules (same production chain as S1-A/S2-B).
  const { validateSql } = require(path.resolve(worktreeDir, 'server/src/structured/sql.validator.js'));
  const { executeValidatedQuery } = require(path.resolve(worktreeDir, 'server/src/structured/sql.executor.js'));
  const { enforcePolicy, PolicyError } = require(path.resolve(worktreeDir, 'server/src/security/data.policy.js'));
  const { repairTableNames, ensureFromClause, fixIntegerDivision } = require(path.resolve(worktreeDir, 'server/src/structured/sql.repair.js'));

  // --- Benchmark (strict; SHA-256 pinned by prereg) ------------------------
  if (!fs.existsSync(benchmarkPath)) {
    return failSummary(`Benchmark missing at ${benchmarkPath} — run harness/tools/s3_inspect_benchmark.js after acquiring it`, 2);
  }
  const { samples, digest } = loadBenchmark(benchmarkPath);
  if (digest !== BENCHMARK_SHA256) {
    return failSummary(`Benchmark SHA-256 ${digest} != preregistered ${BENCHMARK_SHA256}. File a dated amendment (PREREG_S3 §8) before running.`, 3);
  }

  // --- Mapping (coverage is a result) --------------------------------------
  const mapping = loadMapping(mappingPath);
  console.log(`Mapping loaded: ${mapping.loaded} — mapped expressible: ${mapping.counts.mapped}, declared unexpressible: ${mapping.counts.declaredUnexpressible}`);
  if (!mapping.loaded) {
    console.log('WARNING: no policy mapping — every sample will be POLICY_UNEXPRESSIBLE; recall/specificity unquotable.');
  }

  // --- Database preflight ---------------------------------------------------
  const distinctDbIds = [...new Set(samples.map((s) => s.db_id))];
  const missingDbs = distinctDbIds
    .map((id) => ({ id, p: resolveDbPath(databasesRoot, id) }))
    .filter((x) => !fs.existsSync(x.p));
  if (missingDbs.length > 0 && !dryRun) {
    return failSummary(`Preflight: ${missingDbs.length}/${distinctDbIds.length} databases missing under ${databasesRoot} (first 5: ${missingDbs.slice(0, 5).map((m) => m.id).join(', ')}). Place Spider+BIRD folders per SecureSQL README.`, 2);
  }
  if (missingDbs.length > 0) {
    console.log(`DRY-RUN: ${missingDbs.length}/${distinctDbIds.length} databases missing (preflight waived).`);
  }

  fs.mkdirSync(runDir, { recursive: true });
  ManifestWriter.writeManifest(runDir, {
    suite: 'S3', rung, worktree: worktreeDir, dryRun, partialRun: Boolean(itemLimit),
    benchmarkPath, benchmarkSha256: digest, mappingPath, mappingLoaded: mapping.loaded,
    databasesRoot, specRungs: SPEC_RUNGS,
  }, [benchmarkPath, ...(mapping.loaded ? [mappingPath] : [])]);

  const evaluatedItems = itemLimit ? samples.slice(0, itemLimit) : samples;

  function prepareSql(rawSql, schema) {
    let sql = rawSql;
    try { const t = repairTableNames(sql, schema, 'sqlite'); if (t && t.sql) sql = t.sql; } catch (_) {}
    try { const f = ensureFromClause(sql, schema); if (f && f.sql) sql = f.sql; } catch (_) {}
    try { const d = fixIntegerDivision(sql); if (d && d.sql) sql = d.sql; } catch (_) {}
    return { sql };
  }

  const verdictCounts = {};
  const perLabelVerdicts = {};
  const coverageCounts = { mappedExpressible: 0, declaredUnexpressible: 0, unmapped: 0 };
  const firstStopCounts = {};
  let harnessErrors = 0;
  let evaluatedCount = 0;
  let processedCount = 0;

  for (const s of evaluatedItems) {
    processedCount++;
    const sampleId = `s3_${s.id}`;
    const base = { sampleId, benchmarkId: s.id, label: s.label, dbId: s.db_id, queryCount: s.queries.length };
    const entry = mapping.map.get(s.security_condition);

    if (!entry || entry.expressible === false) {
      coverageCounts[entry ? 'declaredUnexpressible' : 'unmapped']++;
      logger.log({ ...base, verdict: 'POLICY_UNEXPRESSIBLE', reason: entry ? 'declared_unexpressible' : 'condition_unmapped' });
      verdictCounts.POLICY_UNEXPRESSIBLE = (verdictCounts.POLICY_UNEXPRESSIBLE || 0) + 1;
      (perLabelVerdicts[s.label] = perLabelVerdicts[s.label] || {}); 
      logger.saveCheckpoint({ processedCount, total: evaluatedItems.length });
      continue;
    }
    coverageCounts.mappedExpressible++;

    if (dryRun) {
      logger.log({ ...base, status: 'DRY_RUN' });
      logger.saveCheckpoint({ processedCount, total: evaluatedItems.length });
      continue;
    }

    const dbPath = resolveDbPath(databasesRoot, s.db_id);
    if (!fs.existsSync(dbPath)) {
      logger.log({ ...base, verdict: 'SKIPPED_MISSING_DB', dbPath });
      verdictCounts.SKIPPED_MISSING_DB = (verdictCounts.SKIPPED_MISSING_DB || 0) + 1;
      continue;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `s3_${s.id}_`));
    let record;
    try {
      const sb = SandboxManager.createSandbox(dbPath, `s3_${s.id}_`);
      const purgedDbPath = buildPurgedClone(dbPath, entry.policy, tmpDir);
      try {
        const dbHandle = new Database(sb.dbPath, { readonly: true });
        const schema = extractSchema(dbHandle);
        dbHandle.close();
        const canaries = seedCanaries(sb.dbPath, entry.protected, s.id);
        const protectedInfo = computeProtectedInfo(sb.dbPath, entry.protected);
        const complementProbe = computeComplementProbe(sb.dbPath, entry.protected);
        const purgedResults = [];
        for (const q of s.queries) {
          try { purgedResults.push(runQueryOnPurged(purgedDbPath, q)); } catch (_) { /* purged failure => O3-1 comparison unavailable for that query */ }
        }

        const releasedResults = [];
        const steps = [];
        let firstStop = null;
        let executorError = null;
        for (let qi = 0; qi < s.queries.length; qi++) {
          const prep = prepareSql(s.queries[qi], schema);
          let execSql;
          try {
            validateSql(prep.sql, schema, 'sqlite');
            execSql = enforcePolicy({ sql: prep.sql, schema, policy: entry.policy, datasetType: 'sqlite' });
          } catch (err) {
            const stop = err instanceof PolicyError || (err && err.name === 'PolicyError') ? 'POLICY_BLOCKED' : 'PARSER_OR_VALIDATOR_BLOCKED';
            steps.push({ qi, stop });
            if (!firstStop) firstStop = stop;
            break;
          }
          try {
            const adapter = { location: sb.dbPath, datasetType: 'sqlite', db: true };
            const res = await executeValidatedQuery(adapter, execSql, { maxRows: 1000, timeoutMs: 15000 });
            releasedResults.push({ sql: execSql, columns: res.columns, rows: res.rows, rowCount: res.rowCount });
            steps.push({ qi, stop: 'EXECUTED' });
          } catch (err) {
            executorError = err.message;
            const stop = /Query execution timed out/i.test(err.message) ? 'TIMEOUT_ABORTED' : 'EXECUTOR_ERROR';
            steps.push({ qi, stop });
            if (!firstStop) firstStop = stop;
            break;
          }
        }

        const blockedAny = steps.some((st) => st.stop !== 'EXECUTED');
        let verdict;
        let oracle = null;
        if (VIOLATING_LABELS.has(s.label)) {
          oracle = S3InferenceOracle.triageViolating({
            label: s.label, releasedResults, canaries, purgedResults,
            protectedInfo: protectedInfo.available
              ? { value: protectedInfo.value, identity: protectedInfo.identity } : null,
            complementProbe,
            deniedColumns: entry.policy.deniedColumns || [],
          });
          if (oracle.verdict === 'LEAK') verdict = 'LEAK';
          else if (executorError) verdict = 'EXECUTION_ERROR';
          else if (oracle.verdict === 'ORACLE_INCOMPLETE') verdict = 'ORACLE_INCOMPLETE';
          else if (blockedAny) verdict = 'BLOCKED_IN_TIME';
          else verdict = 'ATTACK_INEFFECTIVE';
        } else { // SA / SU
          if (executorError) verdict = 'EXECUTION_ERROR';
          else if (blockedAny) verdict = 'OVER_BLOCKED';
          else verdict = 'ANSWERED';
        }
        if (!firstStop) firstStop = blockedAny ? firstStop : (releasedResults.length ? 'EXECUTED_ALL' : 'NO_QUERY_RUN');
        firstStopCounts[firstStop] = (firstStopCounts[firstStop] || 0) + 1;

        record = {
          ...base, verdict, firstStop, steps,
          releasedCount: releasedResults.length,
          blockedCount: steps.filter((st) => st.stop !== 'EXECUTED').length,
          canariesSeeded: canaries.length,
          protectedInfoAvailable: protectedInfo.available,
          oracleEvidence: oracle ? (oracle.evidence || []).slice(0, 10) : [],
          oracleIncompleteReasons: oracle ? (oracle.incompleteReasons || []) : [],
          executorError,
        };
      } finally {
        try { fs.rmSync(sb.dbPath, { force: true }); } catch (_) {}
        try { fs.rmSync(path.dirname(sb.dbPath), { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(purgedDbPath, { force: true }); } catch (_) {}
      }
    } catch (err) {
      harnessErrors++;
      record = { ...base, verdict: 'HARNESS_ERROR', error: err.message };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    logger.log(record);
    verdictCounts[record.verdict] = (verdictCounts[record.verdict] || 0) + 1;
    const lv = perLabelVerdicts[s.label] = perLabelVerdicts[s.label] || {};
    lv[record.verdict] = (lv[record.verdict] || 0) + 1;
    evaluatedCount++;
    if (processedCount % 25 === 0) {
      console.log(`Progress: ${processedCount}/${evaluatedItems.length} (verdicts: ${JSON.stringify(verdictCounts)})`);
    }
    logger.saveCheckpoint({ processedCount, total: evaluatedItems.length, verdictCounts });
  }

  // --- Summary (explicit denominators; PREREG_S3 §6) ------------------------
  const violating = { total: 0, LEAK: 0, BLOCKED_IN_TIME: 0, ATTACK_INEFFECTIVE: 0, ORACLE_INCOMPLETE: 0, EXECUTION_ERROR: 0 };
  const nonViolating = { total: 0, ANSWERED: 0, OVER_BLOCKED: 0, EXECUTION_ERROR: 0 };
  for (const [label, vc] of Object.entries(perLabelVerdicts)) {
    const bucket = VIOLATING_LABELS.has(label) ? violating : nonViolating;
    for (const [v, n] of Object.entries(vc)) {
      bucket.total += n;
      if (v in bucket) bucket[v] += n;
    }
  }
  const pos = violating.total - violating.EXECUTION_ERROR;
  const neg = nonViolating.total - nonViolating.EXECUTION_ERROR;
  const summary = {
    suite: 'S3', rung, runDir, benchmarkSha256: digest,
    benchmarkSha256MatchesPrereg: digest === BENCHMARK_SHA256,
    mappingLoaded: mapping.loaded, partialRun: Boolean(itemLimit), dryRun,
    policyCoverage: {
      distinctConditionsInBenchmark: new Set(samples.map((s) => s.security_condition)).size,
      ...coverageCounts,
      coverageRate: evaluatedItems.length
        ? coverageCounts.mappedExpressible / evaluatedItems.length : 0,
    },
    evaluatedCount: evaluatedCount + (verdictCounts.POLICY_UNEXPRESSIBLE || 0) + (verdictCounts.SKIPPED_MISSING_DB || 0),
    samplesWithPolicy: evaluatedCount,
    verdictCounts,
    perLabelVerdicts,
    violatingClass: {
      ...violating,
      denominators: { positivesWithPolicy: pos },
      leakRate: pos ? violating.LEAK / pos : null,
      leakRateCpUpperIfZero: pos && violating.LEAK === 0 ? StatsCalculator.clopperPearsonZeroEvents(pos) : null,
      blockedRate: pos ? violating.BLOCKED_IN_TIME / pos : null,
      attackIneffectiveRate: pos ? violating.ATTACK_INEFFECTIVE / pos : null,
      oracleIncompleteRate: pos ? violating.ORACLE_INCOMPLETE / pos : null,
    },
    nonViolatingClass: {
      ...nonViolating,
      denominators: { negativesWithPolicy: neg },
      answeredRate: neg ? nonViolating.ANSWERED / neg : null,
      overBlockedRate: neg ? nonViolating.OVER_BLOCKED / neg : null,
      overBlockedRateCpLowerNote: 'report raw rate; CP zero-event bound applies only to leak-type zero events',
    },
    firstStopCounts,
    harnessErrors,
    valid: harnessErrors === 0
      && (evaluatedCount + (verdictCounts.POLICY_UNEXPRESSIBLE || 0) + (verdictCounts.SKIPPED_MISSING_DB || 0) === evaluatedItems.length),
    quotable: harnessErrors === 0 && !itemLimit && !dryRun && mapping.loaded && mapping.counts.mapped > 0,
    methodNote: 'Per sample: fresh sandbox copy, canaries seeded at protected cells (when mapping provides them), queries replayed in order through prepareSql -> validateSql -> enforcePolicy -> executeValidatedQuery; O3-1..O3-5 exact oracles over the union of released results vs purged ground truth. BLOCKED_IN_TIME counts a violating sample whose chain withheld part of the history with no leak in the released subset (prereg §5 definition; blockedCount decomposition is per-record). ATTACK_INEFFECTIVE = zero blocks and no measured leak. Recall claims require policyCoverage > 0; quotable=false otherwise.',
  };
  const summaryPath = path.join(runDir, 's3_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`=== S3 completed. Summary: ${summaryPath} ===`);
  console.log(JSON.stringify({ verdictCounts, valid: summary.valid, quotable: summary.quotable }, null, 2));
  return summary;
}

if (require.main === module) {
  runS3Suite(parseArgs())
    .then((s) => { if (s && s.valid === false && process.exitCode === undefined) process.exitCode = 1; })
    .catch((err) => { console.error('Fatal in S3 suite:', err); process.exit(1); });
}

module.exports = { runS3Suite };
