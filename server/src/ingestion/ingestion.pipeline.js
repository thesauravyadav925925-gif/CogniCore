const path = require('path');
const { detectFileType } = require('./file.detector');
const { createAdapter } = require('./adapters');
const { readSchema } = require('../schema/schema.reader');
const { analyzeSchema } = require('../schema/schema.analyzer');
const { DatasetRegistry } = require('./dataset.registry');
const { ingestDocument } = require('./document.pipeline');
const { enrichProfile } = require('./profile.enricher');

const DOCUMENT_TYPES = new Set(['pdf', 'docx', 'txt', 'pptx']);

/**
 * INGESTION PIPELINE
 *   Upload -> File Detector -> Ingestion Router (adapter) -> Schema
 *   Extraction -> Dataset Registry
 *
 * This is the ONLY place that wires ingestion steps together end-to-end.
 * It has no domain knowledge - only mechanics. Document types are routed
 * to a completely separate pipeline (Rule #16: structured data and
 * documents must have separate execution pipelines) since they have no
 * SQL schema at all.
 */
async function ingestFile({ filePath, originalFilename, ownerId = null }) {
  const type = detectFileType(filePath, originalFilename);

  if (DOCUMENT_TYPES.has(type)) {
    return ingestDocument({ filePath, originalFilename, fileType: type, ownerId });
  }

  const name = path.basename(originalFilename, path.extname(originalFilename));

  const record = DatasetRegistry.create({
    name,
    type,
    source: 'upload',
    location: filePath,
    ownerId,
  });

  try {
    const adapter = createAdapter(type, { datasetId: record.dataset_id, location: filePath });

    let schema, profile;
    if (typeof adapter.ingest === 'function') {
      // CSV / Excel: must be materialized first.
      const result = await adapter.ingest(name);
      schema = result.schema;
      profile = result.profile;
    } else {
      // SQLite (and future DB adapters): schema can be read directly.
      const result = await readSchema(adapter);
      schema = result.schema;
      profile = result.metadata;
    }

    const analyzed = analyzeSchema(schema, profile);
    const enriched = await enrichProfile({
      type, datasetId: record.dataset_id, location: filePath, schema,
      relationships: analyzed.relationships,
      loaderNotes: profile && profile.dateNormalization ? { [schema.tables[0].name]: profile } : profile,
    });
    Object.assign(analyzed, enriched);
    const updated = DatasetRegistry.markReady(record.dataset_id, {
      schema,
      profile: analyzed,
    });
    return updated;
  } catch (err) {
    DatasetRegistry.markError(record.dataset_id, err.message);
    throw err;
  }
}

module.exports = { ingestFile };
