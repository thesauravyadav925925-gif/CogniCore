const fs = require('fs');
const path = require('path');

/**
 * DOCUMENT PARSER
 * Section 13 of the spec: PDF/DOCX/TXT -> text extraction.
 * Returns a uniform shape regardless of source format:
 *   { pages: [{ pageNumber, text }], fullText, metadata }
 * `pages` has exactly one entry for formats without real pagination
 * (DOCX/TXT/MD) - the chunker treats that as "page 1" and simply omits
 * the page number in evidence.
 */
async function parseDocument(filePath, fileType) {
  switch (fileType) {
    case 'pdf':
      return parsePdf(filePath);
    case 'docx':
      return parseDocx(filePath);
    case 'pptx':
      return parsePptx(filePath);
    case 'txt':
      return parseTxt(filePath);
    default:
      throw new Error(`Document parser does not support type "${fileType}"`);
  }
}

// pdfjs-dist prints a one-time harmless warning at require-time about
// missing browser-only `canvas`/DOMMatrix polyfills, even though we only
// extract text and never render. Documented in README as a known,
// harmless startup log line - not worth fighting pdfjs-dist's internal
// logging mechanism (it writes past console.warn) to suppress it.
function getPdfjs() {
  return require('pdfjs-dist/legacy/build/pdf.js');
}

async function parsePdf(filePath) {
  const pdfjs = getPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));

  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    verbosity: 0,
  });
  const pdfDocument = await loadingTask.promise;

  const pages = [];
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item) => item.str).join(' ');
    pages.push({ pageNumber: pageNum, text: cleanText(text) });
  }

  // Scanned PDF (almost no selectable text): try OCR if the server has it, otherwise explain clearly.
  const textChars = pages.reduce((n, p) => n + p.text.length, 0);
  let scanned = false;
  if (pages.length > 0 && textChars < 20 * pages.length) {
    scanned = true;
    const ocrPages = require('./ocr').ocrPdf(filePath);
    if (ocrPages.reduce((n, p) => n + p.text.length, 0) > 0) { pages.length = 0; pages.push(...ocrPages); }
  }

  let title = null;
  try {
    const metadata = await pdfDocument.getMetadata();
    title = metadata?.info?.Title || null;
  } catch (_) { /* metadata is optional */ }

  return {
    pages,
    fullText: pages.map((p) => p.text).join('\n\n'),
    metadata: { pageCount: pages.length, title, ocr: scanned },
  };
}

async function parseDocx(filePath) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  const text = cleanText(result.value);
  return {
    pages: [{ pageNumber: null, text }],
    fullText: text,
    metadata: { pageCount: null },
  };
}

async function parseTxt(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const text = cleanText(raw);
  return {
    pages: [{ pageNumber: null, text }],
    fullText: text,
    metadata: { pageCount: null },
  };
}

/** PowerPoint: one "page" per slide (so evidence can cite "slide 4"). */
async function parsePptx(filePath) {
  const { readZipEntries } = require('./zip.reader');
  const zip = readZipEntries(fs.readFileSync(filePath));
  const slideNames = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
  if (!slideNames.length) throw new Error('This file does not look like a PowerPoint presentation (no slides found).');
  const decode = (x) => x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const pages = slideNames.map((n, i) => {
    const xml = zip.read(n).toString('utf8');
    const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g) || []).map((p) => decode((p.match(/<a:t>[^<]*<\/a:t>|<a:t [^>]*>[^<]*<\/a:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')).trim()).filter(Boolean);
    const notesName = n.replace('ppt/slides/slide', 'ppt/notesSlides/notesSlide');
    let notes = '';
    if (zip.has(notesName)) notes = decode((zip.read(notesName).toString('utf8').match(/<a:t>[^<]*<\/a:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join(' ')).trim();
    const title = paras[0] || `Slide ${i + 1}`;
    return { pageNumber: i + 1, text: cleanText(`# ${title}\n${paras.slice(1).join('\n')}${notes ? `\nSpeaker notes: ${notes}` : ''}`) };
  });
  return { pages, fullText: pages.map((p) => p.text).join('\n\n'), metadata: { pageCount: pages.length, slides: pages.length } };
}

function cleanText(text) {
  return (text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { parseDocument };
