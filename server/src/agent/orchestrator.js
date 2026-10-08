/**
 * ORCHESTRATOR / PLANNER (blueprint #1, #13)
 *   Question -> understand intent -> inspect data -> PLAN -> select tools -> execute (independent
 *   steps in parallel) -> validate each step -> synthesise -> evidence.
 * Used for broad requests ("Analyze our company performance and tell me what needs attention").
 * The plan is derived from the dataset's semantic model (which measures, dates, categories exist),
 * so it adapts to any domain. Every step is a deterministic tool; the synthesis only states
 * numbers those tools produced. The full plan is returned so the UI can show it.
 */
const R = require('./column.resolver');
const { TOOLS } = require('./analytic.tools');
const { runSafeSql, policyRestrictsAggregates, isColumnDenied } = require('./safe.query');
const { compareGroups } = require('../analytics/compare');
const { qi } = R;

const pretty = (c) => String(c).replace(/_/g, ' ');
const fmt = (n) => (Number.isFinite(n) ? (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : +Number(n).toFixed(2)) : 'n/a');

/** Chooses the focus table/measure/date/category from the semantic model (generic rules only). */
function focusOf(semantic, table, policy) {
  const ok = (c) => !isColumnDenied(policy, table.name, c.name);
  const measures = table.columns.filter((c) => R.MEASURE_ROLES.includes(c.role) && ok(c));
  const measure = measures.find((c) => c.role === 'monetary') || measures[0] || null;
  const date = table.columns.find((c) => c.role === 'temporal' && ok(c)) || null;
  const cats = table.columns.filter((c) => c.role === 'categorical' && c.stats.distinct >= 2 && c.stats.distinct <= 25 && ok(c))
    .sort((a, b) => Math.abs(a.stats.distinct - 6) - Math.abs(b.stats.distinct - 6));
  return { measure, secondMeasure: measures.find((m) => m !== measure) || null, date, category: cats[0] || null };
}

function buildPlan({ question, semantic, table, policy }) {
  const f = focusOf(semantic, table, policy);
  const steps = [];
  const add = (id, tool, label, q, dependsOn = []) => steps.push({ id, tool, label, question: q, dependsOn });
  add('kpis', 'kpi', 'Compute headline KPIs', 'Show the key metrics');
  add('quality', 'quality', 'Check data quality', 'Are there any data quality problems?');
  if (f.measure && f.date) add('trend', 'trend', `Analyse the ${pretty(f.measure.name)} trend over time`, `What is the ${pretty(f.measure.name)} trend over time?`);
  if (f.measure) add('anomaly', 'anomaly', `Look for unusual ${pretty(f.measure.name)} values`, `Are there any unusual ${pretty(f.measure.name)} values?`);
  if (f.measure && f.category) add('breakdown', 'breakdown', `Compare ${pretty(f.measure.name)} across ${pretty(f.category.name)}`, null);
  if (f.measure && f.secondMeasure) add('correlation', 'correlation', `Test the relationship between ${pretty(f.measure.name)} and ${pretty(f.secondMeasure.name)}`, `Is there a correlation between ${pretty(f.measure.name)} and ${pretty(f.secondMeasure.name)}?`);
  if (f.measure && f.date) add('forecast', 'forecast', `Project ${pretty(f.measure.name)} forward`, `Forecast ${pretty(f.measure.name)} for the next 3 months`, ['trend']);
  add('synthesis', 'synthesis', 'Combine findings and flag what needs attention', null, steps.map((s) => s.id));
  return { goal: question, table: table.name, focus: { measure: f.measure?.name, date: f.date?.name, category: f.category?.name }, steps };
}

/** Groups steps into waves: every step whose dependencies are done runs in the same wave (in parallel). */
function waves(plan) {
  const done = new Set(), out = [];
  let remaining = [...plan.steps];
  while (remaining.length) {
    const ready = remaining.filter((s) => s.dependsOn.every((d) => done.has(d)));
    if (!ready.length) throw new Error('Plan has a circular dependency.');
    out.push(ready);
    ready.forEach((s) => done.add(s.id));
    remaining = remaining.filter((s) => !ready.includes(s));
  }
  return out;
}

