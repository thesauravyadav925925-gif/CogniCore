const { quoteIdent, dialectOf, isSqliteBacked, isNumericType, toNum } = require('../utils/sqlident');
const { parseDateLoose } = require('../utils/dates');
const stats = require('../analytics/stats');

const PLACEHOLDERS = ['n/a', 'na', 'null', 'none', 'nil', '-', '--', 'unknown', 'undefined', '?', 'missing', 'not available'];
const MAX_SCAN = 20000;

/**
 * DATA QUALITY ANALYZER (Feature 15)
 * Domain-agnostic checks driven only by the semantic model + measured facts:
 *   missing values, placeholder values, duplicate rows, duplicate IDs, invalid /
 *   mixed-format dates, numbers stored as text, inconsistent categories,
 *   impossible values (negatives, out-of-range percentages) and numeric outliers.
 * Every issue carries a plain-English message, e.g.
 *   "There are 14 missing values in the salary column."
 */
async function analyzeDataQuality({ adapter, schema, semantic, datasetType, relationships = [] }) {
  const dialect = dialectOf(datasetType);
  const sqliteBacked = isSqliteBacked(datasetType);
  const out = { tables: [], generatedAt: new Date().toISOString() };

  for (const table of schema.tables) {
    const sem = semantic?.tables?.find((t) => t.name === table.name);
    const tq = quoteIdent(table.name, dialect);
    const issues = [];
    const total = sem?.rowCount ?? table.rowCount ?? 0;

    // ---- per-column checks ----
    for (const col of table.columns) {
      const scol = sem?.columns.find((c) => c.name === col.name);
      const cq = quoteIdent(col.name, dialect);
      const role = scol?.role || 'unknown';
      const missing = scol?.stats?.missing ?? 0;

      if (missing > 0) {
        issues.push(issue('missing_values', missing / Math.max(total, 1) > 0.2 ? 'high' : 'medium', col.name, missing,
          `There ${missing === 1 ? 'is 1 missing value' : `are ${missing} missing values`} in the ${col.name} column (${pct(missing, total)}).`));
      }

      const textual = !isNumericType(col.type);
      if (textual) {
        // blank / placeholder strings
        try {
          const list = PLACEHOLDERS.map((p) => `'${p}'`).join(',');
          const r = (await adapter.executeQuery(`SELECT COUNT(*) AS n FROM ${tq} WHERE LOWER(TRIM(${cq})) IN ('', ${list})`)).rows[0];
          const n = toNum(r?.n) ?? 0;
          if (n > 0) issues.push(issue('placeholder_values', 'medium', col.name, n, `${n} value${n === 1 ? '' : 's'} in ${col.name} are blank or placeholders such as "N/A" or "unknown".`));
        } catch (_) { /* dialect quirk - skip */ }
      }

      // duplicate identifiers
      if (role === 'identifier' && scol.stats.nonNull > scol.stats.distinct) {
        const dupes = scol.stats.nonNull - scol.stats.distinct;
        issues.push(issue('duplicate_ids', 'high', col.name, dupes, `The identifier column ${col.name} contains ${dupes} duplicate value${dupes === 1 ? '' : 's'}.`));
      }

      // dates
      if (role === 'temporal' && textual) {
        const vals = await distinctValues(adapter, tq, cq, MAX_SCAN);
        let bad = [];
        const formats = new Set();
        for (const v of vals) {
          const p = parseDateLoose(v);
          if (!p) bad.push(v); else formats.add(p.format);
        }
        if (bad.length) issues.push(issue('invalid_dates', 'high', col.name, bad.length, `${bad.length} value${bad.length === 1 ? '' : 's'} in ${col.name} are not valid dates.`, bad.slice(0, 5)));
        if (formats.size > 1) issues.push(issue('mixed_date_formats', 'medium', col.name, formats.size, `${col.name} mixes ${formats.size} date formats (${[...formats].join(', ')}).`));
      }

      // numbers stored as text / mixed types
      if (textual && !['temporal', 'identifier', 'reference'].includes(role) && role !== 'unknown') {
        const vals = await distinctValues(adapter, tq, cq, 2000);
        if (vals.length >= 5) {
          const numericLike = vals.filter((v) => v !== null && v !== '' && Number.isFinite(Number(String(v).replace(/[, ]/g, ''))));
          const ratio = numericLike.length / vals.length;
          if (ratio >= 0.9 && ratio < 1) {
            const bad = vals.filter((v) => !numericLike.includes(v));
            issues.push(issue('mixed_types', 'medium', col.name, bad.length, `${col.name} looks numeric but ${bad.length} value${bad.length === 1 ? '' : 's'} are not numbers.`, bad.slice(0, 5)));
          } else if (ratio === 1 && role !== 'boolean' && scol?.stats.distinct > 2) {
            issues.push(issue('numbers_as_text', 'low', col.name, vals.length, `${col.name} holds only numbers but is stored as text, which can break sorting and math.`));
          }
        }
      }

      // inconsistent categories
      if (role === 'categorical' && textual) {
        const groupExpr = sqliteBacked ? `${cq} COLLATE BINARY` : cq;
        try {
          const rows = (await adapter.executeQuery(`SELECT ${groupExpr} AS v, COUNT(*) AS n FROM ${tq} WHERE ${cq} IS NOT NULL GROUP BY ${groupExpr} LIMIT 500`)).rows;
          const groups = new Map();
          for (const r of rows) {
            const key = normalizeCategory(r.v);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ value: r.v, count: toNum(r.n) ?? 0 });
          }
          const inconsistent = [...groups.values()].filter((g) => g.length > 1);
          if (inconsistent.length) {
            const example = inconsistent[0].map((g) => `"${g.value}"`).join(' / ');
            issues.push(issue('inconsistent_categories', 'medium', col.name, inconsistent.length,
              `${col.name} spells ${inconsistent.length} categor${inconsistent.length === 1 ? 'y' : 'ies'} inconsistently (e.g. ${example}).`, inconsistent.slice(0, 3)));
          }
        } catch (_) { /* skip */ }
      }

      // numeric value checks
      if (['measure', 'monetary', 'count', 'percentage'].includes(role) && scol.stats.nonNull >= 8) {
        const values = (await columnNumbers(adapter, tq, cq)).filter(Number.isFinite);
        if (values.length >= 8) {
          const negatives = values.filter((v) => v < 0).length;
          if (negatives > 0 && negatives / values.length < 0.05 && ['monetary', 'count'].includes(role)) {
            issues.push(issue('impossible_values', 'high', col.name, negatives, `${negatives} negative value${negatives === 1 ? '' : 's'} in ${col.name}, which is normally non-negative.`));
          }
          if (role === 'percentage') {
            const out = values.filter((v) => v < 0 || v > 100).length;
            const looksFraction = Math.max(...values) <= 1.0001;
            if (!looksFraction && out > 0) issues.push(issue('impossible_values', 'high', col.name, out, `${out} value${out === 1 ? '' : 's'} in ${col.name} fall outside 0–100%.`));
          }
          const b = stats.iqrBounds(values, 3);
          if (b.iqr > 0) {
            const outliers = values.filter((v) => v < b.lower || v > b.upper).length;
            if (outliers > 0) issues.push(issue('outliers', 'low', col.name, outliers, `${outliers} extreme outlier${outliers === 1 ? '' : 's'} in ${col.name} (outside ${stats.round(b.lower)} to ${stats.round(b.upper)}).`));
          }
        }
      }
    }

    // ---- duplicate rows ----
    if (table.columns.length && table.columns.length <= 60 && total > 1) {
      try {
        const cols = table.columns.map((c) => quoteIdent(c.name, dialect)).join(', ');
        const r = (await adapter.executeQuery(`SELECT COALESCE(SUM(c - 1), 0) AS extra, COUNT(*) AS grp FROM (SELECT COUNT(*) AS c FROM ${tq} GROUP BY ${cols} HAVING COUNT(*) > 1) AS d`)).rows[0];
        const extra = toNum(r?.extra) ?? 0;
        if (extra > 0) issues.push(issue('duplicate_rows', 'high', null, extra, `${extra} row${extra === 1 ? ' is an exact duplicate' : 's are exact duplicates'} of another row in ${table.name}.`));
      } catch (_) { /* skip */ }
    }

    // ---- referential integrity: child rows whose key has no parent ----
    for (const rel of relationships.filter((r) => r.fromTable === table.name)) {
      try {
        const parentQ = quoteIdent(rel.toTable, dialect), childCol = quoteIdent(rel.fromColumn, dialect), parentCol = quoteIdent(rel.toColumn, dialect);
        const r = (await adapter.executeQuery(`SELECT COUNT(*) AS n FROM ${tq} c WHERE c.${childCol} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${parentQ} p WHERE p.${parentCol} = c.${childCol})`)).rows[0];
        const n = toNum(r?.n) ?? 0;
        if (n > 0) issues.push(issue('referential_integrity', 'high', rel.fromColumn, n, `${n} row${n === 1 ? '' : 's'} in ${table.name} reference a ${rel.toColumn} that does not exist in ${rel.toTable} (orphaned ${rel.fromColumn}).`));
      } catch (_) { /* best effort */ }
    }

    const weights = { high: 12, medium: 5, low: 2 };
    const penalty = issues.reduce((s, i) => s + weights[i.severity], 0);
    out.tables.push({
      name: table.name, rowCount: total, score: Math.max(0, 100 - penalty), issues,
      summary: issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'} found.` : 'No data-quality issues detected.',
    });
  }

  out.overallScore = out.tables.length ? Math.round(stats.mean(out.tables.map((t) => t.score))) : 100;
  out.issueCount = out.tables.reduce((s, t) => s + t.issues.length, 0);
  return out;
}

function issue(type, severity, column, count, message, examples) {
  return { type, severity, column, count, message, ...(examples ? { examples } : {}) };
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '0%');

function normalizeCategory(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function distinctValues(adapter, tq, cq, limit) {
  try {
    return (await adapter.executeQuery(`SELECT DISTINCT ${cq} AS v FROM ${tq} WHERE ${cq} IS NOT NULL LIMIT ${limit}`)).rows.map((r) => r.v);
  } catch (_) { return []; }
}

async function columnNumbers(adapter, tq, cq) {
  try {
    return (await adapter.executeQuery(`SELECT ${cq} AS v FROM ${tq} WHERE ${cq} IS NOT NULL LIMIT ${MAX_SCAN}`)).rows.map((r) => toNum(r.v));
  } catch (_) { return []; }
}

module.exports = { analyzeDataQuality, normalizeCategory, PLACEHOLDERS };
