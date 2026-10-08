/**
 * COLUMN RESOLVER
 * Maps words in a question onto the semantic model (tables, measures, dates,
 * categories, category VALUES) without any domain knowledge. It returns null
 * pieces when it is not confident so the caller can fall back to the LLM path
 * instead of guessing.
 */
const STOP = new Set('the a an of for in on to by and or with from at as is are was were be been show me give what which who how much many total average avg number count list all each per over last next this that these those it its their there any than then also compare comparison between versus vs trend trends forecast predict unusual outlier outliers anomalies analysis analyze data dataset records record values value rate percentage'.split(' '));
const stem = (w) => w.replace(/ies$/, 'y').replace(/(ses|xes|zes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/s$/, '');
const parts = (name) => String(name).toLowerCase().split(/[^a-z0-9]+/).filter((p) => p.length > 1 && p !== 'id');

function questionWords(question) {
  return new Set(String(question).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
}

function nameScore(name, words) {
  return parts(name).filter((p) => words.has(stem(p))).length;
}

function pickTable(semantic, words) {
  let best = null, bestScore = -1;
  for (const t of semantic.tables) {
    let score = nameScore(t.name, words) * 2;
    for (const c of t.columns) score += nameScore(c.name, words);
    // value mentions (e.g. "Cardiology") also anchor the table
    for (const c of t.columns) for (const v of c.values || []) if (words.has(stem(String(v.value).toLowerCase()))) score += 1;
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best || semantic.tables[0] || null;
}

const MEASURE_ROLES = ['monetary', 'measure', 'count', 'percentage'];

function pickMeasure(table, words, { exclude = [] } = {}) {
  const cands = table.columns.filter((c) => MEASURE_ROLES.includes(c.role) && !exclude.includes(c.name));
  if (!cands.length) return null;
  const scored = cands.map((c) => ({ c, s: nameScore(c.name, words) })).sort((a, b) => b.s - a.s);
  if (scored[0].s > 0) return { column: scored[0].c, explicit: true };
  const money = cands.filter((c) => c.role === 'monetary');
  if (money.length === 1) return { column: money[0], explicit: false };
  return { column: (money[0] || cands[0]), explicit: false };
}

function pickTwoMeasures(table, words) {
  const cands = table.columns.filter((c) => MEASURE_ROLES.includes(c.role));
  const explicit = cands.map((c) => ({ c, s: nameScore(c.name, words) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.c);
  if (explicit.length >= 2) return [explicit[0], explicit[1]];
  if (cands.length >= 2 && explicit.length === 0) return [cands[0], cands[1]];
  return null;
}

function pickDate(table, words) {
  const dates = table.columns.filter((c) => c.role === 'temporal');
  if (!dates.length) return null;
  return dates.map((c) => ({ c, s: nameScore(c.name, words) })).sort((a, b) => b.s - a.s)[0].c;
}

/** Category column explicitly named in the question ("by department"), if any. */
function pickCategory(table, words, { requireExplicit = true } = {}) {
  const cats = table.columns.filter((c) => c.role === 'categorical' && c.stats.distinct >= 2);
  const scored = cats.map((c) => ({ c, s: nameScore(c.name, words) })).sort((a, b) => b.s - a.s);
  if (scored.length && scored[0].s > 0) return scored[0].c;
  return requireExplicit ? null : (cats[0] || null);
}

/** Category values mentioned literally in the question: [{column, value}] */
function findMentionedValues(table, question) {
  const q = ` ${String(question).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const found = [];
  for (const c of table.columns) {
    if (!c.values?.length || c.stats.distinct > c.values.length) continue;
    for (const v of c.values) {
      const val = String(v.value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (val.length >= 2 && !/^\d+$/.test(val) && q.includes(` ${val} `)) found.push({ column: c.name, value: v.value });
    }
  }
  return found;
}

function pickLabelColumn(table) {
  const byName = table.columns.find((c) => /(^|_)(name|title|label)$/i.test(c.name) || /name$/i.test(c.name));
  return byName || table.columns.find((c) => c.role === 'identifier') || table.columns.find((c) => c.role === 'categorical') || table.columns[0];
}

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
function parseHorizon(question, fallback = 3) {
  const m = String(question).toLowerCase().match(/next\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)?\s*(day|week|month|quarter|year|period)s?/);
  if (!m) return { horizon: fallback, unit: null };
  const n = m[1] ? (WORD_NUM[m[1]] || Number(m[1])) : 1;
  return { horizon: Math.min(Math.max(n, 1), 24), unit: m[2] };
}

const UNIT_TO_GRAIN = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };

const qi = (n) => `"${String(n).replace(/"/g, '""')}"`;

module.exports = { questionWords, pickTable, pickMeasure, pickTwoMeasures, pickDate, pickCategory, findMentionedValues, pickLabelColumn, parseHorizon, UNIT_TO_GRAIN, nameScore, qi, MEASURE_ROLES };
