const { DatasetRegistry } = require('./dataset.registry');
const { createAdapter } = require('./adapters');
const { readSchema } = require('../schema/schema.reader');
const { analyzeSchema } = require('../schema/schema.analyzer');
const { enrichProfile } = require('./profile.enricher');
const { testPostgresConnection } = require('./adapters/postgres.adapter');
const { testMySQLConnection } = require('./adapters/mysql.adapter');

const TESTERS = {
  postgres: testPostgresConnection,
  mysql: testMySQLConnection,
};

/**
 * Build a display-only connection string with NO password in it, for the
 * dataset's `location` field (which IS exposed via the API). Real
 * credentials live only in DatasetRegistry's connection_credentials table.
 */
function sanitizedLocation(type, creds) {
  const scheme = type === 'postgres' ? 'postgresql' : 'mysql';
  return `${scheme}://${creds.user}@${creds.host}:${creds.port}/${creds.database}`;
}

/**
 * Register + validate + schema-discover a live database connection.
 * Unlike file datasets, nothing is materialized - the adapter queries
 * the live database directly on every request.
 */
async function ingestConnection({ type, name, host, port, database, user, password, ssl = false, ownerId = null }) {
  if (!TESTERS[type]) {
    throw new Error(`Unsupported connection type "${type}". Supported: ${Object.keys(TESTERS).join(', ')}`);
  }

  const creds = { host, port, database, user, password, ssl };

  // Fail fast with a clear error before we even create a registry record.
  const testResult = await TESTERS[type](creds);
  if (!testResult.ok) {
    throw new Error(`Could not connect to ${type} database: ${testResult.error}`);
  }

  const record = DatasetRegistry.create({
    name: name || database,
    type,
    source: 'connection',
    location: sanitizedLocation(type, creds),
    ownerId,
  });

  // Credentials go in the separate, never-exposed table.
  DatasetRegistry.storeCredentials(record.dataset_id, creds);

  try {
    const adapter = createAdapter(type, { datasetId: record.dataset_id, location: record.location });
    const { schema, metadata } = await readSchema(adapter);
    const analyzed = analyzeSchema(schema, metadata);
    Object.assign(analyzed, await enrichProfile({
      type, datasetId: record.dataset_id, location: record.location, schema, relationships: analyzed.relationships,
    }));
    return DatasetRegistry.markReady(record.dataset_id, { schema, profile: analyzed });
  } catch (err) {
    DatasetRegistry.markError(record.dataset_id, err.message);
    throw err;
  }
}

module.exports = { ingestConnection };
