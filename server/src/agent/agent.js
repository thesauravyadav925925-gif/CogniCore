/**
 * AGENT / TOOL ROUTER (Feature 25)
 *   request -> intent -> tool (SQL | Python | Search/RAG | Report | Chart | ...) -> result
 * `tryAgent` handles the analytic intents with purpose-built, deterministic tools.
 * It returns null whenever it is unsure, and the normal SQL / document / hybrid
 * path takes over - so the agent can only ever ADD capability, never block it.
 */
const { classifyIntent } = require('./intent.classifier');
const { TOOLS } = require('./analytic.tools');
const { runOrchestrated } = require('./orchestrator');
const R = require('./column.resolver');
const logger = require('../config/logger');

const ANALYTIC_INTENTS = new Set(['overview', 'describe', 'scenario', 'trend', 'forecast', 'anomaly', 'correlation', 'compare', 'quality', 'kpi', 'explore']);

async function tryAgent({ question, dataset, policy = null }) {
  const { intent } = classifyIntent(question);
  if (!ANALYTIC_INTENTS.has(intent)) return { handled: false, intent };
  const semantic = dataset?.profile?.semantic;
  if (!semantic || !dataset.schema?.tables?.length) return { handled: false, intent };

  const words = R.questionWords(question);
  const table = R.pickTable(semantic, words);
  if (!table) return { handled: false, intent };

  const ctx = { question, dataset, semantic, table, words, policy };
  try {
    const out = intent === 'overview' ? await runOrchestrated({ question, dataset, policy, semantic, table }) : await TOOLS[intent](ctx);
    if (!out) return { handled: false, intent };
    return { handled: true, intent, ...out };
  } catch (err) {
    // A tool failing must never turn into a wrong answer - hand over to the standard pipeline.
    logger.warn('Agent tool failed; falling back to standard pipeline', { intent, message: err.message });
    return { handled: false, intent, error: err.message };
  }
}

module.exports = { tryAgent, classifyIntent };