async function runBreakdown(ctx, focus) {
  const { measure, category } = focus;
  const agg = measure.role === 'percentage' ? 'AVG' : 'SUM';
  const sql = `SELECT ${qi(category.name)} AS label, ${agg}(${qi(measure.name)}) AS value FROM ${qi(ctx.table.name)} WHERE ${qi(category.name)} IS NOT NULL AND ${qi(measure.name)} IS NOT NULL GROUP BY ${qi(category.name)} ORDER BY value DESC`;
  const res = await runSafeSql({ dataset: ctx.dataset, sql, policy: ctx.policy });
  const items = res.rows.map((r) => ({ label: String(r.label), value: Number(r.value) })).filter((i) => Number.isFinite(i.value));
  if (items.length < 2) return null;
  const cmp = compareGroups(items, { measure: `${agg === 'AVG' ? 'average ' : ''}${pretty(measure.name)}` });
  const rows = cmp.items.map((i) => ({ [category.name]: i.label, value: +i.value.toFixed(2), share_pct: i.shareOfTotalPct }));
  const { buildStructuredEvidence } = require('../evidence/evidence.manager');
  const evidence = buildStructuredEvidence({ datasetId: ctx.dataset.dataset_id, datasetName: ctx.dataset.name, sql, result: { rowCount: rows.length, truncated: false, columns: Object.keys(rows[0]), rows }, resultValidation: { confidence: 0.95, issues: [] }, extras: { tables_used: [ctx.table.name], analytics: { tool: 'breakdown' } } });
  return { answer: cmp.sentence, evidence, generatedSql: sql, analytics: { tool: 'breakdown', comparison: cmp } };
}

async function executeStep(step, ctx, focus) {
  const t0 = Date.now();
  try {
    let out;
    if (step.tool === 'breakdown') out = await runBreakdown(ctx, focus);
    else {
      const words = R.questionWords(step.question);
      out = await TOOLS[step.tool]({ ...ctx, question: step.question, words });
    }
    // Validation: a step is only "ok" if it produced an answer without being denied.
    if (!out || !out.answer) return { id: step.id, status: 'skipped', note: 'not applicable to this data', ms: Date.now() - t0 };
    if (out.denied) return { id: step.id, status: 'blocked', note: out.answer, ms: Date.now() - t0 };
    return { id: step.id, status: out.lowConfidence ? 'weak' : 'ok', out, ms: Date.now() - t0 };
  } catch (err) {
    return { id: step.id, status: 'failed', note: err.message, ms: Date.now() - t0 };
  }
}

