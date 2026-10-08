const { classifyColumn, describeColumn } = require('./semantic.classifier');
const { quoteIdent, dialectOf, isNumericType, toNum } = require('../utils/sqlident');
const { describeValues } = require('../analytics/descriptive');

const MAX_CAT_VALUES = 30;

/**
 * SEMANTIC BUILDER
 * Measures every column of every table with a handful of cheap aggregate queries
 * (through the dataset's own adapter, so it works identically for CSV/Excel/JSON/
 * SQLite/Postgres/MySQL) and turns those facts into a semantic model:
 *   data -> schema -> semantic model -> LLM
 * The adapter must already be connected. No domain knowledge is used.
 */
async function buildSemanticModel({ adapter, schema, datasetType, relationships = [] }) {
  const dialect = dialectOf(datasetType);
  const tables = [];

  for (const table of schema.tables) {
    const tq = quoteIdent(table.name, dialect);
    const columns = [];
    let totalRows = table.rowCount;
    if (!Number.isFinite(totalRows)) totalRows = 0;

    for (const col of table.columns) {
      const cq = quoteIdent(col.name, dialect);
      const numeric = isNumericType(col.type);
      const facts = { total: totalRows, nonNull: 0, distinct: 0, min: null, max: null, avg: null };
      try {
        const sql = `SELECT COUNT(*) AS total, COUNT(${cq}) AS non_null, COUNT(DISTINCT ${cq}) AS distinct_count, MIN(${cq}) AS min_v, MAX(${cq}) AS max_v${numeric ? `, AVG(${cq}) AS avg_v` : ''} FROM ${tq}`;
        const r = (await adapter.executeQuery(sql)).rows[0] || {};
        facts.total = toNum(r.total) ?? totalRows;
        facts.nonNull = toNum(r.non_null) ?? 0;
        facts.distinct = toNum(r.distinct_count) ?? 0;
        facts.min = r.min_v ?? null;
        facts.max = r.max_v ?? null;
        facts.avg = numeric ? toNum(r.avg_v) : null;
      } catch (_) { /* column stats are best-effort */ }

      let samples = [];
      let values = [];
      if (!numeric || facts.distinct <= 12) {
        try {
          const rows = (await adapter.executeQuery(
            `SELECT ${cq} AS v, COUNT(*) AS n FROM ${tq} WHERE ${cq} IS NOT NULL GROUP BY ${cq} ORDER BY n DESC LIMIT ${MAX_CAT_VALUES + 1}`
          )).rows;
          values = rows.map((r) => ({ value: r.v, count: toNum(r.n) ?? 0 }));
          samples = rows.map((r) => r.v);
        } catch (_) { /* ignore */ }
      }
      if (!samples.length) {
        try {
          samples = (await adapter.executeQuery(`SELECT DISTINCT ${cq} AS v FROM ${tq} WHERE ${cq} IS NOT NULL LIMIT 25`)).rows.map((r) => r.v);
        } catch (_) { /* ignore */ }
      }

      const cls = classifyColumn({
        name: col.name, sqlType: col.type, primaryKey: col.primaryKey, totalRows: facts.total,
        nonNull: facts.nonNull, distinct: facts.distinct, min: facts.min, max: facts.max, samples,
      });

      // distribution profile for numeric columns (percentiles + histogram), capped sample for speed
      let distribution = null;
      if (numeric && ['monetary', 'measure', 'count', 'percentage'].includes(cls.role) && facts.nonNull >= 5) {
        try {
          const vals = (await adapter.executeQuery(`SELECT ${cq} AS v FROM ${tq} WHERE ${cq} IS NOT NULL LIMIT 20000`)).rows.map((r) => toNum(r.v));
          const d = describeValues(vals);
          if (d) distribution = { sampled: vals.length < facts.nonNull ? vals.length : null, p25: d.p25, median: d.median, p75: d.p75, p90: d.p90, std: d.std, skew: d.skew, shape: d.shape, histogram: d.histogram };
        } catch (_) { /* best effort */ }
      }

      const keepValues = cls.role === 'categorical' || cls.role === 'boolean';
      const entry = {
        name: col.name,
        sqlType: col.type,
        role: cls.role,
        dateFormat: cls.dateFormat || null,
        pii: cls.pii || null,
        stats: {
          total: facts.total, nonNull: facts.nonNull, missing: Math.max(0, facts.total - facts.nonNull),
          distinct: facts.distinct, min: facts.min, max: facts.max, avg: facts.avg,
          ...(distribution ? { distribution } : {}),
        },
        values: keepValues && facts.distinct <= MAX_CAT_VALUES ? values.slice(0, MAX_CAT_VALUES) : [],
        samples: samples.slice(0, 5),
      };
      entry.description = describeColumn(entry);
      columns.push(entry);
    }

    tables.push({ name: table.name, rowCount: totalRows, columns });
  }

  return { tables, relationships, generatedAt: new Date().toISOString(), version: 1 };
}

/** Compact prompt text for the SQL generator: per-column role + values. */
function renderSemanticPrompt(model, { maxTables = 12 } = {}) {
  if (!model?.tables) return '';
  return model.tables.slice(0, maxTables).map((t) => {
    const lines = t.columns.map((c) => `  - ${c.description}${c.stats.missing ? ` (${c.stats.missing} missing)` : ''}`);
    return `Table "${t.name}" (${t.rowCount} rows):\n${lines.join('\n')}`;
  }).join('\n');
}

/** Convenience lookups used by analytics / KPI / viz modules. */
function columnsByRole(table, ...roles) {
  return table.columns.filter((c) => roles.includes(c.role));
}

function findColumn(model, tableName, columnName) {
  const t = model?.tables?.find((x) => x.name.toLowerCase() === String(tableName).toLowerCase());
  return t?.columns.find((c) => c.name.toLowerCase() === String(columnName).toLowerCase()) || null;
}

module.exports = { buildSemanticModel, renderSemanticPrompt, columnsByRole, findColumn };
