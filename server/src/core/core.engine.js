const { routeQuery } = require('./query.router');
const { buildConversationContext } = require('./context.manager');
const { getOrCreateSession, setActiveDataset, recordTurn } = require('./session.manager');
const { composeAnswer } = require('../response/answer.composer');
const { getLLMProvider, getEmbeddingProvider } = require('../llm/model.manager');
const { DatasetRegistry } = require('../ingestion/dataset.registry');
const { AuthRegistry } = require('../security/auth.registry');
const { resolvePolicy } = require('../security/data.policy');
const { can } = require('../security/rbac');
const { screenQuestion } = require('../guardrails/input.guard');
const { redactEvidence } = require('../guardrails/pii');
const { checkNumericGrounding, detectContradiction, buildDeterministicAnswer } = require('../guardrails/answer.grounding');
const { OrgKnowledge } = require('../knowledge/org.knowledge');
const { resolveFollowUp, updateState } = require('./followup.resolver');
const { getState, saveState } = require('./session.state');
const { tryAgent, classifyIntent } = require('../agent/agent');
const { Preferences } = require('../memory/preferences.store');
const { Trace, TraceStore } = require('../observability/trace');
const { proposeFromChat } = require('../actions/chat.action');
const { buildManagementReport } = require('../report/report.builder');
const { generateInsights } = require('../analytics/insights');
const { selectChart } = require('../analytics/viz');
const { followUpSuggestions } = require('../analytics/exploration');
const logger = require('../config/logger');

const NO_INSIGHT_TOOLS = new Set(['explore', 'kpi', 'data_quality']);

/**
 * CORE ENGINE - single entry point.
 *   question -> input guardrails -> follow-up resolution -> intent/agent tools
 *   -> (else) router: structured | document | hybrid | analysis
 *   -> data policy (RBAC at the data layer) -> validated evidence
 *   -> explanation + grounding check -> PII masking -> insights / chart / suggestions
 *
 * `user` is the authenticated user object ({user_id, role, name, email}); `userId`
 * alone is still accepted (resolved to a user) for backward compatibility.
 */
