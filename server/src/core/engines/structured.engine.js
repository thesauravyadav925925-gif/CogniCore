const { createAdapter } = require('../../ingestion/adapters');
const { generateSql } = require('../../structured/sql.generator');
const { validateSql, SQLValidationError } = require('../../structured/sql.validator');
const { executeValidatedQuery } = require('../../structured/sql.executor');
const { validateResult } = require('../../structured/result.validator');
const { validateResultSemantics, diagnoseEmptyResult } = require('../../structured/result.checks');
const { buildStructuredEvidence } = require('../../evidence/evidence.manager');
const { analyzeSchema } = require('../../schema/schema.analyzer');
const { repairTableNames, ensureFromClause, fixIntegerDivision } = require('../../structured/sql.repair');
const { repairColumnNames, repairMissingGroupBy } = require('../../structured/sql.analyzer');
const { repairValueLiterals } = require('../../structured/sql.values.repair');
const { enforcePolicy, PolicyError } = require('../../security/data.policy');
const { tokenize } = require('../../structured/sql.analyzer');
const { buildProvenance, columnsUsed } = require('../../evidence/provenance');
const { explainConfidence } = require('../../evidence/confidence');
const { qualityWarningsFor } = require('../../quality/answer.warnings');
const { Meanings, applyMeanings } = require('../../semantic/meanings.store');
const logger = require('../../config/logger');

const MAX_RECOVERY_ATTEMPTS = 2;

/** Validation failures that are safety decisions - never "recovered" by asking the model again. */
const SECURITY_MESSAGE = /disallowed operation|Multiple statements|SQL comments|is not allowed\. Only SELECT/i;
/** Runtime/DB errors that a corrected query can plausibly fix. */
const RECOVERABLE_DB_ERROR = /no such (column|table)|syntax error|ambiguous|unrecognized token|does not exist|unknown column|misuse of|no such function|near "|incomplete input|column .* must appear|invalid/i;

/**
 * STRUCTURED ENGINE
 * Question -> schema/semantic retrieval -> SQL generation -> deterministic repairs ->
 * AST + safety validation -> data-policy enforcement -> read-only execution ->
 * (error recovery loop) -> empty-result diagnosis -> result validation -> evidence.
 *
 * The LLM only drafts SQL (and later explains results) - it never computes the answer.
 */
/** Public entry: runs the pipeline and attaches the step-by-step trace (blueprint #25). */
async function runStructuredQuery(opts) {
  const steps = [];
  const res = await runStructuredQueryInner({ ...opts, _steps: steps });
  return { ...res, steps };
}

