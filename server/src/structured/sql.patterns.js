/**
 * ANALYTICAL SQL PATTERNS (Features 3 & 4)
 * Question-triggered, dialect-specific recipes handed to the SQL generator so a
 * small local model reliably writes percentages, growth, running totals, moving
 * averages, rankings, contribution and period grouping. Purely generic.
 */
function periodExpr(dialect, col, grain = 'month') {
  const fmt = { year: ['%Y', 'YYYY'], month: ['%Y-%m', 'YYYY-MM'], day: ['%Y-%m-%d', 'YYYY-MM-DD'] }[grain] || ['%Y-%m', 'YYYY-MM'];
  if (dialect === 'postgres') return `to_char(${col}::date, '${fmt[1]}')`;
  if (dialect === 'mysql') return `DATE_FORMAT(${col}, '${fmt[0]}')`;
  return `strftime('${fmt[0]}', ${col})`;
}

const RULES = [
  {
    id: 'percentage', test: /(percent|percentage|proportion|share of|rate\b|ratio|out of)/i,
    text: () => `PERCENTAGES: write 100.0 * COUNT(CASE WHEN <condition> THEN 1 END) / COUNT(*) (the 100.0 avoids integer truncation). Group with GROUP BY when asked "by <category>".`,
  },
  {
    id: 'growth', test: /(growth|grew|increase|decrease|decline|compared (with|to)|versus|vs\.?|year[- ]over[- ]year|month[- ]over[- ]month|previous (year|month|period)|change)/i,
    text: (d) => `GROWTH / COMPARISON OVER TIME: aggregate by period, then compare to the previous period with LAG(): SELECT period, total, LAG(total) OVER (ORDER BY period) AS previous, 100.0 * (total - LAG(total) OVER (ORDER BY period)) / LAG(total) OVER (ORDER BY period) AS growth_pct FROM (SELECT ${periodExpr(d, '<date_column>')} AS period, SUM(<measure>) AS total FROM <table> GROUP BY 1) AS t ORDER BY period`,
  },
  {
    id: 'running', test: /(running total|cumulative|year[- ]to[- ]date|ytd|so far)/i,
    text: (d) => `RUNNING TOTAL: SUM(total) OVER (ORDER BY period ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) over a per-period aggregate, e.g. period = ${periodExpr(d, '<date_column>')}.`,
  },
  {
    id: 'moving', test: /(moving average|rolling|\d+[- ]day average|\d+[- ]month average|smoothed)/i,
    text: () => `MOVING AVERAGE: AVG(value) OVER (ORDER BY day_col ROWS BETWEEN <N-1> PRECEDING AND CURRENT ROW) over a per-day (or per-period) aggregate.`,
  },
  {
    id: 'rank', test: /(\brank\b|ranking|ranked|position|leaderboard)/i,
    text: () => `RANKING: RANK() OVER (ORDER BY <measure> DESC) AS rank over a grouped subquery, then ORDER BY rank.`,
  },
  {
    id: 'contribution', test: /(contribut|composition|breakdown|what share|percent of total|proportion of total|makes up)/i,
    text: () => `CONTRIBUTION: 100.0 * SUM(<measure>) / SUM(SUM(<measure>)) OVER () AS contribution_pct with GROUP BY <category>, ordered by contribution_pct DESC.`,
  },
  {
    id: 'topn', test: /(\btop\b|\bbest\b|\bhighest\b|\blowest\b|\bmost\b|\bleast\b|\bbottom\b|\bworst\b)/i,
    text: () => `TOP/BOTTOM N: GROUP BY the entity, ORDER BY the aggregate DESC (or ASC for lowest/bottom), LIMIT N. If N is not given use LIMIT 1 for a single "which/who" question, otherwise LIMIT 10.`,
  },
  {
    id: 'period', test: /(monthly|per month|by month|each month|weekly|yearly|per year|by year|quarterly|over time|trend|daily|by day|last \d+ (months?|days?|years?)|in (19|20)\d\d)/i,
    text: (d) => `TIME GROUPING: group by period using ${periodExpr(d, '<date_column>', 'month')} (month) or ${periodExpr(d, '<date_column>', 'year')} (year); order chronologically. Filter a year with ${periodExpr(d, '<date_column>', 'year')} = '2026'.`,
  },
  {
    id: 'multi', test: /(who|which|what).*(and|with|from|for).*(highest|most|top|generated|bought|ordered)/i,
    text: () => `MULTI-TABLE: use the JOIN conditions listed under JOIN PATHS; select only the columns needed and aggregate with GROUP BY on the entity.`,
  },
];

function selectPatternHints(question, dialect = 'sqlite') {
  return RULES.filter((r) => r.test.test(question)).map((r) => r.text(dialect)).join('\n');
}

module.exports = { selectPatternHints, periodExpr };
