const { OllamaProvider } = require('./ollama.provider');
const { OllamaEmbeddingProvider } = require('./ollama.embedding.provider');
const { OpenAIProvider } = require('./openai.provider');
const { AnthropicProvider } = require('./anthropic.provider');
const config = require('../config/env');

/**
 * MODEL MANAGER + MODEL ROUTER (blueprint #10, #11)
 * The ONLY place that decides which provider/model is used. Everything else depends on the
 * LLMProvider interface and asks for a *task*:
 *     getLLMProvider('sql')        small, fast model for SQL generation
 *     getLLMProvider('reasoning')  stronger model for explanations / synthesis
 *     getLLMProvider('rewrite')    follow-up rewriting
 *     getLLMProvider('planner')    multi-step planning
 *     getLLMProvider()             default
 * Per-task overrides (all optional; unset = the default model, so a plain install is unchanged):
 *     OLLAMA_MODEL_SQL, OLLAMA_MODEL_REASONING, OLLAMA_MODEL_REWRITE, OLLAMA_MODEL_PLANNER
 *     LLM_PROVIDER_SQL, ... (ollama | openai | anthropic)
 * Default stays 100% local (Ollama); cloud providers only run if explicitly selected.
 */
const TASKS = ['sql', 'reasoning', 'rewrite', 'planner'];
const cache = new Map();
let _embeddingInstance = null;

function providerNameFor(task) {
  return (task && process.env[`LLM_PROVIDER_${task.toUpperCase()}`]) || config.llm.provider;
}
function ollamaModelFor(task) {
  return (task && process.env[`OLLAMA_MODEL_${task.toUpperCase()}`]) || config.llm.ollama.model;
}

function build(name, task) {
  switch (name) {
    case 'ollama': return new OllamaProvider({ model: ollamaModelFor(task) });
    case 'openai': return new OpenAIProvider({ model: process.env[`OPENAI_MODEL_${(task || '').toUpperCase()}`] || undefined });
    case 'anthropic': return new AnthropicProvider({ model: process.env[`ANTHROPIC_MODEL_${(task || '').toUpperCase()}`] || undefined });
    default: throw new Error(`Unknown LLM provider "${name}". Supported: ollama (default), openai, anthropic`);
  }
}

function getLLMProvider(task = null) {
  const t = TASKS.includes(task) ? task : null;
  const name = providerNameFor(t);
  const key = `${name}:${t ? ollamaModelFor(t) : 'default'}:${t || 'default'}`;
  if (!cache.has(key)) cache.set(key, build(name, t));
  return cache.get(key);
}

function getEmbeddingProvider() {
  if (_embeddingInstance) return _embeddingInstance;
  // Embeddings are always local (Ollama) - documents never have to leave the machine.
  _embeddingInstance = new OllamaEmbeddingProvider();
  return _embeddingInstance;
}

/** What each task currently routes to (shown in the Admin tab and /api/admin/models). */
function describeRouting() {
  const rows = [{ task: 'default', provider: config.llm.provider, model: config.llm.ollama.model }];
  for (const t of TASKS) {
    const p = providerNameFor(t);
    rows.push({ task: t, provider: p, model: p === 'ollama' ? ollamaModelFor(t) : (getLLMProvider(t).model || '') });
  }
  rows.push({ task: 'embedding', provider: 'ollama', model: config.llm.ollama.embeddingModel });
  rows.push({ task: 'rerank', provider: 'local', model: 'BM25 + dense hybrid (no model needed)' });
  return rows;
}

module.exports = { getLLMProvider, getEmbeddingProvider, describeRouting, TASKS };