async function runStructuredQueryInner({
  question, dataset, llmProvider, conversationContext,
  followUp = null, policy = null, knowledgeText = '', maxRecovery = MAX_RECOVERY_ATTEMPTS, _steps = [],
}) {
  const t0 = Date.now();
  const mark = (name, status, detail) => _steps.push({ name, status, detail: String(detail ?? '').slice(0, 300), ms: Date.now() - t0 });
  const schema = dataset.schema;
  const relationships = dataset.profile?.relationships || analyzeSchema(schema, dataset.profile).relationships;
  const semantic = applyMeanings(dataset.profile?.semantic || null, dataset.profile?.semantic ? Meanings.list(dataset.dataset_id) : []);
  const recoveryLog = [];

  const gen = (extra = {}) => generateSql(llmProvider, {
    question, schema, relationships, conversationContext, datasetType: dataset.type,
    semantic, knowledgeText, followUp, ...extra,
  });

  // 1. Generate candidate SQL (untrusted).
  mark('schema_context', 'ok', `${schema.tables.length} table(s)${semantic ? ', semantic model attached' : ''}${knowledgeText ? ', business definitions applied' : ''}${followUp ? ', previous query used as context' : ''}`);
  let { sql: rawSql, rawResponse } = await gen();
  mark('sql_generated', rawSql && !isGiveUp(rawSql) ? 'ok' : 'warn', rawSql);

  // 1a. One bounded retry when a small model gives up on an answerable question.
  if (isGiveUp(rawSql)) {
    const retry = await gen({ retryHint: true });
    rawSql = retry.sql;
    rawResponse = retry.rawResponse;
  }
  if (!rawSql || isGiveUp(rawSql)) {
    return {
      routeType: 'STRUCTURED',
      answer: "I don't have enough information in the connected dataset's schema to answer that question.",
      evidence: null, lowConfidence: true, generatedSql: rawSql,
    };
  }

  let attempt = 0;
  let prepared, execSql, execResult, lastFailure;

  // 2. Repair -> validate -> enforce policy -> execute, with bounded error recovery.
  for (;;) {
    prepared = prepareSql(rawSql, { schema, semantic });
    if (prepared.repairs.length) mark('auto_repair', 'ok', prepared.repairs.map((r) => r.type).join(', '));
    try {
      const validation = validateSql(prepared.sql, schema, dataset.type);
      mark('sql_validated', 'ok', `syntax, schema and safety passed; cost: ${validation.complexity?.level || 'low'}`);
      execSql = enforcePolicy({ sql: prepared.sql, schema, policy, datasetType: dataset.type });
      const adapter = createAdapter(dataset.type, { datasetId: dataset.dataset_id, location: dataset.location });
      if (execSql !== prepared.sql) mark('policy_enforced', 'ok', 'row-level restrictions applied to your role');
      execResult = await executeValidatedQuery(adapter, execSql);
      mark('executed', 'ok', `${execResult.rowCount} row(s) in read-only mode`);
      break;
    } catch (err) {
      if (err instanceof PolicyError) {
        mark('policy_enforced', 'blocked', err.message);
        return {
          routeType: 'STRUCTURED', answer: `Access denied: ${err.message}`, evidence: null,
          lowConfidence: true, generatedSql: prepared.sql, denied: true, deniedReason: err.message,
        };
      }
      const isValidation = err instanceof SQLValidationError;
      if (isValidation && SECURITY_MESSAGE.test(err.message)) {
        return validationFailure(prepared.sql, err);
      }
      const recoverable = isValidation || RECOVERABLE_DB_ERROR.test(err.message);
      lastFailure = err;
      mark(isValidation ? 'sql_validated' : 'executed', 'error', err.message);
      if (!recoverable || attempt >= maxRecovery) {
        if (isValidation) return validationFailure(prepared.sql, err);
        return {
          routeType: 'STRUCTURED',
          answer: `I wasn't able to run a working query for that question${recoveryLog.length ? ` after ${recoveryLog.length} automatic correction attempt${recoveryLog.length === 1 ? '' : 's'}` : ''} (${err.message}).`,
          evidence: null, lowConfidence: true, generatedSql: prepared.sql, recoveryLog,
        };
      }
      attempt++;
      const hints = (prepared.unresolvedColumns || []).flatMap((u) => [`"${u.name}" is not a column; valid columns include: ${u.suggestions.join(', ')}`]);
      recoveryLog.push({ attempt, failedSql: prepared.sql, error: err.message });
      mark('error_recovery', 'warn', `attempt ${attempt}: asking the model to fix the query`);
      logger.info('Structured query failed; attempting automatic recovery', { attempt, error: err.message });
      const regenerated = await gen({ recovery: { previousSql: prepared.sql, error: err.message, hints } });
      rawSql = regenerated.sql;
      if (!rawSql || isGiveUp(rawSql)) {
        return {
          routeType: 'STRUCTURED', answer: "I don't have enough information in the connected dataset's schema to answer that question.",
          evidence: null, lowConfidence: true, generatedSql: prepared.sql, recoveryLog,
        };
      }
    }
  }

  const candidateSql = prepared.sql;
  const repairs = [...prepared.repairs];

  // 3. Empty result: probe filters for case/whitespace mismatches and retry once, deterministically.
  let emptyDiagnosis = null;
  if (execResult.rowCount === 0) {
    const adapter = createAdapter(dataset.type, { datasetId: dataset.dataset_id, location: dataset.location });
    await adapter.connect();
    try {
      emptyDiagnosis = await diagnoseEmptyResult({ adapter, sql: candidateSql, schema, datasetType: dataset.type });
    } finally { await adapter.disconnect(); }
    if (emptyDiagnosis.repairedSql) {
      try {
        validateSql(emptyDiagnosis.repairedSql, schema, dataset.type);
        const retrySql = enforcePolicy({ sql: emptyDiagnosis.repairedSql, schema, policy, datasetType: dataset.type });
        const retryAdapter = createAdapter(dataset.type, { datasetId: dataset.dataset_id, location: dataset.location });
        const retryResult = await executeValidatedQuery(retryAdapter, retrySql);
        if (retryResult.rowCount > 0) {
          execResult = retryResult;
          repairs.push({ type: 'empty_result_case_fix', findings: emptyDiagnosis.findings });
          prepared.sql = emptyDiagnosis.repairedSql;
        }
      } catch (_) { /* keep original empty result */ }
    }
  }
  const finalSql = prepared.sql;
  if (emptyDiagnosis?.findings?.length) mark('empty_result_diagnosis', emptyDiagnosis.repairedSql ? 'ok' : 'warn', emptyDiagnosis.findings.map((f) => `${f.column}: ${f.type}`).join('; '));

  // 4. Result validation: structural + semantic.
  const resultValidation = validateResult(execResult);
  const rowCounts = Object.fromEntries(schema.tables.map((t) => [t.name.toLowerCase(), t.rowCount]));
  const semanticChecks = validateResultSemantics({ sql: finalSql, result: execResult, rowCounts });
  const issues = [...resultValidation.issues, ...semanticChecks.issues];
  if (execResult.rowCount === 0 && emptyDiagnosis?.findings?.length) {
    for (const f of emptyDiagnosis.findings) {
      if (f.type === 'value_not_found') issues.push(`No rows have ${f.column} = "${f.literal}". Existing values include: ${f.available.slice(0, 6).join(', ')}.`);
    }
  }
  const tablesUsed = [...new Set(tokenize(finalSql).filter((t) => t.t === 'word' || t.t === 'qid').map((t) => t.v.toLowerCase()))]
    .filter((n) => schema.tables.some((t) => t.name.toLowerCase() === n))
    .map((n) => schema.tables.find((t) => t.name.toLowerCase() === n).name);
  const colsUsed = columnsUsed(finalSql, schema);

  // Explained confidence (blueprint #15) + provenance (#14) + quality warnings (#16).
  const confidenceDetail = explainConfidence({
    kind: 'database', repairs, recoveryAttempts: recoveryLog.length, columns: colsUsed, semantic,
    rowCount: execResult.rowCount, truncated: execResult.truncated, resultIssues: issues, consistencyPenalty: semanticChecks.penalty,
  });
  const confidence = Math.min(confidenceDetail.score, resultValidation.confidence);
  const provenance = buildProvenance({ dataset, sql: finalSql, schema, tablesUsed, rowsReturned: execResult.rowCount });
  mark('result_validated', issues.length ? 'warn' : 'ok', issues.length ? issues.slice(0, 2).join(' ') : 'ranges, totals and structure look consistent');
  mark('confidence', confidenceDetail.level === 'High' ? 'ok' : 'warn', confidenceDetail.summary);
  const qualityWarnings = qualityWarningsFor({ quality: dataset.profile?.quality, columnRefs: colsUsed, tables: tablesUsed });

  const evidence = buildStructuredEvidence({
    datasetId: dataset.dataset_id, datasetName: dataset.name, sql: finalSql, result: execResult,
    resultValidation: { ...resultValidation, issues, confidence },
    extras: {
      tables_used: tablesUsed,
      columns_used: colsUsed,
      provenance,
      confidence_detail: confidenceDetail,
      quality_warnings: qualityWarnings.length ? qualityWarnings : undefined,
      repairs: repairs.length ? repairs : undefined,
      recovery_attempts: recoveryLog.length || undefined,
      policy_applied: execSql !== prepared.sql && !!policy && (policy.rowFilters?.length > 0) ? true : undefined,
    },
  });

  return {
    routeType: 'STRUCTURED',
    evidence,
    generatedSql: finalSql,
    execResult,
    sqlRepaired: repairs.length ? repairs : undefined,
    recoveryLog: recoveryLog.length ? recoveryLog : undefined,
  };
}

