/**
 * RELATIONSHIP DETECTOR
 * ------------------------------------------------------------------
 * Infers relationships between tables WITHOUT any domain assumptions.
 * Two signals are used, purely structural:
 *
 *  1. Declared foreign keys (already present for real SQLite/Postgres DBs).
 *  2. Naming heuristic: a column named "<x>_id" or "<x>id" likely
 *     references a table named "<x>" (singular or plural) whose
 *     primary key / first "_id" column is the target.
 *
 * This mirrors Section 7 of the spec:
 *   students.department_id -> departments.department_id
 * discovered WITHOUT hardcoding "students" or "departments".
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

function detectRelationships(schema) {
  const relationships = [];
  const tablesByName = new Map(schema.tables.map(t => [t.name.toLowerCase(), t]));

  // 1. Declared foreign keys, if the adapter already gave us some.
  for (const table of schema.tables) {
    for (const fk of table.foreignKeys || []) {
      relationships.push({
        fromTable: table.name,
        fromColumn: fk.column,
        toTable: fk.referencesTable,
        toColumn: fk.referencesColumn,
        confidence: 1.0,
        method: 'declared_foreign_key',
      });
    }
  }

  // 2. Naming-based inference (covers CSV/Excel-derived tables with no real FKs).
  const idPattern = /^(.*)_id$/i;
  for (const table of schema.tables) {
    for (const col of table.columns) {
      const match = col.name.match(idPattern);
      if (!match) continue;
      const stem = match[1].toLowerCase();
      if (!stem) continue;

      // Skip a table's own primary-key-style id (e.g. students.student_id in `students`)
      const candidates = [stem, singularize(stem), pluralize(stem)];
      for (const candidate of candidates) {
        const target = tablesByName.get(candidate);
        if (!target || target.name === table.name) continue;

        // Prefer a matching id column on the target, else its primary key.
        const targetCol =
          target.columns.find(c => c.name.toLowerCase() === col.name.toLowerCase()) ||
          target.columns.find(c => c.primaryKey) ||
          target.columns.find(c => /^(.*)_id$/i.test(c.name));

        if (targetCol) {
          const already = relationships.some(r =>
            r.fromTable === table.name && r.fromColumn === col.name && r.toTable === target.name);
          if (!already) {
            relationships.push({
              fromTable: table.name,
              fromColumn: col.name,
              toTable: target.name,
              toColumn: targetCol.name,
              confidence: 0.7,
              method: 'naming_heuristic',
            });
          }
        }
        break;
      }
    }
  }

  return relationships;
}

module.exports = { detectRelationships };