async function handleUserQuery({ question, datasetId, datasetIds, sessionId, userId, user = null, analysisMode = false }) {
  if (!question || !question.trim()) throw new Error('question is required');

  const actor = user || (userId ? AuthRegistry.getUserById(userId) : null) || (userId ? { user_id: userId, role: 'analyst' } : { role: 'analyst' });
  const resolvedDatasetIds = Array.isArray(datasetIds) && datasetIds.length > 0 ? datasetIds : (datasetId ? [datasetId] : []);
  const session = getOrCreateSession(sessionId, actor.user_id || userId || null);
  const base = { sessionId: session.session_id };
  const trace = new Trace({ question, userId: actor.user_id || userId || null, sessionId: session.session_id });

  // 1. Input guardrails (plain code, before any model sees the text).
  const screen = screenQuestion(question);
  trace.add('input_guardrails', screen.blocked ? 'blocked' : (screen.flags.length ? 'warn' : 'ok'), screen.flags.join(', ') || 'no prompt-injection or abuse patterns found');
  if (screen.blocked) {
    TraceStore.save(trace.finish({ route: 'BLOCKED', status: 'blocked' }));
    recordTurn(session.session_id, 'user', question);
    recordTurn(session.session_id, 'assistant', screen.message);
    return { ...base, routeType: 'BLOCKED', answer: screen.message, evidence: null, lowConfidence: true, guardrail: { flags: screen.flags }, audit: { success: false, flags: screen.flags } };
  }

  const llmProvider = getLLMProvider('sql');           // SQL generation: fast model
  const reasoningProvider = getLLMProvider('reasoning'); // explanations: stronger model
  const rewriteProvider = getLLMProvider('rewrite');
  const embeddingProvider = getEmbeddingProvider();
  const datasets = resolvedDatasetIds.map((id) => DatasetRegistry.get(id)).filter(Boolean);
  const structured = datasets.filter((d) => !['pdf', 'docx', 'txt', 'pptx'].includes(d.type));
  const policyFor = (id) => resolvePolicy({ datasetId: id, user: actor });

  // 2. Follow-up resolution (Features 6/7).
  const prevState = getState(session.session_id);
  const fu = await resolveFollowUp({ question, state: prevState, llmProvider: rewriteProvider });
  const effectiveQuestion = fu.standaloneQuestion;
  trace.add('follow_up', fu.wasFollowUp ? 'ok' : 'skipped', fu.wasFollowUp ? `understood as: ${effectiveQuestion}` : 'standalone question');
  const conversationContext = buildConversationContext(session.session_id);
  recordTurn(session.session_id, 'user', question);

  const preferencesText = actor.user_id ? Preferences.toPromptText(actor.user_id) : null;
  const knowledgeText = structured[0] ? OrgKnowledge.renderForPrompt(structured[0].dataset_id, effectiveQuestion) : '';
  const finish = (final, extra = {}) => finalize({ final, extra, session, question, effectiveQuestion, fu, prevState, actor, structured, resolvedDatasetIds, trace });

  // 3. Intent: actions & reports are handled before the data path.
  const { intent } = classifyIntent(effectiveQuestion);
  trace.add('intent', 'ok', intent === 'query' ? 'data question (SQL / document / hybrid)' : `${intent} request`);
  if (intent === 'action') {
    const out = proposeFromChat({ question: effectiveQuestion, user: actor, datasetId: structured[0]?.dataset_id || null });
    return finish({ answer: out.answer, evidence: null, lowConfidence: !!out.denied }, { routeType: 'ACTION', action: out.action, audit: { success: !out.denied, action: out.action?.action_id } });
  }
  if (intent === 'report' && structured[0]) {
    if (!can(actor, 'report')) return finish({ answer: `Your role (${actor.role}) is not allowed to generate management reports.`, evidence: null, lowConfidence: true }, { routeType: 'REPORT', audit: { success: false } });
    try {
      const report = await buildManagementReport({ dataset: structured[0], policy: policyFor(structured[0].dataset_id) });
      return finish({ answer: `${report.executiveSummary}\n\nRecommendations:\n${report.recommendations.map((r) => `• ${r}`).join('\n')}\n\nThe full report (key metrics, trends, problems, category analysis, supporting data) can be downloaded as PDF, Word, Excel or CSV.`, evidence: null, lowConfidence: false },
        { routeType: 'REPORT', report: { datasetId: structured[0].dataset_id, title: report.title, formats: ['pdf', 'docx', 'xlsx', 'csv'] }, audit: { success: true } });
    } catch (err) {
      return finish({ answer: `I couldn't build the report: ${err.message}`, evidence: null, lowConfidence: true }, { routeType: 'REPORT', audit: { success: false, error: err.message } });
    }
  }

  // 4. Agent tools (trend / forecast / anomaly / correlation / comparison / quality / KPI / explore).
  if (structured.length === 1 && datasets.length === 1 && !analysisMode) {
    const agent = await tryAgent({ question: effectiveQuestion, dataset: structured[0], policy: policyFor(structured[0].dataset_id) });
    if (agent.handled) {
      trace.add('tool_selected', 'ok', `${agent.analytics?.tool || agent.intent} (deterministic tool, no SQL guesswork)`);
      if (agent.generatedSql) trace.add('query', 'ok', agent.generatedSql);
      if (agent.evidence) trace.add('executed', 'ok', `${agent.evidence.row_count} row(s) in read-only mode`);
      return finish({ answer: agent.answer, evidence: agent.evidence || null, lowConfidence: !!agent.lowConfidence },
        { routeType: 'AGENT', tool: agent.analytics?.tool || agent.intent, generatedSql: agent.generatedSql || undefined, analytics: slimAnalytics(agent.analytics), denied: agent.denied,
          audit: { success: !agent.denied, sql: agent.generatedSql, tool: agent.analytics?.tool || agent.intent, tables: agent.evidence?.tables_used, rows: agent.evidence?.row_count } });
    }
  }

  // 5. Standard pipeline.
  const routed = await routeQuery({
    question: effectiveQuestion, datasetIds: resolvedDatasetIds, session, llmProvider, embeddingProvider, conversationContext, analysisMode,
    policy: policyFor, knowledgeText,
    followUp: fu.wasFollowUp && prevState.lastSql ? { previousQuestion: prevState.lastStandalone || prevState.lastQuestion, previousSql: prevState.lastSql } : null,
  });

  trace.add('routing', 'ok', `${routed.routeType}${resolvedDatasetIds.length > 1 ? ` across ${resolvedDatasetIds.length} datasets` : ''}`);
  trace.addAll(routed.steps || []);
  if (resolvedDatasetIds.length > 0) setActiveDataset(session.session_id, resolvedDatasetIds[0]);

  let final;
  if (routed.routeType === 'ANALYSIS' && routed.answer !== undefined) {
    final = { answer: routed.answer, evidence: routed.evidence, lowConfidence: routed.lowConfidence ?? false };
  } else if (routed.answer !== undefined && !routed.evidence) {
    final = { answer: routed.answer, evidence: routed.evidence, lowConfidence: routed.lowConfidence ?? true };
  } else {
    final = await trace.time('synthesis', () => composeAnswer(reasoningProvider, { question: effectiveQuestion, evidence: routed.evidence, conversationContext, preferences: preferencesText }), () => `LLM (${reasoningProvider.name}) explained the validated evidence`);
    final = applyGrounding(final, effectiveQuestion);
    trace.add('grounding_check', final.guardrail ? 'warn' : 'ok', final.guardrail ? `answer replaced: ${final.guardrail.flags.join(', ')}` : 'every number in the answer traces back to the evidence');
  }

  return finish(final, {
    routeType: routed.routeType, generatedSql: routed.generatedSql, execResult: routed.execResult, partial: routed.partial,
    denied: routed.denied, repairs: routed.sqlRepaired, recoveryLog: routed.recoveryLog,
    audit: { success: !routed.denied && !!final.evidence, sql: routed.generatedSql, tables: collectTables(final.evidence), rows: final.evidence?.row_count, denied: !!routed.denied, repairs: routed.sqlRepaired?.length || 0 },
  });
}

