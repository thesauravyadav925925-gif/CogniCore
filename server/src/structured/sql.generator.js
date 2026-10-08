/**
 * SQL GENERATOR
 * Turns a natural-language question + the dataset's ACTUAL discovered schema,
 * semantic model, join paths and business definitions into candidate SQL via the LLM.
 *
 * RULE #7: This output is NEVER trusted directly - sql.validator.js always runs
 * on whatever comes back before execution.
 */
const { renderSemanticPrompt } = require('../semantic/semantic.builder');
const { renderJoinHints } = require('../schema/join.planner');
const { selectPatternHints } = require('./sql.patterns');
const { dialectOf } = require('../utils/sqlident');

function buildSchemaDescription(schema) {
  const tableNames = schema.tables.map((t) => `"${t.name}"`).join(', ');
  const tables = schema.tables.map(t => {
    const cols = t.columns.map(c => `${c.name} (${c.type}${c.primaryKey ? ', PK' : ''})`).join(', ');
    const fks = (t.foreignKeys || []).map(fk => `${fk.column} -> ${fk.referencesTable}.${fk.referencesColumn}`).join('; ');
    return `Table "${t.name}" [${t.rowCount} rows]: ${cols}${fks ? `\n  Relationships: ${fks}` : ''}`;
  }).join('\n');
  return { tables, tableNames };
}

const DIALECT_LABEL = { sqlite: 'SQLite', postgres: 'PostgreSQL', mysql: 'MySQL' };

function buildPrompt({
  question, schema, relationships = [], conversationContext = '', datasetType = 'sqlite', retryHint = false,
  semantic = null, knowledgeText = '', followUp = null, recovery = null,
}) {
  const { tables: schemaDesc, tableNames } = buildSchemaDescription(schema);
  const dialect = dialectOf(datasetType);
  const dialectLabel = DIALECT_LABEL[dialect] || 'SQLite';
  const relDesc = relationships.length
    ? relationships.map(r => `${r.fromTable}.${r.fromColumn} -> ${r.toTable}.${r.toColumn}`).join('\n')
    : '(none detected)';
  const semanticText = semantic ? renderSemanticPrompt(semantic) : '';
  const joinHints = renderJoinHints(question, schema, relationships);
  const patternHints = selectPatternHints(question, dialect);

  const retryNote = retryHint
    ? `\nIMPORTANT: A previous attempt at this question gave up and answered NO_QUERY_POSSIBLE, but this question likely CAN be answered against the schema above. Look again carefully. Filtering on multiple values can use WHERE col IN ('a', 'b') or WHERE col = 'a' OR col = 'b'. Selecting several columns from one table needs no JOIN at all. Please attempt a real query rather than giving up again unless it is truly impossible.\n`
    : '';

  const recoveryNote = recovery
    ? `\nYOUR PREVIOUS QUERY FAILED:\n${recovery.previousSql}\nERROR: ${recovery.error}\n${recovery.hints?.length ? `HINTS: ${recovery.hints.join('; ')}\n` : ''}Write a corrected query. Use only the exact table and column names listed above.\n`
    : '';

  const followUpNote = followUp?.previousSql
    ? `\nPREVIOUS QUESTION: ${followUp.previousQuestion}\nPREVIOUS QUERY: ${followUp.previousSql}\n(If the new question refers to "it", "them", "that", or asks to refine/compare/filter the previous result, build on the previous query's filters and grouping.)\n`
    : '';

  return `You are a SQL generation engine for ${dialectLabel}. You have NO knowledge of what domain this data represents - only use the schema given below.

SCHEMA:
${schemaDesc}

Valid table name(s), exactly as spelled above: ${tableNames}
${semanticText ? `\nSEMANTIC MODEL (what each column means, with real values found in the data - use these exact spellings in filters):\n${semanticText}\n` : ''}
DETECTED RELATIONSHIPS:
${relDesc}
${joinHints ? `\nJOIN PATHS (use exactly these conditions when combining tables):\n${joinHints}\n` : ''}${knowledgeText ? `\nBUSINESS DEFINITIONS (organization-specific, authoritative):\n${knowledgeText}\n` : ''}${patternHints ? `\nQUERY PATTERNS THAT MAY HELP:\n${patternHints}\n` : ''}${conversationContext ? `\nCONVERSATION CONTEXT:\n${conversationContext}\n` : ''}${followUpNote}${retryNote}${recoveryNote}
RULES:
- Output ONLY a single valid ${dialectLabel} SELECT statement. No explanation, no markdown, no code fences.
- Only SELECT statements are allowed (a leading WITH ... SELECT is fine). Never write DROP, DELETE, UPDATE, INSERT, ALTER, CREATE, ATTACH, or PRAGMA.
- Use the table and column names exactly as shown in the schema above.
- Filter text columns using the exact spellings listed under possible values.
- When dividing counts or sums to compute a rate/percentage, the result should be a decimal, not an integer - write it in a way that avoids integer truncation (multiply by 100.0 first).
- Do not use semicolons or comments.
- If the question genuinely cannot be answered with the given schema (e.g. it asks about data that isn't present at all), output exactly: NO_QUERY_POSSIBLE
- Simple questions (counts, averages, sums, filters, sorting, filtering on multiple values) almost always CAN be answered directly against the schema above - attempt a query rather than giving up.

QUESTION: ${question}

SQL:`;
}

async function generateSql(llmProvider, opts) {
  const prompt = buildPrompt(opts);
  const raw = await llmProvider.complete(prompt, { temperature: opts.recovery ? 0.2 : 0.1, maxTokens: 500 });
  const cleaned = cleanSqlOutput(raw);
  return { sql: cleaned, rawResponse: raw, prompt };
}

function cleanSqlOutput(raw) {
  let sql = raw.trim();
  // Strip markdown code fences if the model added them anyway.
  sql = sql.replace(/^```(sql)?/i, '').replace(/```$/, '').trim();
  // Take only the first statement if the model rambled.
  const firstSemicolon = sql.indexOf(';');
  if (firstSemicolon !== -1) sql = sql.slice(0, firstSemicolon);
  return sql.trim();
}

module.exports = { generateSql, buildSchemaDescription, buildPrompt, cleanSqlOutput };
