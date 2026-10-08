const axios = require('axios');
const { LLMProvider } = require('./llm.provider');

/** OPTIONAL cloud provider (off by default). Requires LLM_PROVIDER=anthropic and ANTHROPIC_API_KEY. */
class AnthropicProvider extends LLMProvider {
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.model = opts.model || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
    this.timeoutMs = opts.timeoutMs || 60000;
  }
  get name() { return `anthropic:${this.model}`; }
  async complete(prompt, options = {}) {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set (Anthropic provider is optional; the default provider is local Ollama).');
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: this.model, max_tokens: options.maxTokens ?? 1024, temperature: options.temperature ?? 0.2,
      messages: [{ role: 'user', content: prompt }],
    }, { timeout: this.timeoutMs, headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
    return (res.data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  async healthCheck() { return this.apiKey ? { healthy: true, configuredModel: this.model } : { healthy: false, error: 'ANTHROPIC_API_KEY not set' }; }
}
module.exports = { AnthropicProvider };