/** Applies every deterministic repair, in a fixed order, and reports what changed. */
function prepareSql(rawSql, { schema, semantic }) {
  const repairs = [];
  let sql = rawSql;

  const t = repairTableNames(sql, schema);
  if (t.repaired) repairs.push({ type: 'table_name', corrections: t.corrections });
  sql = t.sql;

  const c = repairColumnNames(sql, schema);
  if (c.repaired) repairs.push({ type: 'column_name', corrections: c.corrections });
  sql = c.sql;

  const f = ensureFromClause(sql, schema);
  if (f.repaired) repairs.push({ type: 'missing_from' });
  sql = f.sql;

  const g = repairMissingGroupBy(sql);
  if (g.repaired) repairs.push({ type: 'missing_group_by', groupBy: g.groupBy });
  sql = g.sql;

  const d = fixIntegerDivision(sql);
  if (d.repaired) repairs.push({ type: 'integer_division' });
  sql = d.sql;

  const v = repairValueLiterals(sql, semantic);
  if (v.repaired) repairs.push({ type: 'value_literal', corrections: v.corrections });
  sql = v.sql;

  return { sql, repairs, unresolvedColumns: c.unresolved };
}

function isGiveUp(sql) {
  return !!sql && sql.trim().toUpperCase() === 'NO_QUERY_POSSIBLE';
}

function validationFailure(sql, err) {
  return {
    routeType: 'STRUCTURED',
    answer: `I generated a query but it failed safety validation (${err.message}). I won't run unsafe or unrecognized queries.`,
    evidence: null, lowConfidence: true, generatedSql: sql, validationError: err.message,
  };
}

module.exports = { runStructuredQuery, prepareSql, MAX_RECOVERY_ATTEMPTS };
