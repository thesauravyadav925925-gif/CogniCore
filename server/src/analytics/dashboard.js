/**
 * AUTO DASHBOARD (blueprint #20, #24: Dashboards, filters, drill-down)
 * Builds panel definitions (title + SQL + chart question) from the semantic model. The frontend
 * renders each panel through the chart endpoint (which validates the SQL and applies the user's
 * data policies), so a dashboard can never show data its viewer may not see.
 * `filters` ({column: value}) are applied to every panel whose table has that column - this is the
 * filter / drill-down mechanism (click a category value to drill into it).
 */
const { quoteIdent, dialectOf } = require('../utils/sqlident');
const { periodExpr } = require('../structured/sql.patterns');
const { isColumnDenied } = require('../agent/safe.query');
const { focusOf } = require('../agent/orchestrator');

const pretty = (c) => String(c).replace(/_/g, ' ');
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

function buildDashboard({ dataset, policy = null, filters = {} }) {
  const semantic = dataset.profile?.semantic;
  if (!semantic) return null;
  const dialect = dialectOf(dataset.type);
  const q = (n) => quoteIdent(n, dialect);
  const panels = [];

  const filterOptions = [];
  for (const t of semantic.tables) for (const c of t.columns) {
    if (c.role === 'categorical' && c.values?.length && c.stats.distinct <= 12 && !isColumnDenied(policy, t.name, c.name) && !filterOptions.some((f) => f.column === c.name)) {
      filterOptions.push({ column: c.name, table: t.name, values: c.values.map((v) => String(v.value)) });
    }
  }

  for (const table of semantic.tables.slice(0, 2)) {
    const f = focusOf(semantic, table, policy);
    const where = Object.entries(filters).filter(([col]) => table.columns.some((c) => c.name === col)).map(([col, v]) => `${q(col)} = ${lit(v)}`);
    const W = (extra = []) => { const all = [...where, ...extra]; return all.length ? ` WHERE ${all.join(' AND ')}` : ''; };
    const tq = q(table.name);
    const add = (id, title, question, sql) => panels.push({ id: `${table.name}:${id}`, table: table.name, title, question, sql });

    if (f.measure && f.date) {
      const pe = periodExpr(dialect, q(f.date.name), 'month');
      add('trend', `${pretty(f.measure.name)} by month`, `monthly ${f.measure.name} over time`, `SELECT ${pe} AS month, SUM(${q(f.measure.name)}) AS total FROM ${tq}${W([`${q(f.date.name)} IS NOT NULL`])} GROUP BY ${pe} ORDER BY month`);
    } else if (f.date) {
      const pe = periodExpr(dialect, q(f.date.name), 'month');
      add('trend', `Records by month`, 'monthly records over time', `SELECT ${pe} AS month, COUNT(*) AS records FROM ${tq}${W([`${q(f.date.name)} IS NOT NULL`])} GROUP BY ${pe} ORDER BY month`);
    }
    if (f.category && f.measure) {
      add('by_category', `${pretty(f.measure.name)} by ${pretty(f.category.name)}`, `${f.measure.name} by ${f.category.name}`, `SELECT ${q(f.category.name)} AS ${q(f.category.name)}, SUM(${q(f.measure.name)}) AS total FROM ${tq}${W([`${q(f.category.name)} IS NOT NULL`])} GROUP BY ${q(f.category.name)} ORDER BY total DESC LIMIT 15`);
    }
    const status = table.columns.filter((c) => c.role === 'categorical' && c.stats.distinct >= 2 && c.stats.distinct <= 6 && !isColumnDenied(policy, table.name, c.name)).sort((a, b) => a.stats.distinct - b.stats.distinct)[0];
    if (status) add('composition', `Share of records by ${pretty(status.name)}`, `distribution breakdown of records by ${status.name}`, `SELECT ${q(status.name)} AS ${q(status.name)}, COUNT(*) AS records FROM ${tq}${W([`${q(status.name)} IS NOT NULL`])} GROUP BY ${q(status.name)}`);
    if (f.measure) add('distribution', `Distribution of ${pretty(f.measure.name)}`, `distribution of ${f.measure.name}`, `SELECT ${q(f.measure.name)} AS ${q(f.measure.name)} FROM ${tq}${W([`${q(f.measure.name)} IS NOT NULL`])} LIMIT 5000`);
    if (f.measure && f.secondMeasure) add('relationship', `${pretty(f.secondMeasure.name)} vs ${pretty(f.measure.name)}`, `${f.measure.name} vs ${f.secondMeasure.name}`, `SELECT ${q(f.measure.name)} AS ${q(f.measure.name)}, ${q(f.secondMeasure.name)} AS ${q(f.secondMeasure.name)} FROM ${tq}${W([`${q(f.measure.name)} IS NOT NULL`, `${q(f.secondMeasure.name)} IS NOT NULL`])} LIMIT 800`);
  }
  return { dataset_id: dataset.dataset_id, name: dataset.name, filters: filterOptions.slice(0, 4), applied: filters, panels };
}

module.exports = { buildDashboard };
