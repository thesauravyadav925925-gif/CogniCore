/**
 * FILE TYPE DETECTOR
 * Detects a dataset's type from its file extension / content signature.
 * This is deliberately dumb and mechanical - it has no domain knowledge.
 */
const path = require('path');
const fs = require('fs');

const EXTENSION_MAP = {
  '.db': 'sqlite',
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.json': 'json',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.markdown': 'txt',
  '.txt': 'txt',
  '.md': 'txt',
};

function detectByExtension(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_MAP[ext] || null;
}

/**
 * Some files (e.g. exported without extension) can be sniffed by magic bytes.
 * SQLite files start with the literal string "SQLite format 3\0".
 */
function detectBySignature(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(16);
    fs.readSync(fd, buffer, 0, 16, 0);
    fs.closeSync(fd);
    if (buffer.toString('utf8', 0, 15) === 'SQLite format 3') return 'sqlite';
    if (buffer.toString('utf8', 0, 4) === '%PDF') return 'pdf';
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'xlsx_or_docx_zip'; // both are zip containers
  } catch (_) {
    // ignore, fall through
  }
  return null;
}

function detectFileType(filePath, originalFilename) {
  const byExt = detectByExtension(originalFilename || filePath);
  if (byExt) return byExt;

  const bySig = detectBySignature(filePath);
  if (bySig && bySig !== 'xlsx_or_docx_zip') return bySig;

  throw new Error(`Unable to determine file type for "${originalFilename || filePath}". Supported: sqlite, csv, xlsx, json, pdf, docx, pptx, txt, md`);
}

module.exports = { detectFileType, EXTENSION_MAP };
