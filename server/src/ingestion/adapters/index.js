const { SQLiteAdapter } = require('./sqlite.adapter');
const { CSVAdapter } = require('./csv.adapter');
const { ExcelAdapter } = require('./excel.adapter');
const { PostgresAdapter } = require('./postgres.adapter');
const { MySQLAdapter } = require('./mysql.adapter');
const { JSONAdapter } = require('./json.adapter');

/**
 * ADAPTER FACTORY
 * Adding a new connector means adding one entry here and one adapter
 * file - the core engine never changes.
 */
const ADAPTERS = {
  sqlite: SQLiteAdapter,
  csv: CSVAdapter,
  xlsx: ExcelAdapter,
  json: JSONAdapter,
  postgres: PostgresAdapter,
  mysql: MySQLAdapter,
};

function createAdapter(type, { datasetId, location }) {
  const AdapterClass = ADAPTERS[type];
  if (!AdapterClass) {
    throw new Error(`No adapter registered for dataset type "${type}". Available: ${Object.keys(ADAPTERS).join(', ')}`);
  }
  return new AdapterClass({ datasetId, location });
}

module.exports = { createAdapter, ADAPTERS };
