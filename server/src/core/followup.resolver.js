/**
 * FOLLOW-UP RESOLUTION + CONTEXT STATE (Features 6 & 7)
 * "How much?" / "Compare it with the second highest." / "Only Q4." become
 * standalone questions by combining the new message with remembered state:
 *   previous question, previous SQL, previous result preview, filters and
 *   time period. State is bounded and lives in the session record.
 * The rewrite is a *question* rewrite only - the resulting question still goes
 * through the full SQL generation, validation and execution pipeline.
 */
const FOLLOWUP_STARTERS = /^(and|also|but|so|then|now|only|just|what about|how about|why|how much|how many|compare|versus|vs|break (it|that|this) down|show (me )?(them|it|those|that)|same|filter|sort|limit|drill)/i;
const PRONOUNS = /\b(it|its|them|their|they|that|those|this|these|he|she|his|her|the same|previous|above|earlier|the (first|second|third|last|top|highest|lowest) (one|two|three)?)\b/i;

const FRESH_STARTER = /^(how many|what is|what are|show|list|give|which|who|count|total|average|find|get|display|is there|are there)\b/i;

function isFollowUp(question, state) {
  if (!state?.lastQuestion) return false;
  const q = String(question).trim();
  const words = q.split(/\s+/).length;
  if (FOLLOWUP_STARTERS.test(q)) return true;
  if (PRONOUNS.test(q) && words <= 18) return true;
  if (FRESH_STARTER.test(q)) return false;
  return words <= 4;
}

function summarizePreview(evidence) {
  if (!evidence || evidence.source_type !== 'database') return '';
  const rows = (evidence.sample_rows || []).slice(0, 3);
  return rows.map((r) => JSON.stringify(r)).join('; ').slice(0, 400);
}

function updateState(prev = {}, { question, standaloneQuestion, sql, evidence, answer }) {
  const filters = extractWhere(sql);
  const years = [...new Set(`${standaloneQuestion} ${sql || ''}`.match(/\b(19|20)\d{2}\b/g) || [])].slice(0, 4);
  return {
    ...prev,
    lastQuestion: question,
    lastStandalone: standaloneQuestion || question,
    lastSql: sql || prev.lastSql || null,
    lastColumns: evidence?.columns || prev.lastColumns || [],
    lastPreview: summarizePreview(evidence) || prev.lastPreview || '',
    lastAnswer: String(answer || '').slice(0, 400),
    filters: filters || prev.filters || null,
    timePeriod: years.length ? years : (prev.timePeriod || null),
    turns: Math.min((prev.turns || 0) + 1, 1000),
  };
}

function extractWhere(sql) {
  if (!sql) return null;
  const m = sql.match(/\bWHERE\b([\s\S]*?)(\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bLIMIT\b|$)/i);
  return m ? m[1].trim().slice(0, 300) : null;
}

function buildRewritePrompt(question, state) {
  return `Rewrite the user's follow-up message as ONE complete, standalone question that can be understood without the conversation. Keep every filter, time period and entity from the previous question that still applies. Do not answer it. Output only the rewritten question.

PREVIOUS QUESTION: ${state.lastStandalone || state.lastQuestion}
PREVIOUS ANSWER: ${state.lastAnswer || '(none)'}
PREVIOUS RESULT (first rows): ${state.lastPreview || '(none)'}
ACTIVE FILTERS: ${state.filters || '(none)'}
TIME PERIOD: ${(state.timePeriod || []).join(', ') || '(none)'}

FOLLOW-UP MESSAGE: ${question}

STANDALONE QUESTION:`;
}

async function resolveFollowUp({ question, state, llmProvider }) {
  if (!isFollowUp(question, state)) return { standaloneQuestion: question, wasFollowUp: false };
  let rewritten = '';
  try {
    rewritten = String(await llmProvider.complete(buildRewritePrompt(question, state), { temperature: 0, maxTokens: 120 })).trim();
  } catch (_) { /* fall back below */ }
  rewritten = rewritten.replace(/^["'`]+|["'`]+$/g, '').split('\n')[0].trim();
  const usable = rewritten.length >= 8 && rewritten.length <= 400 && !/^(sure|here|i |the user)/i.test(rewritten);
  const standaloneQuestion = usable ? rewritten : `${state.lastStandalone || state.lastQuestion} (follow-up: ${question})`;
  return { standaloneQuestion, wasFollowUp: true, viaLlm: usable };
}

module.exports = { isFollowUp, resolveFollowUp, updateState, buildRewritePrompt, extractWhere };
