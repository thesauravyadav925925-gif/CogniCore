const config = require('../config/env');
const { splitBySection } = require('./sections');

/**
 * CHUNKER
 * Splits each page's text into overlapping chunks sized for embedding.
 * Prefers to break on paragraph/sentence boundaries rather than mid-word.
 */
function chunkPages(pages, { maxChars = config.documents.chunkMaxChars, overlapChars = config.documents.chunkOverlapChars } = {}) {
  const chunks = [];
  let chunkIndex = 0;

  for (const page of pages) {
    // Structure-aware: chunk inside each detected section so a chunk never straddles two headings,
    // and every chunk remembers its section title for evidence ("Section 2.1 Revenue Review, page 4").
    for (const block of splitBySection(page.text)) {
      for (const text of chunkText(block.text, { maxChars, overlapChars })) {
        if (!text.trim()) continue;
        chunks.push({
          chunkIndex: chunkIndex++,
          pageNumber: page.pageNumber,
          section: block.section,
          text: text.trim(),
        });
      }
    }
  }
  return chunks;
}

function chunkText(text, { maxChars, overlapChars }) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\s*\n/);

  let current = '';
  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length <= maxChars) {
      current = current ? current + '\n\n' + para : para;
      continue;
    }

    if (current) chunks.push(current);

    if (para.length > maxChars) {
      // Paragraph itself is too long - hard-split with overlap.
      let start = 0;
      while (start < para.length) {
        const end = Math.min(start + maxChars, para.length);
        chunks.push(para.slice(start, end));
        start = end - overlapChars;
        if (start <= 0 || end === para.length) break;
      }
      current = '';
    } else {
      current = para;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

module.exports = { chunkPages, chunkText };
