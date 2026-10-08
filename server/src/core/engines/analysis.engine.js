const { runStructuredQuery } = require('./structured.engine');
const { buildStructuredEvidence } = require('../../evidence/evidence.manager');

const MAX_SUB_QUESTIONS = 6;

/**
 * ANALYSIS ENGINE (multi-step)
 * ------------------------------------------------------------------
 * For open-ended business-analysis questions ("give me a management
 * summary", "identify operational problems", "compare X and Y and
 * explain the difference") that cannot be answered by a single SQL
 * query, this engine:
 *
 *   1. PLAN  - ask the LLM to break the question into several specific,
 *              independently-answerable sub-questions.
 *   2. EXECUTE - run EACH sub-question through the exact same, already
 *              fully-validated structured.engine.js pipeline used
 *              everywhere else in the app. No new SQL-safety surface is
 *              introduced by this file - every sub-query still goes
 *              through generateSql -> repairTableNames/ensureFromClause
 *              -> validateSql -> executeValidatedQuery, unchanged.
 *   3. SYNTHESIZE - ask the LLM to write a final answer using ONLY the
 *              evidence gathered in step 2 (never inventing numbers).
 *
 * This keeps the project's core discipline intact even for a much more
 * capable-feeling mode: the LLM decides WHAT to ask and explains results
 * in prose, but every number that appears anywhere came from a real,
 * validated, executed query - never from the LLM's own arithmetic.
 * ------------------------------------------------------------------
 */
async function runAnalysisQuery({ question, dataset, llmProvider, conversationContext, policy = null, knowledgeText = '' }) {
  const schema = dataset.schema;

  // --- Step 1: PLAN ---
  const planPrompt = buildPlanPrompt({ question, schema });
  const planRaw = await llmProvider.complete(planPrompt, { temperature: 0.2, maxTokens: 500 });
  const subQuestions = parsePlan(planRaw).slice(0, MAX_SUB_QUESTIONS);

  if (subQuestions.length === 0) {
    return {
      routeType: 'ANALYSIS',
      answer: "I couldn't break this question down into specific, answerable steps against the connected dataset's schema.",
      evidence: null,
      lowConfidence: true,
    };
  }

  // --- Step 2: EXECUTE each sub-question through the existing, proven pipeline ---
  const steps = [];
  for (const subQuestion of subQuestions) {
    try {
      const result = await runStructuredQuery({ question: subQuestion, dataset, llmProvider, conversationContext, policy, knowledgeText });
      steps.push({
        subQuestion,
        evidence: result.evidence || null,
        failureReason: result.evidence ? null : (result.answer || 'No result.'),
      });
    } catch (err) {
      steps.push({ subQuestion, evidence: null, failureReason: err.message });
    }
  }

  const successfulSteps = steps.filter((s) => s.evidence);
  if (successfulSteps.length === 0) {
    return {
      routeType: 'ANALYSIS',
      answer: 'I planned this analysis into several steps, but none of them could be executed successfully against the dataset.',
      evidence: null,
      lowConfidence: true,
      analysisSteps: steps,
    };
  }

  // --- Step 3: SYNTHESIZE ---
  const synthesisPrompt = buildSynthesisPrompt({ question, steps, conversationContext });
  const synthesisText = await llmProvider.complete(synthesisPrompt, { temperature: 0.3, maxTokens: 700 });

  const evidence = {
    source_type: 'analysis',
    dataset_name: dataset.name,
    steps: steps.map((s) => ({
      question: s.subQuestion,
      evidence: s.evidence,
      failed: !s.evidence,
      failureReason: s.failureReason,
    })),
    confidence: successfulSteps.length / steps.length,
    generated_at: new Date().toISOString(),
  };

  return {
    routeType: 'ANALYSIS',
    // Synthesis already produces the final natural-language answer, so the
    // core engine should use it directly rather than running it through
    // composeAnswer() a second time (which is built for single-evidence-
    // object explanation, not a multi-step narrative).
    answer: synthesisText.trim(),
    evidence,
    lowConfidence: successfulSteps.length < steps.length,
  };
}

function buildPlanPrompt({ question, schema }) {
  const schemaDesc = schema.tables.map((t) => {
    const cols = t.columns.map((c) => c.name).join(', ');
    return `Table "${t.name}" [${t.rowCount} rows]: ${cols}`;
  }).join('\n');

  return `You are a data analysis planner. The person asked a complex, open-ended question that cannot be answered by a single simple query. Break it down into 2 to ${MAX_SUB_QUESTIONS} specific sub-questions, where EACH sub-question can be answered by exactly one SQL query (a count, a sum, a group-by, a rate calculation, a ranking, etc) against the schema below.

SCHEMA:
${schemaDesc}

ORIGINAL QUESTION: ${question}

Output ONLY a JSON array of strings, each a specific sub-question. No explanation, no markdown. Example format:
["How many total records are there?", "What is the breakdown by category?", "Which group has the highest rate of X?"]

JSON array:`;
}

function parsePlan(raw) {
  let text = raw.trim();
  text = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.filter((q) => typeof q === 'string' && q.trim().length > 0).map((q) => q.trim());
    }
  } catch (_) {
    // Fall through to a line-based best-effort parse below.
  }
  // Defensive fallback: some small models don't always return clean JSON -
  // try to salvage one sub-question per line if it looks like a question.
  return text.split('\n')
    .map((l) => l.replace(/^[-*\d.)\s"]+/, '').replace(/[",]+$/, '').trim())
    .filter((l) => l.length > 5 && l.length < 200);
}

function buildSynthesisPrompt({ question, steps, conversationContext = '' }) {
  const stepsDesc = steps.map((s, i) => {
    if (!s.evidence) {
      return `--- Step ${i + 1}: "${s.subQuestion}" ---\n[Could not be answered: ${s.failureReason}]`;
    }
    const ev = s.evidence;
    return `--- Step ${i + 1}: "${s.subQuestion}" ---\nQuery: ${ev.query}\nResult (JSON): ${JSON.stringify(ev.sample_rows).slice(0, 1000)}`;
  }).join('\n\n');

  return `You are CogniCore, a precise data analysis assistant. You broke a complex question into steps, ran a real query for each, and gathered the evidence below. Write a clear, well-organized answer to the ORIGINAL QUESTION using ONLY the evidence from the steps below. Do not invent any number, fact, or entity not present in the evidence.

${conversationContext ? `CONVERSATION CONTEXT:\n${conversationContext}\n\n` : ''}ORIGINAL QUESTION: ${question}

EVIDENCE FROM EACH STEP:
${stepsDesc}

Write a well-organized answer (use short paragraphs or a brief bulleted list where it helps readability). If some steps could not be answered, mention that plainly rather than ignoring it. Ground every specific number or fact you state in the evidence above.

ANSWER:`;
}

module.exports = { runAnalysisQuery, MAX_SUB_QUESTIONS };
