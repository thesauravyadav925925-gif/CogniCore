const L = require('./semantic.lexicon');
const { parseDateLoose } = require('../utils/dates');
const { isNumericType, isDateType } = require('../utils/sqlident');

/**
 * Pure classifier: turns measured facts about one column into a semantic role.
 * Inputs are facts only (name, sql type, distinct/non-null counts, min/max and a
 * value sample) so it can be unit-tested without a database.
 *
 * Roles: identifier | reference | temporal | boolean | percentage | monetary |
 *        measure | count | categorical | free_text | unknown
 */
function classifyColumn({ name, sqlType = '', primaryKey = false, totalRows = 0, nonNull = 0, distinct = 0, min = null, max = null, samples = [] }) {
  const lname = String(name).toLowerCase();
  const numeric = isNumericType(sqlType);
  const uniqRatio = nonNull > 0 ? distinct / nonNull : 0;
  const strSamples = samples.map((s) => (s === null || s === undefined ? '' : String(s))).filter(Boolean);

  const pii = detectPii(lname, strSamples);

  // Temporal
  if (isDateType(sqlType)) return finish('temporal', { pii });
  if (!numeric && strSamples.length >= 3) {
    const parsed = strSamples.map((s) => parseDateLoose(s));
    const ok = parsed.filter(Boolean);
    if (ok.length / strSamples.length >= 0.9) {
      const formats = {};
      ok.forEach((p) => { formats[p.format] = (formats[p.format] || 0) + 1; });
      const dateFormat = Object.entries(formats).sort((a, b) => b[1] - a[1])[0][0];
      return finish('temporal', { dateFormat, pii });
    }
  }
  if (numeric && L.DATE_NAME.test(lname) && min !== null && Number.isFinite(Number(min)) && Number(min) >= 1900 && Number(max) <= 2200 && /year/.test(lname)) {
    return finish('temporal', { dateFormat: 'YYYY', pii });
  }

  // Identifier / reference
  if (primaryKey) return finish('identifier', { pii });
  if (L.ID_NAME.test(lname)) {
    return finish(uniqRatio >= 0.9 ? 'identifier' : 'reference', { pii });
  }
  if (numeric && nonNull > 20 && uniqRatio === 1 && Number.isInteger(Number(min)) && /^(id|index|idx|row|sr|s_no|serial)/.test(lname)) {
    return finish('identifier', { pii });
  }

  // Boolean
  if (distinct > 0 && distinct <= 2 && strSamples.length) {
    const vals = new Set(strSamples.map((s) => s.toLowerCase()));
    const allBool = [...vals].every((v) => L.BOOL_TRUE.has(v) || L.BOOL_FALSE.has(v));
    if (allBool) return finish('boolean', { pii });
  }

  if (numeric) {
    if (L.PERCENT.test(lname)) return finish('percentage', { pii });
    if (L.MONEY.test(lname) && !L.COUNTISH.test(lname)) return finish('monetary', { pii });
    if (L.COUNTISH.test(lname)) return finish('count', { pii });
    // Low-cardinality integer codes behave like categories (e.g. rating 1..5)
    if (distinct > 0 && distinct <= 6 && nonNull >= distinct * 5 && Number.isInteger(Number(min)) && Number.isInteger(Number(max))) {
      return finish('categorical', { pii, note: 'low-cardinality numeric' });
    }
    return finish('measure', { pii });
  }

  // Text
  const avgLen = strSamples.length ? strSamples.reduce((s, v) => s + v.length, 0) / strSamples.length : 0;
  if (pii.kind === 'email' || pii.kind === 'phone') return finish('free_text', { pii });
  if (avgLen > 60) return finish('free_text', { pii });
  const catLimit = Math.max(20, Math.floor(totalRows * 0.05));
  if (distinct > 0 && (distinct <= catLimit || uniqRatio < 0.5)) return finish('categorical', { pii });
  if (L.NAME_LIKE.test(lname)) return finish('free_text', { pii });
  return finish(uniqRatio > 0.9 ? 'free_text' : 'categorical', { pii });

  function finish(role, extra) {
    return { role, ...extra, pii: extra.pii && extra.pii.kind ? extra.pii.kind : null };
  }
}

function detectPii(lname, strSamples) {
  for (const [kind, re] of Object.entries(L.PII_NAME)) if (re.test(lname)) return { kind };
  if (strSamples.length >= 3) {
    for (const p of L.PII_PATTERNS) {
      const hits = strSamples.filter((s) => p.re.test(s)).length;
      if (hits / strSamples.length >= 0.8) return { kind: p.kind };
    }
  }
  return {};
}

const ROLE_TEXT = {
  identifier: 'unique identifier',
  reference: 'reference to another entity (foreign-key-like)',
  temporal: 'date/time',
  boolean: 'yes/no flag',
  percentage: 'percentage or rate',
  monetary: 'monetary value',
  measure: 'numeric measure',
  count: 'count/quantity',
  categorical: 'category / label',
  free_text: 'free text',
  unknown: 'unclassified',
};

function describeColumn(col) {
  const parts = [`${col.name}: ${ROLE_TEXT[col.role] || col.role}`];
  if (col.role === 'temporal' && col.stats?.min) parts.push(`range ${col.stats.min} to ${col.stats.max}`);
  if (['measure', 'monetary', 'count', 'percentage'].includes(col.role) && col.stats?.min !== null && col.stats?.min !== undefined) {
    parts.push(`range ${fmt(col.stats.min)}–${fmt(col.stats.max)}${col.stats.avg !== null && col.stats.avg !== undefined ? `, avg ${fmt(col.stats.avg)}` : ''}`);
  }
  if (col.role === 'categorical' && col.values?.length) {
    parts.push(`possible values: ${col.values.slice(0, 12).map((v) => v.value).join(' | ')}${col.values.length > 12 ? ' …' : ''}`);
  }
  return parts.join('; ');
}
const fmt = (n) => (Number.isFinite(Number(n)) ? +Number(n).toFixed(2) : n);

module.exports = { classifyColumn, describeColumn, ROLE_TEXT };
