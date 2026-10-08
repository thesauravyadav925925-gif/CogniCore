/**
 * SECTION / STRUCTURE DETECTION (blueprint #8)
 * Finds headings so every chunk can say which section it came from:
 *   Markdown "# Title", numbered "2.1 Revenue Review", "Chapter 3: ...", and short ALL-CAPS lines.
 */
const HEADING_RES = [
  { re: /^#{1,6}\s+(.{2,120})$/, group: 1 },
  { re: /^((?:chapter|section|part)\s+[\dIVXivx]+[.:)]?\s+.{0,100})$/i, group: 1 },
  { re: /^(\d{1,2}(?:\.\d{1,2}){0,3}[.)]?\s+[A-Z][^.!?]{2,100})$/, group: 1 },
  { re: /^([A-Z][A-Z0-9 &/,\-]{3,70})$/, group: 1 },
];

function headingOf(line) {
  const t = line.trim();
  if (!t || t.length > 130) return null;
  for (const { re, group } of HEADING_RES) {
    const m = t.match(re);
    if (m) {
      if (/[.,;]$/.test(m[group]) && !/^\d/.test(m[group])) continue;
      return m[group].replace(/^#+\s*/, '').trim();
    }
  }
  return null;
}

/** Splits text into [{section, text}] blocks; text before the first heading has section null. */
function splitBySection(text) {
  const lines = String(text).split('\n');
  const blocks = [];
  let cur = { section: null, lines: [] };
  for (const line of lines) {
    const h = headingOf(line);
    if (h) {
      if (cur.lines.join('').trim()) blocks.push({ section: cur.section, text: cur.lines.join('\n').trim() });
      cur = { section: h, lines: [line] };
    } else cur.lines.push(line);
  }
  if (cur.lines.join('').trim()) blocks.push({ section: cur.section, text: cur.lines.join('\n').trim() });
  return blocks;
}

module.exports = { splitBySection, headingOf };
