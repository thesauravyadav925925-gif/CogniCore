/**
 * ENTERPRISE GUARDRAILS (Feature 35)
 *  - prompt-injection screening of user questions
 *  - neutralising instruction-like text inside retrieved documents / data
 *  - SQL-injection *attempts in natural language* are flagged (execution safety is
 *    enforced separately and unconditionally by sql.validator.js + read-only access)
 * These run in plain code; the LLM is never asked whether something is safe.
 */
const INJECTION = [
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|rules?|prompts?|messages?)/i,
  /disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|your|these)?\s*(instructions?|rules?|guidelines|constraints)/i,
  /forget\s+(everything|all|your)\s+(above|previous|prior|instructions?|rules?)/i,
  /(reveal|show|print|display|repeat|output|leak)\s+(me\s+)?(your|the)\s+(hidden\s+|secret\s+|initial\s+)?(system\s+prompt|instructions|prompt|rules)/i,
  /you\s+are\s+now\s+(in\s+)?(dan|developer\s+mode|an?\s+unrestricted|jailbroken|no\s+longer)/i,
  /\b(jailbreak|do\s+anything\s+now)\b/i,
  /(bypass|override|disable|circumvent|turn\s+off)\s+(the\s+|all\s+|any\s+)?(security|permissions?|access\s+(control|rules?)|rbac|policy|policies|validation|safety|guardrails?|restrictions?|filters?)/i,
  /pretend\s+(that\s+)?(you\s+)?(have\s+no|are\s+not|don'?t\s+have)\s+(restrictions?|rules?|limits?)/i,
  /(act|respond)\s+as\s+(if\s+)?(i\s+am|i'm|an?)\s+(the\s+)?(admin(istrator)?|root|superuser)/i,
  /<\s*\/?\s*(system|assistant)\s*>|\[\s*(system|inst)\s*\]|###\s*system/i,
];

const SQLI_LIKE = [
  /;\s*(drop|delete|truncate|alter|update|insert)\s/i,
  /\b(drop|truncate)\s+table\b/i,
  /\bunion\s+select\b/i,
  /('|")\s*or\s+('|")?1('|")?\s*=\s*('|")?1/i,
  /--\s*$/,
];

function screenQuestion(question) {
  const q = String(question || '');
  const flags = [];
  if (INJECTION.some((re) => re.test(q))) flags.push('prompt_injection');
  if (SQLI_LIKE.some((re) => re.test(q))) flags.push('sql_injection_attempt');
  if (q.length > 4000) flags.push('oversized_input');
  const blocked = flags.includes('prompt_injection') || flags.includes('oversized_input');
  return {
    blocked, flags,
    message: blocked
      ? (flags.includes('oversized_input')
        ? 'That message is too long. Please shorten your question.'
        : "I can only answer questions about your connected data. I can't follow instructions that try to change my rules, bypass permissions, or reveal internal configuration.")
      : null,
  };
}

/** Removes instruction-like lines from text that came from documents/data (indirect prompt injection). */
function neutralizeInjection(text) {
  const s = String(text ?? '');
  let removed = 0;
  const clean = s.split('\n').map((line) => {
    if (INJECTION.some((re) => re.test(line))) { removed++; return '[removed: instruction-like text in source]'; }
    return line;
  }).join('\n');
  return { text: clean, removed };
}

module.exports = { screenQuestion, neutralizeInjection, INJECTION, SQLI_LIKE };
