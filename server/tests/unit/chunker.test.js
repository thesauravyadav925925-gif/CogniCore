require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkPages, chunkText } = require('../../src/documents/chunker');

test('chunker: short text produces a single chunk', () => {
  const chunks = chunkPages([{ pageNumber: 1, text: 'Short document.' }], { maxChars: 1000, overlapChars: 100 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'Short document.');
});

test('chunker: long text is split, no chunk exceeds maxChars', () => {
  const longText = 'Sentence about topic A. '.repeat(50) + '\n\n' + 'Sentence about topic B. '.repeat(50);
  const chunks = chunkPages([{ pageNumber: 1, text: longText }], { maxChars: 300, overlapChars: 30 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.text.length <= 300, `chunk exceeded maxChars: ${c.text.length}`);
  }
});

test('chunker: preserves page numbers across multiple pages', () => {
  const pages = [
    { pageNumber: 1, text: 'Content on page one.' },
    { pageNumber: 2, text: 'Content on page two.' },
  ];
  const chunks = chunkPages(pages, { maxChars: 1000, overlapChars: 50 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].pageNumber, 1);
  assert.equal(chunks[1].pageNumber, 2);
});

test('chunker: empty/whitespace-only pages produce no chunks', () => {
  const chunks = chunkPages([{ pageNumber: 1, text: '   ' }], { maxChars: 1000, overlapChars: 50 });
  assert.equal(chunks.length, 0);
});

test('chunker: chunkIndex increases monotonically across the whole document', () => {
  const pages = [
    { pageNumber: 1, text: 'A'.repeat(500) },
    { pageNumber: 2, text: 'B'.repeat(500) },
  ];
  const chunks = chunkPages(pages, { maxChars: 200, overlapChars: 20 });
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].chunkIndex > chunks[i - 1].chunkIndex);
  }
});
