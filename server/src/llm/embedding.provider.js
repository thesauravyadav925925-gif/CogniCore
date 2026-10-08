/**
 * EmbeddingProvider - abstract interface.
 * Kept separate from LLMProvider because a deployment might reasonably
 * want text generation from one place and embeddings from another, and
 * because RULE #14 asks for provider abstraction generally, not just
 * for chat completions.
 */
class EmbeddingProvider {
  /**
   * @param {string[]} texts
   * @returns {Promise<number[][]>} one embedding vector per input text, same order
   */
  async embed(texts) {
    throw new Error('embed() not implemented');
  }

  async healthCheck() {
    throw new Error('healthCheck() not implemented');
  }

  get name() {
    return 'unknown';
  }
}

module.exports = { EmbeddingProvider };
