const { createAdapter } = require('./adapters');
const { buildSemanticModel } = require('../semantic/semantic.builder');
const { analyzeDataQuality } = require('../quality/data.quality');
const logger = require('../config/logger');

/**
 * Builds the semantic model (Feature 2/20) and data-quality report (Feature 15)
 * for a freshly ingested structured dataset. Best-effort by design: a failure
 * here must never fail ingestion - the dataset just falls back to the plain
 * schema-only behaviour it had before.
 */
async function enrichProfile({ type, datasetId, location, schema, relationships = [], loaderNotes = null }) {
  const out = {};
  const adapter = createAdapter(type, { datasetId, location });
  try {
    await adapter.connect();
    try {
      out.semantic = await buildSemanticModel({ adapter, schema, datasetType: type, relationships });
    } catch (err) {
      logger.warn('Semantic model build failed (continuing without it)', { datasetId, message: err.message });
    }
    try {
      out.quality = await analyzeDataQuality({ adapter, schema, semantic: out.semantic, datasetType: type, relationships });
      mergeLoaderNotes(out.quality, loaderNotes);
    } catch (err) {
      logger.warn('Data-quality analysis failed (continuing without it)', { datasetId, message: err.message });
    }
  } catch (err) {
    logger.warn('Profile enrichment skipped', { datasetId, message: err.message });
  } finally {
    try { await adapter.disconnect(); } catch (_) { /* ignore */ }
  }
  return out;
}

/** Date columns normalized to ISO at load time are reported as quality findings, not hidden. */
function mergeLoaderNotes(quality, loaderNotes) {
  if (!quality || !loaderNotes) return;
  for (const t of quality.tables) {
    const notes = loaderNotes[t.name];
    if (!notes?.dateNormalization) continue;
    for (const [col, info] of Object.entries(notes.dateNormalization)) {
      const formats = Object.keys(info.formats || {});
      if (formats.length > 1) {
        t.issues.push({ type: 'mixed_date_formats', severity: 'medium', column: col, count: formats.length,
          message: `${col} mixed ${formats.length} date formats (${formats.join(', ')}); values were normalized to YYYY-MM-DD when loaded.` });
      }
      if (info.invalidCount > 0) {
        t.issues.push({ type: 'invalid_dates', severity: 'high', column: col, count: info.invalidCount,
          message: `${info.invalidCount} value${info.invalidCount === 1 ? '' : 's'} in ${col} are not valid dates.`, examples: info.invalidExamples });
      }
    }
    const weights = { high: 12, medium: 5, low: 2 };
    t.score = Math.max(0, 100 - t.issues.reduce((s, i) => s + weights[i.severity], 0));
    t.summary = `${t.issues.length} issue${t.issues.length === 1 ? '' : 's'} found.`;
  }
  const scores = quality.tables.map((t) => t.score);
  quality.overallScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 100;
  quality.issueCount = quality.tables.reduce((s, t) => s + t.issues.length, 0);
}

module.exports = { enrichProfile };
