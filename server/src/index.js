const { createApp } = require('./app');
const config = require('./config/env');
config.assertProductionSecrets();
const logger = require('./config/logger');
const { getLLMProvider, getEmbeddingProvider } = require('./llm/model.manager');

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`\n  CogniCore server running → http://localhost:${config.port}`);
  console.log(`  LLM provider: ${config.llm.provider} (${config.llm.ollama.model})`);
  console.log(`  Ollama URL:   ${config.llm.ollama.baseUrl}`);
  console.log(`  Data dir:     ${config.paths.data}\n`);
  if (config.auth.jwtSecret === 'CHANGE_ME_dev_only_insecure_secret') {
    console.warn('  ⚠  WARNING: JWT_SECRET is still the default dev value. Set a real secret in .env before deploying anywhere but your own machine.\n');
  }
  warmUpOllama();
});

/**
 * WARM-UP
 * Ollama loads a model's weights into memory on its FIRST request after
 * `ollama serve` starts (or after the model has been idle and got
 * unloaded), which can easily take well over a minute for a 7B model on
 * modest hardware. Without this, the very first real question a person
 * asks eats that entire cold-start cost and can exceed the request
 * timeout. Firing a trivial request at server startup pays that cost
 * upfront instead, so it's already warm by the time someone's typing.
 * This is fire-and-forget - failure here (e.g. Ollama not running yet)
 * is only logged, never blocks the server from starting or answering
 * other requests.
 */
async function warmUpOllama() {
  if (config.llm.provider !== 'ollama') return;
  logger.info('Warming up Ollama (loading model into memory - this can take a while on first run)...');
  const start = Date.now();
  try {
    await getLLMProvider().complete('Say OK.', { maxTokens: 5 });
    logger.info(`Chat model warm (${((Date.now() - start) / 1000).toFixed(1)}s).`);
  } catch (err) {
    logger.warn('Chat model warm-up failed - first real question may be slow or time out.', { message: err.message });
  }
  try {
    await getEmbeddingProvider().embed(['warm up']);
    logger.info('Embedding model warm.');
  } catch (err) {
    logger.warn('Embedding model warm-up failed (only matters for PDF/DOCX/TXT uploads).', { message: err.message });
  }
}

/**
 * ERROR RECOVERY / GRACEFUL SHUTDOWN
 * - Route-level errors are already caught by errorHandler.js and never
 *   reach here.
 * - unhandledRejection/uncaughtException catch anything that slips past
 *   that (e.g. an error thrown outside an Express request context, or a
 *   promise rejection nobody awaited) so the process logs clearly and
 *   exits cleanly instead of leaving the server in an undefined state.
 * - SIGTERM/SIGINT (what Docker/most process managers send on stop/restart)
 *   close the HTTP server gracefully, letting in-flight requests finish
 *   rather than dropping them mid-response.
 */
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason?.message || String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception - shutting down', { message: err.message, stack: err.stack });
  process.exit(1);
});

function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });
  // Safety net: force-exit if close() hangs (e.g. a stuck connection).
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
