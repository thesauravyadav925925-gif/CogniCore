const axios = require('axios');
const { LLMProvider } = require('./llm.provider');

/**
 * OPTIONAL cloud provider (off by default). CogniCore is local-first: Ollama is the default and
 * nothing here runs unless you set LLM_PROVIDER=openai (or a per-task override) AND OPENAI_API_KEY.
 * Works with any OpenAI-compatible endpoint (set OPENAI_BASE_URL), e.g. a local vLLM/LM Studio server.
 */
class OpenAIProvider extends LLMProvider {
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY || '';
    this.baseUrl = (opts.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.model = opts.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.timeoutMs = opts.timeoutMs || 60000;
  }
  get name() { return `openai:${this.model}`; }
  async complete(prompt, options = {}) {
    if (!this.apiKey && /api\.openai\.com/.test(this.baseUrl)) throw new Error('OPENAI_API_KEY is not set (OpenAI provider is optional; the default provider is local Ollama).');
    const res = await axios.post(`${this.baseUrl}/chat/completions`, {
      model: this.model, temperature: options.temperature ?? 0.2, max_tokens: options.maxTokens ?? 1024,
      messages: [{ role: 'user', content: prompt }],
      ...(options.json ? { response_format: { type: 'json_object' } } : {}),
    }, { timeout: this.timeoutMs, headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {} });
    return res.data?.choices?.[0]?.message?.content || '';
  }
  async healthCheck() {
    if (!this.apiKey && /api\.openai\.com/.test(this.baseUrl)) return { healthy: false, error: 'OPENAI_API_KEY not set' };
    return { healthy: true, configuredModel: this.model };
  }
}
module.exports = { OpenAIProvider };
