/**
 * SENSITIVE-INFORMATION EXPOSURE CONTROL (Feature 35)
 * Columns the semantic layer flagged as personal data (email, phone, national id,
 * card number) are masked in results shown to low-privilege roles, and the same
 * patterns are scrubbed from free text. Masking is applied to what leaves the API,
 * not to what is stored.
 */
const MASK_ROLES = new Set((process.env.PII_MASK_ROLES || 'viewer,employee').split(',').map((s) => s.trim()).filter(Boolean));

const PATTERNS = [
  { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, mask: (m) => m.replace(/^(.).*(@.*)$/, '$1***$2') },
  { re: /\b(?:\d[ -]?){13,19}\b/g, mask: (m) => `**** **** **** ${m.replace(/\D/g, '').slice(-4)}` },
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, mask: () => '***-**-****' },
  { re: /\b\d{4}\s\d{4}\s\d{4}\b/g, mask: (m) => `**** **** ${m.slice(-4)}` },
  { re: /(?<!\d)\+?\d[\d\s\-().]{8,16}\d(?!\d)/g, mask: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 9 && d.length <= 15 ? `${'*'.repeat(d.length - 3)}${d.slice(-3)}` : m; } },
];

const shouldMask = (role) => MASK_ROLES.has(role);

function maskText(text) {
  let s = String(text ?? '');
  for (const p of PATTERNS) s = s.replace(p.re, p.mask);
  return s;
}

function piiColumnSet(semantic) {
  const set = new Set();
  for (const t of semantic?.tables || []) for (const c of t.columns) if (c.pii) set.add(c.name.toLowerCase());
  return set;
}

function redactEvidence(evidence, semantic, role) {
  if (!evidence || !shouldMask(role)) return { evidence, redacted: 0 };
  let redacted = 0;
  const pii = piiColumnSet(semantic);
  const walk = (ev) => {
    if (!ev) return ev;
    if (ev.source_type === 'hybrid') return { ...ev, parts: ev.parts.map(walk) };
    if (ev.source_type === 'analysis') return { ...ev, steps: ev.steps.map((s) => ({ ...s, evidence: walk(s.evidence) })) };
    if (ev.source_type === 'database') {
      const rows = (ev.sample_rows || []).map((r) => {
        const o = { ...r };
        for (const [k, v] of Object.entries(o)) {
          if (v === null || v === undefined) continue;
          if (pii.has(k.toLowerCase())) { o[k] = maskText(String(v)) === String(v) ? '***' : maskText(String(v)); redacted++; }
          else if (typeof v === 'string') { const m = maskText(v); if (m !== v) { o[k] = m; redacted++; } }
        }
        return o;
      });
      return { ...ev, sample_rows: rows };
    }
    if (ev.source_type === 'document') return { ...ev, chunks: (ev.chunks || []).map((c) => ({ ...c, text: maskText(c.text) })) };
    return ev;
  };
  return { evidence: walk(evidence), redacted };
}

module.exports = { maskText, redactEvidence, shouldMask, piiColumnSet };
