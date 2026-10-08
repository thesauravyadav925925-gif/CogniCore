require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectRelationships } = require('../../src/schema/relationship.detector');

test('relationship.detector: infers FK purely from naming, no domain hardcoding', () => {
  // Deliberately arbitrary/non-ERP domain names to prove there's no
  // hardcoded "students"/"employees"/etc anywhere in the detection logic.
  const schema = {
    tables: [
      {
        name: 'widgets',
        columns: [{ name: 'widget_id', primaryKey: true }, { name: 'name' }, { name: 'factory_id' }],
        foreignKeys: [],
      },
      {
        name: 'factories',
        columns: [{ name: 'factory_id', primaryKey: true }, { name: 'location' }],
        foreignKeys: [],
      },
    ],
  };

  const relationships = detectRelationships(schema);
  assert.equal(relationships.length, 1);
  assert.equal(relationships[0].fromTable, 'widgets');
  assert.equal(relationships[0].fromColumn, 'factory_id');
  assert.equal(relationships[0].toTable, 'factories');
  assert.equal(relationships[0].toColumn, 'factory_id');
  assert.equal(relationships[0].method, 'naming_heuristic');
});

test('relationship.detector: prefers declared foreign keys over inference', () => {
  const schema = {
    tables: [
      {
        name: 'orders', columns: [{ name: 'order_id', primaryKey: true }, { name: 'customer_id' }],
        foreignKeys: [{ column: 'customer_id', referencesTable: 'customers', referencesColumn: 'customer_id' }],
      },
      { name: 'customers', columns: [{ name: 'customer_id', primaryKey: true }], foreignKeys: [] },
    ],
  };
  const relationships = detectRelationships(schema);
  assert.equal(relationships.some((r) => r.method === 'declared_foreign_key'), true);
});

test('relationship.detector: finds no relationships when tables are genuinely unrelated', () => {
  const schema = {
    tables: [
      { name: 'colors', columns: [{ name: 'color_id', primaryKey: true }, { name: 'hex' }], foreignKeys: [] },
      { name: 'shapes', columns: [{ name: 'shape_id', primaryKey: true }, { name: 'sides' }], foreignKeys: [] },
    ],
  };
  assert.equal(detectRelationships(schema).length, 0);
});

test('relationship.detector: does not self-reference a table\'s own primary key as a relationship', () => {
  const schema = {
    tables: [{ name: 'items', columns: [{ name: 'item_id', primaryKey: true }, { name: 'name' }], foreignKeys: [] }],
  };
  assert.equal(detectRelationships(schema).length, 0);
});
