/**
 * LLMProvider - abstract interface.
 * RULE #14: LLM providers must be abstracted behind an interface.
 * Future: OpenAIProvider, AnthropicProvider, DeepSeekProvider can be
 * added by implementing this same contract - core engine code never changes.
 */
class LLMProvider {
  /**
   * @param {string} prompt - full prompt (system + user context already composed)
   * @param {object} options - { temperature, maxTokens, json (bool) }
   * @returns {Promise<string>} raw text completion
   */
  async complete(prompt, options = {}) {
    throw new Error('complete() not implemented');
  }

  /** Whether the provider is reachable right now. */
  async healthCheck() {
    throw new Error('healthCheck() not implemented');
  }

  get name() {
    return 'unknown';
  }
}

module.exports = { LLMProvider };
