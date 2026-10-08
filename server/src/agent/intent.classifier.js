/**
 * INTENT CLASSIFIER (Feature 25: intent -> which tool?)
 * Deterministic and explainable: ordered, generic language patterns (not domain
 * terms). The first matching rule wins. Anything not recognised is `query`,
 * which continues down the normal SQL / document / hybrid path.
 * A rule only routes to a tool - the tool itself decides (via column
 * resolution) whether it can serve the request, and otherwise hands the
 * question back to the normal pipeline.
 */
const RULES = [
  { intent: 'scenario', re: /\b(what if|what happens if|what would happen if|suppose|assuming|assume|imagine|if (we|the|our|it|they)\b[^.?]*)\b[^.?]*\d+(\.\d+)?\s*(%|percent|per cent)/i },
  { intent: 'overview', re: /\b(analy[sz]e|review|assess|evaluate)\b[^.?]*\b(performance|business|company|organi[sz]ation|operations|everything|overall)\b|\bwhat needs (my |our )?attention\b|\bhealth check\b|\bbiggest (problems|risks|issues|concerns)\b|\bwhat('s| is) wrong\b|\bhow are we doing\b|\boverall (picture|summary|status)\b|\bwhere should i focus\b/i },
  { intent: 'action', re: /\b(send|email|mail|schedule|notify|remind|share)\b.*\b(report|summary|list|result|to|weekly|daily|monthly)\b|\b(generate|create)\b.*\b(and|then)\b.*\b(send|email)\b/i },
  { intent: 'report', re: /\b(management|executive|business|summary|monthly|weekly|full)\s+report\b|\bgive me a report\b|\b(generate|create|prepare|write)\b.*\breport\b/i },
  { intent: 'quality', re: /\b(data\s+quality|quality (issues|problems|check|report)|missing (values|data)|duplicate (rows|records|ids?)|null values|invalid dates?|dirty data|data (issues|problems|errors)|inconsistent (categories|values|spelling))\b/i },
  { intent: 'explore', re: /\b(what can i ask|what (questions|things) can|suggest (some )?questions|help me explore|explore (this|the) (data|dataset)|what('s| is) in (this|the) (data|dataset)|describe (this|the) (data|dataset)|what does this (data|dataset) (contain|have))\b/i },
  { intent: 'describe', re: /\b(describe|statistics (for|of|on)|summary statistics|distribution of|percentiles?|standard deviation|variance of|median|spread of|how (is|are) .{0,40} distributed|skew\w*|quartiles?)\b/i },
  { intent: 'kpi', re: /\b(kpis?|key (metrics|indicators|performance)|key figures|headline (numbers|metrics)|performance indicators|dashboard metrics)\b/i },
  { intent: 'correlation', re: /\b(correlat\w*|relationship between|is there a (link|relationship|connection) between|associated with)\b/i },
  { intent: 'forecast', re: /\b(forecast\w*|predict\w*|projection|project(ed)? (sales|revenue|values?)|expected (next|in the coming)|estimate (next|future)|next (\d+ )?(days?|weeks?|months?|quarters?|years?|period)|what will .* (be|look like))\b/i },
  { intent: 'anomaly', re: /\b(anomal\w*|outliers?|unusual\w*|abnormal\w*|suspicious|unexpected(ly)?|irregular|odd (values?|records?|transactions?)|look(s)? (abnormal|wrong|off)|strange|extreme values?)\b/i },
  { intent: 'trend', re: /\b(trend\w*|increasing or decreasing|going (up|down)|rising|falling|improved the most|declined the most|grown|growing|over the last \d+|last (six|\d+) (months?|weeks?|years?|quarters?)|what happened to|month(ly)? (by|over) month|is .* (increasing|decreasing|improving|declining))\b/i },
  { intent: 'compare', re: /\b(compare|comparison|versus|vs\.?|difference between|which (branch|region|department|store|team)s? (performs?|does) better|better than|outperform\w*)\b/i },
];

function classifyIntent(question) {
  const q = String(question || '');
  for (const r of RULES) if (r.re.test(q)) return { intent: r.intent, rule: r.re.source.slice(0, 40) };
  return { intent: 'query' };
}

module.exports = { classifyIntent, RULES };
