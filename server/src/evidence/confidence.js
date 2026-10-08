/**
 * EXPLAINED CONFIDENCE (blueprint item 15)
 * No made-up "97%". Confidence is a transparent combination of measurable signals:
 *   schema certainty    - did we have to repair table/column names?
 *   query validity      - did it run first time, or only after automatic recovery?
 *   data completeness   - missing values in the columns actually used
 *   result consistency  - semantic result checks (percent range, reconciliation...)
 *   evidence quality    - rows behind the answer, truncation, sample size
 * Every component carries a human-readable reason; the level is High / Medium / Low.
 */
const clamp = (n) => Math.max(0, Math.min(1, n));
const WEIGHTS = { schema: 0.2, query: 0.2, completeness: 0.2, consistency: 0.2, evidence: 0.2 };

function level(score) { return score >= 0.8 ? 'High' : score >= 0.6 ? 'Medium' : 'Low'; }

function completenessFor(columns, semantic) {
  if (!semantic || !columns?.length) return { score: 1, reason: 'No per-column completeness information available.', missing: [] };
  const missing = [];
  let worst = 0;
  for (const ref of columns) {
    const [tn, cn] = ref.split('.');
    const col = semantic.tables.find((t) => t.name === tn)?.columns.find((c) => c.name === cn);
    if (!col || !col.stats?.total) continue;
    const ratio = col.stats.missing / col.stats.total;
    if (ratio > 0.005) { missing.push({ column: ref, missing: col.stats.missing, percent: +(ratio * 100).toFixed(1) }); worst = Math.max(worst, ratio); }
  }
  const score = clamp(1 - worst * 1.5);
  return { score, missing, reason: missing.length ? `Columns used have missing values (${missing.map((m) => `${m.column}: ${m.percent}%`).join(', ')}).` : 'The columns used are fully populated.' };
}

function explainConfidence({ kind = 'database', repairs = [], recoveryAttempts = 0, columns = [], semantic = null, rowCount = 0, truncated = false, resultIssues = [], consistencyPenalty = 0, deterministicTool = false, chunkScores = [] }) {
  if (kind === 'document') {
    const avg = chunkScores.length ? chunkScores.reduce((a, b) => a + b, 0) / chunkScores.length : 0;
    const ev = clamp(chunkScores.length ? 0.4 + avg * 0.6 : 0);
    return finish([{ key: 'evidence', score: ev, reason: chunkScores.length ? `${chunkScores.length} passages retrieved (average relevance ${(avg * 100).toFixed(0)}%).` : 'No relevant passage was found.' }], [1]);
  }
  const comps = [];
  const schemaRepairs = repairs.filter((r) => ['table_name', 'column_name'].includes(r.type));
  comps.push({ key: 'schema', score: clamp(1 - 0.12 * schemaRepairs.reduce((n, r) => n + (r.corrections?.length || 1), 0)), reason: schemaRepairs.length ? `Table/column names had to be corrected (${schemaRepairs.map((r) => r.corrections?.map((c) => `${c.from}→${c.to}`).join(', ')).join('; ')}).` : 'All tables and columns matched the real schema.' });
  const otherRepairs = repairs.filter((r) => !['table_name', 'column_name'].includes(r.type)).length;
  comps.push({ key: 'query', score: clamp(1 - 0.25 * recoveryAttempts - 0.05 * otherRepairs), reason: recoveryAttempts ? `The query needed ${recoveryAttempts} automatic correction attempt(s) after an error.` : (otherRepairs ? `The query ran after ${otherRepairs} small automatic fix(es) (e.g. value spelling, grouping).` : 'The query validated and ran first time.') });
  const comp = completenessFor(columns, semantic);
  comps.push({ key: 'completeness', score: comp.score, reason: comp.reason });
  comps.push({ key: 'consistency', score: clamp(1 - consistencyPenalty - 0.05 * resultIssues.length), reason: resultIssues.length || consistencyPenalty ? `Result checks raised: ${resultIssues.slice(0, 2).join(' ') || 'minor inconsistencies'}` : 'Result checks (ranges, totals, reconciliation) passed.' });
  let evScore = 1;
  const evReasons = [];
  if (rowCount === 0) { evScore -= 0.5; evReasons.push('the query returned no rows'); }
  if (truncated) { evScore -= 0.2; evReasons.push('the result was truncated to the row limit'); }
  comps.push({ key: 'evidence', score: clamp(evScore), reason: evReasons.length ? `Evidence is limited: ${evReasons.join(', ')}.` : `${rowCount} row(s) of real data back this answer.` });
  return finish(comps, comps.map((c) => WEIGHTS[c.key]), comp.missing);
}

function finish(comps, weights, missing = []) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const overall = comps.reduce((s, c, i) => s + c.score * weights[i], 0) / total;
  const minScore = Math.min(...comps.map((c) => c.score));
  // a single very weak component caps the result: confidence is only as good as its weakest link.
  const capped = Math.min(overall, minScore + 0.35);
  const score = +clamp(capped).toFixed(2);
  const lv = level(score);
  const weak = comps.filter((c) => c.score < 0.8).map((c) => c.reason);
  return {
    score, level: lv, components: Object.fromEntries(comps.map((c) => [c.key, { score: +c.score.toFixed(2), reason: c.reason }])),
    summary: lv === 'High' ? 'High confidence: the query ran cleanly on complete data.' : `${lv} confidence: ${weak.slice(0, 2).join(' ')}`,
    missing_data: missing,
  };
}

module.exports = { explainConfidence, completenessFor, level };
