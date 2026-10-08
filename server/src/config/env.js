/**
 * Centralized environment configuration.
 * RULE: Keep configuration separate from business logic (Rule #32).
 * RULE: Never place API keys in source code (Rule #12).
 */
require('dotenv').config();

const path = require('path');

const isTest = (process.env.NODE_ENV || 'development') === 'test';

// --- Storage paths ---
// In test mode, isolate all state under data-test/ so `npm test` never
// touches (or is affected by) whatever's in the real dev database.
const defaultDataDir = path.join(__dirname, '..', '..', isTest ? 'data-test' : 'data');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),

  // --- LLM Provider configuration (Rule #13, #14) ---
  llm: {
    provider: process.env.LLM_PROVIDER || 'ollama',
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
      timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10),
      embeddingModel: process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text',
    },
  },

  paths: {
    data: process.env.DATA_DIR || defaultDataDir,
    uploads: process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', isTest ? 'uploads-test' : 'uploads'),
    registryDb: process.env.REGISTRY_DB_PATH || path.join(process.env.DATA_DIR || defaultDataDir, 'cognicore_registry.db'),
  },

  // --- Query safety limits ---
  query: {
    maxRows: parseInt(process.env.MAX_RESULT_ROWS || '1000', 10),
    timeoutMs: parseInt(process.env.QUERY_TIMEOUT_MS || '15000', 10),
  },

  // --- Upload limits ---
  upload: {
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB || '100', 10),
  },
  // --- Auth / Security ---
  auth: {
    jwtSecret: process.env.JWT_SECRET || 'CHANGE_ME_dev_only_insecure_secret',
    jwtExpiry: process.env.JWT_EXPIRY || '7d',
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '10', 10),
  },

  // --- Document / RAG settings ---
  documents: {
    chunkMaxChars: parseInt(process.env.CHUNK_MAX_CHARS || '1200', 10),
    chunkOverlapChars: parseInt(process.env.CHUNK_OVERLAP_CHARS || '150', 10),
    retrievalTopK: parseInt(process.env.RETRIEVAL_TOP_K || '5', 10),
  },
};

module.exports = config;


/**
 * SECRETS MANAGEMENT (blueprint #17): secrets come only from the environment (never from code or
 * the database), and production refuses to start with a missing/default/weak signing secret.
 */
function assertProductionSecrets(cfg = module.exports) {
  const secret = cfg.auth.jwtSecret || '';
  const weak = !secret || /CHANGE_ME|changeme|secret$|password/i.test(secret) || secret.length < 32;
  if (process.env.NODE_ENV === 'production' && weak) {
    throw new Error('Refusing to start in production: JWT_SECRET must be set to a random value of at least 32 characters.');
  }
  return !weak;
}
module.exports.assertProductionSecrets = assertProductionSecrets;
