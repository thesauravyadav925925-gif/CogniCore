/**
 * Data-quality warnings attached to an answer (blueprint item 16):
 * "⚠ Attendance dataset contains 17 duplicate records and 4 invalid statuses".
 * Only issues that touch the tables/columns the answer actually used are surfaced,
 * so users are warned when conclusions may be affected - not spammed with everything.
 */
const RELEVANT = new Set(['missing_values', 'placeholder_values', 'invalid_dates', 'mixed_date_formats', 'inconsistent_categories', 'mixed_types', 'numbers_as_text', 'impossible_values', 'outliers', 'duplicate_ids']);

function qualityWarningsFor({ quality, columnRefs = [], tables = [] }) {
  if (!quality) return [];
  const cols = new Set(columnRefs.map((r) => r.toLowerCase()));
  const tbls = new Set(tables.map((t) => t.toLowerCase()));
  const out = [];
  for (const t of quality.tables) {
    if (tbls.size && !tbls.has(t.name.toLowerCase())) continue;
    for (const i of t.issues) {
      const touches = i.column ? cols.has(`${t.name}.${i.column}`.toLowerCase()) : (i.type === 'duplicate_rows' || i.type === 'referential_integrity');
      if (!touches) continue;
      if (i.column && !RELEVANT.has(i.type)) continue;
      out.push({ table: t.name, column: i.column || null, type: i.type, severity: i.severity, message: i.message });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 5);
}

module.exports = { qualityWarningsFor };
