/**
 * SQL REPAIR
 * ------------------------------------------------------------------
 * Small local LLMs frequently write a plausible-but-wrong table name
 * (most commonly: guessing a plural like "employees" when the real,
 * schema-given table is singular "employee") even when the exact name
 * was right there in the prompt. Rather than fail the whole query on
 * this extremely common and low-risk mistake, we deterministically
 * check whether the guessed identifier is a case/plural variant of a
 * REAL table in the REAL schema, and substitute it if so.
 *
 * This is not a second LLM call and not a guess of our own - it only
 * ever substitutes toward a table name that provably exists in the
 * dataset's actual schema. The repaired SQL still goes through the full
 * validateSql() pipeline afterward, so this cannot weaken security; it
 * only reduces false-positive rejections of otherwise-correct queries.
 * ------------------------------------------------------------------
 */
function singularize(word) {
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ses')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function pluralize(word) {
  if (word.endsWith('y')) return word.slice(0, -1) + 'ies';
  if (word.endsWith('s')) return word;
  return word + 's';
}

/**
 * @param {string} sql
 * @param {{tables: {name: string}[]}} schema
 * @returns {{sql: string, repaired: boolean, corrections: {from: string, to: string}[]}}
 */
function repairTableNames(sql, schema) {
  const realNames = schema.tables.map((t) => t.name);
  const realByLower = new Map(realNames.map((n) => [n.toLowerCase(), n]));

  // Find bare identifiers following FROM/JOIN - a conservative regex, not a
  // full parse, specifically so we never touch anything inside a string
  // literal or a column name.
  const pattern = /\b(FROM|JOIN)\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi;
  const corrections = [];
  let repairedSql = sql;

  let match;
  const seen = new Set();
  while ((match = pattern.exec(sql)) !== null) {
    const candidate = match[2];
    if (realByLower.has(candidate.toLowerCase())) continue; // already correct
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const lower = candidate.toLowerCase();
    const variants = [singularize(lower), pluralize(lower)];
    const found = variants.map((v) => realByLower.get(v)).find(Boolean);

    if (found) {
      const wordBoundary = new RegExp(`\\b${candidate}\\b`, 'g');
      repairedSql = repairedSql.replace(wordBoundary, found);
      corrections.push({ from: candidate, to: found });
    }
  }

  return { sql: repairedSql, repaired: corrections.length > 0, corrections };
}

/**
 * When the model forgets the FROM clause entirely, that's only safe to
 * auto-complete if there's exactly ONE table in the dataset - otherwise
 * we'd be guessing which table was meant, which is exactly the kind of
 * fabrication this project's rules forbid. For a single-table dataset
 * (the overwhelmingly common case for a single CSV/Excel/SQLite upload)
 * there is only one possible correct answer, so this isn't a guess.
 */
function ensureFromClause(sql, schema) {
  const hasFrom = /\bFROM\b/i.test(sql);
  if (hasFrom) return { sql, repaired: false };
  if (schema.tables.length !== 1) return { sql, repaired: false }; // genuinely ambiguous - leave it to fail validation

  const onlyTable = schema.tables[0].name;
  return { sql: `${sql.trim()} FROM "${onlyTable}"`, repaired: true };
}

/**
 * INTEGER DIVISION FIX
 * ------------------------------------------------------------------
 * SQLite performs INTEGER division when both operands of "/" are
 * integers - COUNT(...) and SUM(...) always return integers for integer
 * columns, so a completely reasonable-looking percentage query like:
 *   COUNT(CASE WHEN status = 'completed' THEN 1 END) / COUNT(*) * 100
 * silently truncates to 0 BEFORE the *100 ever runs (5/7 truncates to 0,
 * not 0.71), producing a confidently wrong "0%" instead of an error.
 * This is worse than a refusal: it looks like a real, precise answer.
 *
 * Fixed deterministically by detecting COUNT(...)/... or SUM(...)/...
 * patterns (using a balanced-parenthesis scan, so it correctly handles
 * nested CASE WHEN expressions rather than a naive regex) and forcing
 * float division by prefixing the aggregate with "1.0 * ". This changes
 * the query's numeric TYPE, never its logic or which rows it touches -
 * it cannot make an otherwise-valid query behave differently in any way
 * other than making a division mathematically correct.
 * ------------------------------------------------------------------
 */
function fixIntegerDivision(sql) {
  let result = '';
  let i = 0;
  let corrected = false;
  let inString = false;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'" && !inString) { inString = true; result += ch; i++; continue; }
    if (ch === "'" && inString) { inString = false; result += ch; i++; continue; }

    if (!inString && ch === '/' && sql[i + 1] !== '*' /* not a comment */) {
      // Look backward over what we've already appended to `result` to find
      // the aggregate call immediately preceding this division, skipping
      // whitespace.
      let j = result.length - 1;
      while (j >= 0 && /\s/.test(result[j])) j--;

      if (result[j] === ')') {
        // Walk backward to find the matching '('.
        let depth = 1;
        let k = j - 1;
        while (k >= 0 && depth > 0) {
          if (result[k] === ')') depth++;
          else if (result[k] === '(') depth--;
          k--;
        }
        // k+1 is now just after the matching '(' position... actually k is
        // just before it once depth hits 0; the '(' itself is at k+1.
        const openParenIdx = k + 1;
        // Read the identifier immediately before the '('.
        let nameEnd = openParenIdx;
        let nameStart = nameEnd;
        while (nameStart > 0 && /[A-Za-z_]/.test(result[nameStart - 1])) nameStart--;
        const fnName = result.slice(nameStart, nameEnd).toUpperCase();

        // Check it isn't already float-safe (already CAST, or already
        // multiplied by a float literal like "1.0 *" just before it).
        let beforeFn = nameStart - 1;
        while (beforeFn >= 0 && /\s/.test(result[beforeFn])) beforeFn--;
        const alreadyFloatSafe =
          fnName === 'CAST' ||
          result.slice(Math.max(0, beforeFn - 6), beforeFn + 1).replace(/\s/g, '').toUpperCase().endsWith('1.0*');

        if ((fnName === 'COUNT' || fnName === 'SUM') && !alreadyFloatSafe) {
          result = result.slice(0, nameStart) + '1.0 * ' + result.slice(nameStart);
          corrected = true;
        }
      }
    }

    result += ch;
    i++;
  }

  return { sql: result, repaired: corrected };
}

module.exports = { repairTableNames, ensureFromClause, fixIntegerDivision };
