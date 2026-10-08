/**
 * FILE-CONTENT VALIDATION (blueprint #17)
 * The extension is only a claim. Before a single byte is parsed we check that the CONTENT matches
 * it (magic bytes / structure), reject disguised executables and archives, and cap the size of
 * zip-based formats against zip bombs. Fails closed: unknown content is refused.
 */
const fs = require('fs');
const path = require('path');

class UploadValidationError extends Error { constructor(m) { super(m); this.name = 'UploadValidationError'; this.status = 400; } }

const ZIP_BASED = { '.xlsx': 'xl/', '.docx': 'word/', '.pptx': 'ppt/' };
const TEXT_EXT = new Set(['.csv', '.txt', '.md', '.markdown', '.json']);
const BLOCKED_SIGNATURES = [
  [Buffer.from('MZ'), 'a Windows executable', true],
  [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'a Linux executable', true],
  [Buffer.from('#!'), 'a script'],
  [Buffer.from([0xca, 0xfe, 0xba, 0xbe]), 'a compiled program', true],
  [Buffer.from('<?php'), 'PHP code'],
  [Buffer.from('<script', 'utf8'), 'HTML/JavaScript'],
];

function readHead(file, n = 8192) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(n); const r = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, r); } finally { fs.closeSync(fd); }
}

function looksLikeText(head) {
  if (head.includes(0)) return false;                       // NUL byte => binary
  const s = head.toString('utf8');
  const bad = (s.match(/\uFFFD/g) || []).length;           // replacement chars => not UTF-8 text
  return bad / Math.max(s.length, 1) < 0.02;
}

function sanitizeFilename(name) {
  return path.basename(String(name || 'upload')).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^\.+/, '').slice(0, 150) || 'upload';
}

/** Throws UploadValidationError; returns { ext, kind } when the content matches the extension. */
function validateUpload(filePath, originalName) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  const stat = fs.statSync(filePath);
  if (stat.size === 0) throw new UploadValidationError('The uploaded file is empty.');
  const head = readHead(filePath);

  // Binary executables are refused whatever the extension; script/markup signatures are refused for data files
  // (a .txt/.md note may legitimately start with "#!" or contain HTML text).
  for (const [sig, what, always] of BLOCKED_SIGNATURES) {
    if (!head.subarray(0, sig.length).equals(sig)) continue;
    if (always || !['.txt', '.md', '.markdown'].includes(ext)) throw new UploadValidationError(`This file looks like ${what}, not a data file, and was rejected.`);
  }

  if (ext === '.pdf') {
    if (!head.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw new UploadValidationError('This file is named .pdf but its content is not a PDF.');
    return { ext, kind: 'pdf' };
  }
  if (['.db', '.sqlite', '.sqlite3'].includes(ext)) {
    if (head.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw new UploadValidationError('This file is named like a SQLite database but its content is not a SQLite database.');
    return { ext, kind: 'sqlite' };
  }
  if (ZIP_BASED[ext]) {
    if (head.readUInt32LE(0) !== 0x04034b50) throw new UploadValidationError(`This file is named ${ext} but is not a valid Office file.`);
    let zip;
    try { zip = require('../documents/zip.reader').readZipEntries(fs.readFileSync(filePath)); } catch (e) { throw new UploadValidationError(`Invalid or unsafe ${ext} file: ${e.message}`); }
    if (!zip.names.some((n) => n.startsWith(ZIP_BASED[ext]))) throw new UploadValidationError(`This file is a ZIP archive but not a real ${ext} document.`);
    return { ext, kind: 'office' };
  }
  if (ext === '.xls') {
    if (!(head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) || head.readUInt32LE(0) === 0x04034b50)) throw new UploadValidationError('This file is named .xls but is not a spreadsheet.');
    return { ext, kind: 'office' };
  }
  if (TEXT_EXT.has(ext)) {
    if (!looksLikeText(head)) throw new UploadValidationError(`This file is named ${ext} but its content is binary, not text.`);
    if (ext === '.json') {
      const t = head.toString('utf8').trimStart();
      if (!/^[\[{]/.test(t)) throw new UploadValidationError('This file is named .json but does not start like JSON.');
    }
    return { ext, kind: 'text' };
  }
  throw new UploadValidationError(`Unsupported file type "${ext || '(none)'}". Supported: CSV, Excel, JSON, SQLite, PDF, Word, PowerPoint, TXT, Markdown.`);
}

module.exports = { validateUpload, sanitizeFilename, UploadValidationError, looksLikeText };