function synthesize(plan, results, focus) {
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  const get = (id) => (by[id]?.status === 'ok' || by[id]?.status === 'weak' ? by[id].out : null);
  const findings = [], attention = [];
  const first = (t) => String(t || '').split(/(?<=[.!?])\s+/)[0];

  const kpi = get('kpis');
  if (kpi) findings.push(`Headline: ${kpi.answer.replace(/^Key metrics — /, '').slice(0, 260)}`);
  const trend = get('trend');
  if (trend) {
    findings.push(trend.answer.split(/(?<=\.)\s+/).slice(0, 2).join(' '));
    const d = trend.analytics?.trend?.direction;
    if (d === 'decreasing') attention.push(`${pretty(focus.measure)} is trending downward (${trend.analytics.trend.totalChangePct}% overall).`);
    if (d === 'volatile') attention.push(`${pretty(focus.measure)} is volatile with no clear direction.`);
    const latest = trend.analytics?.trend?.latestVsPreviousPct;
    if (latest !== null && latest !== undefined && latest <= -10) attention.push(`The latest period fell ${Math.abs(latest)}% versus the previous one.`);
  }
  const br = get('breakdown');
  if (br) {
    findings.push(br.answer);
    const top = br.analytics.comparison.items?.[0];
    if (top && br.analytics.comparison.items.length >= 3 && top.shareOfTotalPct >= 40) attention.push(`${top.label} accounts for ${top.shareOfTotalPct}% of ${pretty(focus.measure)} — high concentration.`);
  }
  const an = get('anomaly');
  if (an) {
    findings.push(first(an.answer));
    if ((an.analytics?.count || 0) > 0) attention.push(`${an.analytics.count} unusual ${pretty(focus.measure)} value(s) should be reviewed.`);
  }
  const co = get('correlation');
  if (co) findings.push(first(co.answer));
  const fc = get('forecast');
  if (fc && !fc.analytics?.error) findings.push(first(fc.answer));
  const q = get('quality');
  if (q) {
    const score = q.analytics?.quality?.overallScore;
    findings.push(first(q.answer));
    const high = (q.analytics?.quality?.tables || []).flatMap((t) => t.issues).filter((i) => i.severity === 'high');
    if (high.length) attention.push(`${high.length} high-severity data-quality issue(s): ${high[0].message}`);
    else if (score !== undefined && score < 85) attention.push(`Data quality score is ${score}/100, so some conclusions may be affected.`);
  }

  const failed = results.filter((r) => r.status === 'failed' || r.status === 'blocked');
  const answer = [
    attention.length ? `What needs attention:\n${attention.map((a) => `• ${a}`).join('\n')}` : 'Nothing alarming was detected by the automated checks.',
    `What I found:\n${findings.map((f) => `• ${f}`).join('\n')}`,
    failed.length ? `Not completed: ${failed.map((r) => `${r.id} (${r.note})`).join('; ')}.` : null,
  ].filter(Boolean).join('\n\n');
  return { answer, attention, findings };
}

async function runOrchestrated({ question, dataset, policy = null, semantic = null, table = null }) {
  semantic = semantic || dataset.profile?.semantic;
  if (!semantic) return null;
  if (policyRestrictsAggregates(policy)) return { answer: 'A whole-dataset overview is not available for roles with row-level restrictions. Ask a specific question instead.', evidence: null, denied: true, lowConfidence: true };
  const words = R.questionWords(question);
  table = table || R.pickTable(semantic, words);
  if (!table) return null;
  const plan = buildPlan({ question, semantic, table, policy });
  const ctx = { dataset, semantic, table, policy };
  const focus = focusOf(semantic, table, policy);
  const results = [];
  const timeline = [];
  for (const wave of waves(plan)) {
    const runnable = wave.filter((s) => s.tool !== 'synthesis');
    const t0 = Date.now();
    const done = await Promise.all(runnable.map((s) => executeStep(s, ctx, focus)));
    results.push(...done);
    if (runnable.length) timeline.push({ parallel: runnable.map((s) => s.id), ms: Date.now() - t0 });
  }
  const syn = synthesize(plan, results, { measure: focus.measure?.name, category: focus.category?.name });
  const stepOut = plan.steps.filter((s) => s.tool !== 'synthesis').map((s) => {
    const r = results.find((x) => x.id === s.id);
    return { question: s.label, evidence: r?.out?.evidence || null, failed: !r || !['ok', 'weak'].includes(r.status), failureReason: r && !['ok', 'weak'].includes(r.status) ? r.note : undefined, tool: s.tool, status: r?.status, ms: r?.ms };
  });
  const okCount = stepOut.filter((s) => !s.failed).length;
  const evidence = {
    source_type: 'analysis', dataset_name: dataset.name, steps: stepOut, plan: { goal: plan.goal, focus: plan.focus, steps: plan.steps.map((s) => ({ id: s.id, tool: s.tool, label: s.label, dependsOn: s.dependsOn })), timeline },
    confidence: stepOut.length ? +(okCount / stepOut.length).toFixed(2) : 0, generated_at: new Date().toISOString(),
  };
  return { answer: syn.answer, evidence, plan, attention: syn.attention, lowConfidence: okCount < Math.ceil(stepOut.length / 2), analytics: { tool: 'orchestrator', plan, results: results.map((r) => ({ id: r.id, status: r.status, ms: r.ms })) } };
}

module.exports = { buildPlan, waves, runOrchestrated, focusOf };
