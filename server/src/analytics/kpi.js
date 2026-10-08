/**
 * KPI GENERATION (Feature 13) - driven by the semantic model, never by domain.
 * For each table it derives KPIs from column roles:
 *   - record count, distinct entities
 *   - for each measure/monetary/count column: total, average, min, max
 *   - for each boolean/low-cardinality status column: share of each value
 *     ("completion rate" style rates emerge from categorical values, not hardcoding)
 *   - for a temporal + measure pair: latest-period value and growth vs previous period
 *   - data completeness
 * Every KPI carries the SQL that produced it (Rule #6 traceability).
 */
const { quoteIdent, dialectOf, toNum } = require('../utils/sqlident');
const { periodExpr } = require('../structured/sql.patterns');
const S = require('./stats');

const pretty = (c) => String(c).replace(/_/g, ' ');
const MAX_PER_TABLE = 24;

async function generateKpis({ adapter, semantic, datasetType, tableFilter = null }) {
  const dialect = dialectOf(datasetType);
  const out = [];
  for (const table of semantic.tables) {
    if (tableFilter && table.name !== tableFilter) continue;
    const tq = quoteIdent(table.name, dialect);
    const kpis = [];
    const push = async (kpi) => {
      try {
        const rows = (await adapter.executeQuery(kpi.sql)).rows;
        kpi.raw = rows;
        kpis.push(kpi);
      } catch (_) { /* skip a KPI that the dialect can't run */ }
    };

    await push({ id: `${table.name}:count`, label: `Total ${pretty(table.name)} records`, kind: 'count', sql: `SELECT COUNT(*) AS value FROM ${tq}`, pick: (r) => toNum(r[0].value), format: 'integer' });

    const idCol = table.columns.find((c) => c.role === 'identifier');
    if (idCol) await push({ id: `${table.name}:unique:${idCol.name}`, label: `Unique ${pretty(idCol.name)}`, kind: 'distinct', sql: `SELECT COUNT(DISTINCT ${quoteIdent(idCol.name, dialect)}) AS value FROM ${tq}`, pick: (r) => toNum(r[0].value), format: 'integer' });

    const measures = table.columns.filter((c) => ['monetary', 'measure', 'count', 'percentage'].includes(c.role)).slice(0, 4);
    for (const m of measures) {
      const cq = quoteIdent(m.name, dialect);
      const isPct = m.role === 'percentage';
      const aggs = isPct ? [['AVG', 'Average']] : [['SUM', 'Total'], ['AVG', 'Average']];
      for (const [fn, prefix] of aggs) {
        await push({ id: `${table.name}:${fn.toLowerCase()}:${m.name}`, label: `${prefix} ${pretty(m.name)}`, kind: fn.toLowerCase(), column: m.name, role: m.role,
          sql: `SELECT ${fn}(${cq}) AS value FROM ${tq}`, pick: (r) => toNum(r[0].value), format: m.role === 'monetary' ? 'currency' : (isPct ? 'percent' : 'number') });
      }
    }

    // rates from status-like columns
    const statusCols = table.columns.filter((c) => (c.role === 'categorical' || c.role === 'boolean') && c.stats.distinct >= 2 && c.stats.distinct <= 8 && c.values?.length)
      .sort((a, b) => a.stats.distinct - b.stats.distinct).slice(0, 3);
    for (const c of statusCols) {
      const cq = quoteIdent(c.name, dialect);
      for (const v of c.values.slice(0, 4)) {
        const lit = String(v.value).replace(/'/g, "''");
        await push({ id: `${table.name}:rate:${c.name}:${v.value}`, label: `${pretty(c.name)} = ${v.value} rate`, kind: 'rate', column: c.name, categoryValue: v.value,
          sql: `SELECT 100.0 * SUM(CASE WHEN ${cq} = '${lit}' THEN 1 ELSE 0 END) / COUNT(*) AS value FROM ${tq}`, pick: (r) => toNum(r[0].value), format: 'percent' });
      }
    }

    // growth: latest period vs previous
    const dateCol = table.columns.find((c) => c.role === 'temporal');
    const growthMeasure = measures.find((m) => m.role === 'monetary') || measures[0];
    if (dateCol && growthMeasure) {
      const pe = periodExpr(dialect, quoteIdent(dateCol.name, dialect), 'month');
      await push({ id: `${table.name}:growth:${growthMeasure.name}`, label: `${pretty(growthMeasure.name)} growth (latest month vs previous)`, kind: 'growth', column: growthMeasure.name,
        sql: `SELECT ${pe} AS period, SUM(${quoteIdent(growthMeasure.name, dialect)}) AS total FROM ${tq} WHERE ${quoteIdent(dateCol.name, dialect)} IS NOT NULL GROUP BY ${pe} ORDER BY period DESC LIMIT 2`,
        pick: (r) => (r.length >= 2 ? S.round(S.pctChange(toNum(r[1].total), toNum(r[0].total)), 2) : null), format: 'percent_change', detail: (r) => (r.length >= 2 ? { latest: r[0].period, previous: r[1].period } : null) });
    }

    // completeness
    const totalCells = table.rowCount * table.columns.length;
    const missing = table.columns.reduce((s, c) => s + (c.stats.missing || 0), 0);
    if (totalCells > 0) kpis.push({ id: `${table.name}:completeness`, label: 'Data completeness', kind: 'quality', sql: null, raw: [], value: S.round(100 - (missing / totalCells) * 100, 2), format: 'percent' });

    out.push({ table: table.name, kpis: kpis.slice(0, MAX_PER_TABLE).map(finalize) });
  }
  return out;
}

function finalize(k) {
  const value = k.value !== undefined ? k.value : (k.pick ? k.pick(k.raw) : null);
  const detail = k.detail ? k.detail(k.raw) : undefined;
  return { id: k.id, label: k.label, kind: k.kind, format: k.format, value: Number.isFinite(value) ? +Number(value).toFixed(2) : null, sql: k.sql, ...(detail ? { detail } : {}) };
}

module.exports = { generateKpis };
