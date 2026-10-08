/**
 * OPTIONAL OCR (blueprint #8: scanned documents). CogniCore does not bundle an OCR engine
 * (it would force a native download). If `pdftoppm` (poppler) and `tesseract` are installed,
 * scanned PDFs and images are read with them; otherwise the user gets a clear, actionable message.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function has(bin) { try { return spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 }).error === undefined; } catch (_) { return false; } }
function ocrAvailable() { return { tesseract: has('tesseract'), pdftoppm: has('pdftoppm') }; }

function ocrImage(imgPath) {
  const r = spawnSync('tesseract', [imgPath, 'stdout', '-l', process.env.OCR_LANG || 'eng'], { encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error('tesseract failed');
  return r.stdout || '';
}

/** Returns [{pageNumber, text}] or throws a user-facing error. */
function ocrPdf(pdfPath, { maxPages = 60 } = {}) {
  const a = ocrAvailable();
  if (!a.tesseract || !a.pdftoppm) {
    throw new Error('This PDF looks scanned (no selectable text). To read it, install Tesseract OCR and Poppler (pdftoppm) on the server, then upload it again.');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ocr-'));
  try {
    const r = spawnSync('pdftoppm', ['-r', '200', '-l', String(maxPages), '-png', pdfPath, path.join(dir, 'p')], { timeout: 300000 });
    if (r.error || r.status !== 0) throw new Error('Could not render the PDF pages for OCR.');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    return files.map((f, i) => ({ pageNumber: i + 1, text: ocrImage(path.join(dir, f)).replace(/[ \t]+/g, ' ').trim() }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { ocrAvailable, ocrPdf, ocrImage };
