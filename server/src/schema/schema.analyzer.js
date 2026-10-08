const { detectRelationships } = require('./relationship.detector');

/**
 * SCHEMA ANALYZER
 * Produces the final "dataset profile" used everywhere downstream:
 * schema + relationships + lightweight semantic tags (purely structural,
 * e.g. "looks numeric", "looks like an identifier") - never domain labels.
 */
function analyzeSchema(schema, profile = {}) {
  const relationships = detectRelationships(schema);

  const semanticTags = {};
  for (const table of schema.tables) {
    semanticTags[table.name] = {};
    for (const col of table.columns) {
      semanticTags[table.name][col.name] = classifyColumn(col);
    }
  }

  return {
    schema,
    profile,
    relationships,
    semanticTags,
    summary: {
      tableCount: schema.tables.length,
      columnCount: schema.tables.reduce((s, t) => s + t.columns.length, 0),
      relationshipCount: relationships.length,
    },
  };
}

/** Purely structural classification - no domain meaning attached. */
function classifyColumn(col) {
  const name = col.name.toLowerCase();
  const type = (col.type || '').toUpperCase();

  if (col.primaryKey) return 'identifier';
  if (/_id$/.test(name) || /^id$/.test(name)) return 'reference_or_identifier';
  if (/date|time|timestamp/.test(name)) return 'temporal';
  if (['INTEGER', 'REAL', 'NUMERIC', 'FLOAT', 'DOUBLE'].some(t => type.includes(t))) return 'numeric';
  if (['TEXT', 'VARCHAR', 'CHAR', 'STRING'].some(t => type.includes(t))) return 'categorical_or_text';
  return 'unknown';
}

module.exports = { analyzeSchema };