/** Verifies the model's explanation against the evidence; falls back to a deterministic answer. */
function applyGrounding(final, question) {
  if (!final.evidence || !final.answer) return final;
  const contradiction = detectContradiction(final.answer, final.evidence);
  const grounding = checkNumericGrounding(final.answer, final.evidence, question);
  if (!contradiction && grounding.grounded) return final;
  const det = buildDeterministicAnswer(final.evidence);
  if (!det) return { ...final, guardrail: { flags: [contradiction ? 'contradiction' : 'ungrounded_numbers'], ungrounded: grounding.ungrounded }, lowConfidence: true };
  logger.warn('Answer failed grounding; using deterministic answer', { contradiction, ungrounded: grounding.ungrounded });
  return { ...final, answer: det, lowConfidence: final.lowConfidence, guardrail: { flags: [contradiction ? 'contradiction_replaced' : 'ungrounded_numbers_replaced'], ungrounded: grounding.ungrounded } };
}

function collectTables(ev) {
  if (!ev) return undefined;
  if (ev.source_type === 'hybrid') return [...new Set(ev.parts.flatMap((p) => p.tables_used || []))];
  if (ev.source_type === 'analysis') return [...new Set(ev.steps.flatMap((s) => s.evidence?.tables_used || []))];
  return ev.tables_used;
}

