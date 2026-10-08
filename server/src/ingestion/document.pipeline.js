const path = require('path');
const { parseDocument } = require('../documents/parser');
const { chunkPages } = require('../documents/chunker');
const { embedAndStore } = require('../documents/embedder');
const { VectorStore } = require('../documents/vector.store');
const { getEmbeddingProvider } = require('../llm/model.manager');
const { DatasetRegistry } = require('./dataset.registry');

/**
 * DOCUMENT INGESTION PIPELINE
 *   PDF/DOCX/TXT -> Parser -> Chunker -> Embedder -> Vector Store -> Registry
 *
 * Mirrors ingestion.pipeline.js's shape for structured files, but produces
 * a "document profile" (chunk/page counts) instead of a SQL schema, since
 * there is no table/column concept here (Rule #16: separate pipelines).
 */
async function ingestDocument({ filePath, originalFilename, fileType, ownerId = null }) {
  const name = path.basename(originalFilename, path.extname(originalFilename));

  const record = DatasetRegistry.create({
    name,
    type: fileType,
    source: 'upload',
    location: filePath,
    ownerId,
  });

  try {
    const parsed = await parseDocument(filePath, fileType);
    const chunks = chunkPages(parsed.pages);

    if (chunks.length === 0) {
      throw new Error(fileType === 'pdf' ? 'No extractable text found in this PDF. If it is a scanned document, install Tesseract OCR and Poppler on the server and upload it again.' : 'No extractable text found in this document.');
    }

    const embeddingProvider = getEmbeddingProvider();
    await embedAndStore(embeddingProvider, record.dataset_id, chunks);

    const profile = {
      documentType: fileType,
      pageCount: parsed.metadata.pageCount,
      chunkCount: chunks.length,
      charCount: parsed.fullText.length,
      title: parsed.metadata.title || name,
      sections: [...new Set(chunks.map((c) => c.section).filter(Boolean))].slice(0, 50),
      ocr: !!parsed.metadata.ocr,
    };

    // No SQL schema for documents - `schema` stays a document-shaped marker
    // so downstream code (query planner, schema route) can branch on it
    // without special-casing dataset.type everywhere.
    return DatasetRegistry.markReady(record.dataset_id, {
      schema: { documentProfile: profile },
      profile,
    });
  } catch (err) {
    VectorStore.deleteForDataset(record.dataset_id);
    DatasetRegistry.markError(record.dataset_id, err.message);
    throw err;
  }
}

module.exports = { ingestDocument };
