const axios = require('axios');
const { LLMProvider } = require('./llm.provider');
const config = require('../config/env');

/**
 * OllamaProvider
 * RULE #13: Ollama must be the default LLM provider.
 * RULE #29: No API key required - purely local.
 */
class OllamaProvider extends LLMProvider {
  constructor(opts = {}) {
    super();
    this.baseUrl = opts.baseUrl || config.llm.ollama.baseUrl;
    this.model = opts.model || config.llm.ollama.model;
    this.timeoutMs = opts.timeoutMs || config.llm.ollama.timeoutMs;
  }

  get name() { return `ollama:${this.model}`; }

  async complete(prompt, options = {}) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/generate`,
        {
          model: this.model,
          prompt,
          stream: false,
          format: options.json ? 'json' : undefined,
          options: {
            temperature: options.temperature ?? 0.2,
            num_predict: options.maxTokens ?? 1024,
          },
        },
        { timeout: this.timeoutMs }
      );
      return response.data.response || '';
    } catch (err) {
      throw new LLMConnectionError(
        `Failed to reach Ollama at ${this.baseUrl}. Is "ollama serve" running and is model "${this.model}" pulled? (${err.message})`
      );
    }
  }

  async healthCheck() {
    try {
      const res = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 5000 });
      const models = (res.data.models || []).map(m => m.name);
      return { healthy: true, models, configuredModel: this.model, modelAvailable: models.some(m => m.startsWith(this.model.split(':')[0])) };
    } catch (err) {
      return { healthy: false, error: err.message };
    }
  }
}

class LLMConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMConnectionError';
  }
}

module.exports = { OllamaProvider, LLMConnectionError };
