/**
 * ANSWER GROUNDING (Features 19 & 35: hallucination + contradiction guardrails)
 * The LLM only *explains* validated evidence. This module verifies that it did:
 *   - every specific number in the answer must be traceable to the evidence
 *   - the answer must not claim the data is missing/undeterminable when rows exist
 * If a check fails, the caller falls back to a deterministic answer built
 * directly from the rows (Rule #6, #20, #25).
 */
const NUM_RE = /-?\d[\d,]*(?:\.\d+)?/g;

function evidenceNumbers(evidence) {
  const set = new Set();
  const add = (v) => {
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
    if (!Number.isFinite(n)) return;
    set.add(+n.toFixed(4));
    [0, 1, 2].forEach((d) => set.add(+n.toFixed(d)));
    set.add(Math.round(n));
    if (Math.abs(n) <= 1) set.add(+(n * 100).toFixed(2)); // fraction shown as percent
  };
  const walk = (ev) => {
    if (!ev) return;
    if (ev.source_type === 'hybrid') { ev.parts.forEach(walk); return; }
    if (ev.source_type === 'analysis') { ev.steps.forEach((s) => walk(s.evidence)); return; }
    if (ev.source_type === 'database') {
      add(ev.row_count);
      (ev.sample_rows || []).forEach((r) => Object.values(r).forEach((v) => { if (v !== null && v !== '') add(v); if (typeof v === 'string') (v.match(NUM_RE) || []).forEach(add); }));
      // totals across numeric columns are legitimate derived numbers
      for (const c of ev.columns || []) {
        const vals = (ev.sample_rows || []).map((r) => Number(r[c])).filter(Number.isFinite);
        if (vals.length > 1 && vals.length === (ev.sample_rows || []).length) add(vals.reduce((a, b) => a + b, 0));
      }
    }
    if (ev.source_type === 'document') (ev.chunks || []).forEach((c) => (String(c.text).match(NUM_RE) || []).forEach(add));
    (ev.insights || []).forEach((i) => (String(i.text).match(NUM_RE) || []).forEach(add));
  };
  walk(evidence);
  return set;
}

function checkNumericGrounding(answer, evidence, question = '') {
  const allowed = evidenceNumbers(evidence);
  const fromQuestion = new Set((String(question).match(NUM_RE) || []).map((s) => Number(s.replace(/,/g, ''))));
  const ungrounded = [];
  for (const m of String(answer).match(NUM_RE) || []) {
    const n = Number(m.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    if (Number.isInteger(n) && Math.abs(n) <= 12) continue;          // ordinals / small counts in prose
    if (fromQuestion.has(n)) continue;
    if (Number.isInteger(n) && n >= 1900 && n <= 2100) continue;       // years
    const close = [...allowed].some((a) => Math.abs(a - n) <= Math.max(0.011, Math.abs(a) * 0.0005));
    if (!close) ungrounded.push(m);
  }
  return { grounded: ungrounded.length === 0, ungrounded };
}

const INSUFFICIENT = /(cannot|can't|can not|unable to|not possible to|impossible to)\s+(be\s+)?(determin|answer|provid|find|identif)|no\s+(data|information|evidence|records?)\s+(is\s+|was\s+|were\s+)?(available|found|provided|present)|not\s+(specified|provided|present|available)\s+in\s+the\s+(evidence|data)/i;

function hasEvidenceRows(evidence) {
  if (!evidence) return false;
  if (evidence.source_type === 'database') return evidence.row_count > 0;
  if (evidence.source_type === 'hybrid') return evidence.parts.some(hasEvidenceRows);
  if (evidence.source_type === 'analysis') return evidence.steps.some((s) => s.evidence && hasEvidenceRows(s.evidence));
  if (evidence.source_type === 'document') return (evidence.chunks || []).length > 0;
  return false;
}

/** True when the answer says the data can't answer although the evidence has rows. */
function detectContradiction(answer, evidence) {
  return INSUFFICIENT.test(String(answer)) && hasEvidenceRows(evidence);
}

const fmtVal = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : +v.toFixed(2)) : String(v));

/** Deterministic, LLM-free answer built directly from database evidence. */
function buildDeterministicAnswer(evidence) {
  if (!evidence) return null;
  if (evidence.source_type !== 'database') return null;
  const { columns = [], sample_rows: rows = [], row_count: n } = evidence;
  if (!rows.length) return 'No matching records were found.';
  if (rows.length === 1 && columns.length === 1) return `${prettify(columns[0])}: ${fmtVal(rows[0][columns[0]])}.`;
  if (rows.length === 1) return columns.map((c) => `${prettify(c)}: ${fmtVal(rows[0][c])}`).join('; ') + '.';
  const shown = rows.slice(0, 5).map((r, i) => `${i + 1}. ${columns.map((c) => `${fmtVal(r[c])}`).join(' — ')}`);
  return `${n} result${n === 1 ? '' : 's'} (columns: ${columns.map(prettify).join(', ')}). ${n > 5 ? 'First 5' : 'Results'}:\n${shown.join('\n')}`;
}

const prettify = (c) => String(c).replace(/_/g, ' ');

module.exports = { checkNumericGrounding, detectContradiction, buildDeterministicAnswer, evidenceNumbers, hasEvidenceRows };