function slimAnalytics(a) {
  if (!a) return undefined;
  const { groups, quality, questions, ...rest } = a;
  return { ...rest, ...(groups ? { kpiGroups: groups } : {}), ...(quality ? { quality } : {}), ...(questions ? { questions } : {}) };
}

function finalize({ final, extra, session, question, effectiveQuestion, fu, prevState, actor, structured, resolvedDatasetIds, trace }) {
  const semantic = structured[0]?.profile?.semantic || null;
  let evidence = final.evidence;

  // PII masking for low-privilege roles (applies to what leaves the API, not what is stored).
  const red = redactEvidence(evidence, semantic, actor.role);
  evidence = red.evidence;
  const answer = red.redacted > 0 || ['viewer', 'employee'].includes(actor.role) ? require('../guardrails/pii').maskText(final.answer) : final.answer;

  const db = evidence && evidence.source_type === 'database' ? evidence : null;
  let insights = [], chart = null, suggestions = [];
  if (db && db.row_count > 0 && !NO_INSIGHT_TOOLS.has(extra.tool)) {
    try { insights = generateInsights(db); } catch (_) { /* optional */ }
    try { const c = selectChart({ question: effectiveQuestion, columns: db.columns, rows: db.sample_rows }); chart = c.type === 'none' || c.type === 'table' ? null : c; } catch (_) { /* optional */ }
    try { suggestions = followUpSuggestions({ question: effectiveQuestion, evidence: db, semantic }); } catch (_) { /* optional */ }
  } else if (extra.tool === 'explore') suggestions = (extra.analytics?.questions || []).slice(0, 4).map((q) => q.question);

  if (red.redacted) trace.add('pii_masking', 'ok', `${red.redacted} sensitive field(s) masked for role ${actor.role}`);
  if (insights.length || chart) trace.add('presentation', 'ok', `${insights.length} insight(s)${chart ? `, ${chart.type} chart` : ''}, ${suggestions.length} suggestion(s)`);
  const traceOut = trace.finish({ route: extra.routeType || 'STRUCTURED', tool: extra.tool || null, status: extra.denied ? 'blocked' : (extra.audit?.success === false ? 'error' : 'ok') });
  TraceStore.save(traceOut);
  recordTurn(session.session_id, 'assistant', answer, evidence);
  if (!extra.denied && final.evidence) {
    saveState(session.session_id, updateState(prevState, { question, standaloneQuestion: effectiveQuestion, sql: extra.generatedSql || evidence?.query, evidence: db, answer }));
  }

  return {
    sessionId: session.session_id,
    routeType: extra.routeType || 'STRUCTURED',
    answer,
    evidence,
    lowConfidence: final.lowConfidence,
    generatedSql: extra.generatedSql,
    execResult: extra.execResult,
    partial: extra.partial,
    insights, chart, suggestions,
    ...(extra.tool ? { tool: extra.tool } : {}),
    ...(extra.analytics ? { analytics: extra.analytics } : {}),
    ...(extra.report ? { report: extra.report } : {}),
    ...(extra.action ? { action: extra.action } : {}),
    ...(extra.repairs ? { repairs: extra.repairs } : {}),
    ...(extra.recoveryLog ? { recoveryAttempts: extra.recoveryLog.length } : {}),
    ...(final.guardrail ? { guardrail: final.guardrail } : {}),
    ...(red.redacted ? { redactedFields: red.redacted } : {}),
    ...(fu.wasFollowUp ? { followUp: { standaloneQuestion: effectiveQuestion } } : {}),
    ...(extra.denied ? { denied: true } : {}),
    trace: traceOut,
    ...(db?.confidence_detail ? { confidence: db.confidence_detail } : {}),
    ...(db?.provenance ? { provenance: db.provenance } : {}),
    ...(db?.quality_warnings ? { qualityWarnings: db.quality_warnings } : {}),
    audit: extra.audit || { success: true },
  };
}

module.exports = { handleUserQuery, applyGrounding };
