const axios = require('axios');
const { EmbeddingProvider } = require('./embedding.provider');
const config = require('../config/env');

class OllamaEmbeddingProvider extends EmbeddingProvider {
  constructor(opts = {}) {
    super();
    this.baseUrl = opts.baseUrl || config.llm.ollama.baseUrl;
    this.model = opts.model || config.llm.ollama.embeddingModel;
    this.timeoutMs = opts.timeoutMs || config.llm.ollama.timeoutMs;
  }

  get name() { return `ollama-embed:${this.model}`; }

  async embed(texts) {
    const vectors = [];
    // Ollama's /api/embeddings takes one prompt at a time; batch sequentially
    // to keep memory bounded on modest local hardware.
    for (const text of texts) {
      try {
        const res = await axios.post(
          `${this.baseUrl}/api/embeddings`,
          { model: this.model, prompt: text },
          { timeout: this.timeoutMs }
        );
        vectors.push(res.data.embedding);
      } catch (err) {
        throw new Error(
          `Failed to get embeddings from Ollama at ${this.baseUrl}. Is "ollama pull ${this.model}" done? (${err.message})`
        );
      }
    }
    return vectors;
  }

  async healthCheck() {
    try {
      const res = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 5000 });
      const models = (res.data.models || []).map((m) => m.name);
      return { healthy: true, modelAvailable: models.some((m) => m.startsWith(this.model.split(':')[0])) };
    } catch (err) {
      return { healthy: false, error: err.message };
    }
  }
}

module.exports = { OllamaEmbeddingProvider };
