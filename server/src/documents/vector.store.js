const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');

/**
 * VECTOR STORE
 * ------------------------------------------------------------------
 * Deliberately NOT a dedicated vector database (Pinecone/Qdrant/etc) -
 * per Rule #29 ("no mandatory cloud API") and the project's local-first
 * philosophy, embeddings are stored as JSON arrays in the same SQLite
 * registry database and similarity search is brute-force cosine in JS.
 *
 * This is the right trade-off for a final-year-project / single-user /
 * departmental-scale deployment. It does NOT scale to millions of chunks -
 * that's an explicit, documented limitation, not an oversight (see
 * PROGRESS.md). Swapping this module for a real ANN index (e.g.
 * sqlite-vec, hnswlib) later does not require touching the retriever's
 * calling code, only this file.
 * ------------------------------------------------------------------
 */
const db = new Database(config.paths.registryDb);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    page_number INTEGER,
    text TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_document_chunks_dataset ON document_chunks(dataset_id);
`);
// migration: section titles (blueprint #8)
if (!db.prepare(`PRAGMA table_info(document_chunks)`).all().some((c) => c.name === 'section')) {
  db.exec(`ALTER TABLE document_chunks ADD COLUMN section TEXT`);
}

function now() { return new Date().toISOString(); }

const VectorStore = {
  insertChunks(datasetId, chunks /* [{chunkIndex, pageNumber, text, embedding}] */) {
    const insert = db.prepare(`
      INSERT INTO document_chunks (chunk_id, dataset_id, chunk_index, page_number, text, embedding_json, created_at, section)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = db.transaction((rows) => {
      for (const c of rows) {
        insert.run(uuidv4(), datasetId, c.chunkIndex, c.pageNumber ?? null, c.text, JSON.stringify(c.embedding), now(), c.section ?? null);
      }
    });
    insertMany(chunks);
  },

  countChunks(datasetId) {
    return db.prepare(`SELECT COUNT(*) AS c FROM document_chunks WHERE dataset_id = ?`).get(datasetId).c;
  },

  listChunks(datasetId, limit = 10) {
    return db.prepare(`
      SELECT chunk_index, page_number, text FROM document_chunks
      WHERE dataset_id = ? ORDER BY chunk_index ASC LIMIT ?
    `).all(datasetId, limit);
  },

  deleteForDataset(datasetId) {
    db.prepare(`DELETE FROM document_chunks WHERE dataset_id = ?`).run(datasetId);
  },

  /** Brute-force cosine similarity search within one dataset's chunks. */
  search(datasetId, queryEmbedding, topK = config.documents.retrievalTopK) {
    const rows = db.prepare(`SELECT chunk_index, page_number, section, text, embedding_json FROM document_chunks WHERE dataset_id = ?`).all(datasetId);
    const scored = rows.map((r) => ({
      chunkIndex: r.chunk_index,
      pageNumber: r.page_number,
      section: r.section,
      text: r.text,
      score: cosineSimilarity(queryEmbedding, JSON.parse(r.embedding_json)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  },
};

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = { VectorStore, cosineSimilarity };
