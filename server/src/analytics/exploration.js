/**
 * DATA EXPLORATION + SMART SUGGESTIONS (Features 28 & 29)
 * exploreQuestions: "What can I ask about this dataset?" - questions generated
 *   from the semantic model (roles + real values), so they are always answerable.
 * followUpSuggestions: after an answer, 3 next steps derived from that answer's
 *   columns and top row (e.g. "Compare Cardiology with Orthopedics").
 * Both are deterministic; nothing here requires the LLM.
 */
const pretty = (c) => String(c).replace(/_/g, ' ');
const singular = (t) => pretty(t).replace(/ies$/, 'y').replace(/s$/, '');

function exploreQuestions(semantic, { limit = 14 } = {}) {
  const qs = [];
  for (const t of semantic.tables || []) {
    const cats = t.columns.filter((c) => c.role === 'categorical' && c.stats.distinct >= 2 && c.stats.distinct <= 30);
    const measures = t.columns.filter((c) => ['monetary', 'measure', 'count'].includes(c.role));
    const dates = t.columns.filter((c) => c.role === 'temporal');
    const tn = pretty(t.name);

    qs.push({ category: 'overview', question: `How many records are in ${tn}?` });
    if (cats[0]) qs.push({ category: 'breakdown', question: `Which ${pretty(cats[0].name)} has the most ${tn}?` });
    if (cats[0]) qs.push({ category: 'breakdown', question: `Show the number of records by ${pretty(cats[0].name)}.` });
    for (const m of measures.slice(0, 2)) {
      qs.push({ category: 'aggregate', question: `What is the average ${pretty(m.name)}?` });
      if (cats[0]) qs.push({ category: 'aggregate', question: `Show total ${pretty(m.name)} by ${pretty(cats[0].name)}.` });
      qs.push({ category: 'ranking', question: `What are the top 10 records by ${pretty(m.name)}?` });
      qs.push({ category: 'quality', question: `Are there any unusual ${pretty(m.name)} values?` });
    }
    const statusLike = cats.filter((c) => c.values?.length && c.stats.distinct <= 8).sort((a, b) => a.stats.distinct - b.stats.distinct).slice(0, 2);
    for (const sc of statusLike) {
      qs.push({ category: 'rate', question: `What percentage of records have ${pretty(sc.name)} = ${sc.values[0].value}?` });
      const other = cats.find((c) => c !== sc);
      if (other) qs.push({ category: 'rate', question: `What is the ${pretty(sc.name)} breakdown by ${pretty(other.name)}?` });
    }
    if (dates[0] && measures[0]) {
      qs.push({ category: 'trend', question: `Show monthly ${pretty(measures[0].name)} over time.` });
      qs.push({ category: 'forecast', question: `Forecast ${pretty(measures[0].name)} for the next 3 months.` });
    } else if (dates[0]) qs.push({ category: 'trend', question: `How many records were there per month (${pretty(dates[0].name)})?` });
    if (measures.length >= 2) qs.push({ category: 'relationship', question: `Is there a correlation between ${pretty(measures[0].name)} and ${pretty(measures[1].name)}?` });
  }
  qs.push({ category: 'quality', question: 'Are there any data quality problems in this dataset?' });
  qs.push({ category: 'report', question: 'Give me a management report.' });
  const seen = new Set();
  const uniq = qs.filter((q) => (seen.has(q.question) ? false : seen.add(q.question)));
  // Round-robin across categories so the list is varied.
  const byCat = {};
  uniq.forEach((q) => (byCat[q.category] = byCat[q.category] || []).push(q));
  const out = [];
  while (out.length < limit && Object.values(byCat).some((l) => l.length)) {
    for (const l of Object.values(byCat)) if (l.length && out.length < limit) out.push(l.shift());
  }
  return out;
}

function followUpSuggestions({ question = '', evidence, semantic = null, max = 3 }) {
  const out = [];
  if (!evidence || evidence.source_type !== 'database' || !evidence.sample_rows?.length) return out;
  const { columns, sample_rows: rows } = evidence;
  const isNum = (c) => rows.every((r) => r[c] === null || Number.isFinite(Number(r[c])));
  const timeCol = columns.find((c) => /(date|month|year|period|quarter|week|day)/i.test(c));
  const numCols = columns.filter((c) => isNum(c) && c !== timeCol && !/(^|_)id$/i.test(c));
  const catCols = columns.filter((c) => !isNum(c) && c !== timeCol);
  const cat = catCols[0], measure = numCols[0];

  if (cat && rows.length >= 2) {
    const first = rows[0][cat], second = rows[1][cat];
    out.push(`Compare ${first} with ${second}.`);
  }
  if (cat && rows[0]?.[cat] !== undefined && rows.length >= 1) {
    const top = rows[0][cat];
    if (!/trend|over time|monthly/i.test(question)) out.push(`Show ${top} trends over time.`);
    if (measure) out.push(`What share of the total does ${top} account for?`);
  }
  if (timeCol && measure) {
    out.push(`Is ${pretty(measure)} increasing or decreasing?`);
    out.push(`Forecast ${pretty(measure)} for the next 3 periods.`);
  }
  if (measure && rows.length >= 8) out.push(`Are there any unusual ${pretty(measure)} values?`);
  if (semantic && cat) {
    const other = semantic.tables.flatMap((t) => t.columns).find((c) => c.role === 'categorical' && c.name !== cat && c.stats.distinct <= 12);
    if (other) out.push(`Break this down by ${pretty(other.name)}.`);
  }
  const seen = new Set();
  return out.filter((q) => (seen.has(q) ? false : seen.add(q))).slice(0, max);
}

module.exports = { exploreQuestions, followUpSuggestions };
