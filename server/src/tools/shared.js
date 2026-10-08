const { DatasetRegistry } = require('../ingestion/dataset.registry');
const { createAdapter } = require('../ingestion/adapters');
const { validateSql, SQLValidationError } = require('../structured/sql.validator');
const { executeValidatedQuery } = require('../structured/sql.executor');
const { resolvePolicy, enforcePolicy } = require('../security/data.policy');

/**
 * RESOLVE VALIDATED RESULT
 * ------------------------------------------------------------------
 * Every tool (chart, export, report, calculate) calls this FIRST. It
 * takes a dataset ID + a SQL string and re-runs the exact same
 * generate->validate->execute pipeline the chat endpoint uses.
 *
 * This is deliberate and important: tools never accept rows/numbers
 * directly from the client. A chart or export is only ever built from
 * data this function just pulled, live, from the real dataset - closing
 * off any path where a tool could be tricked into rendering or exporting
 * fabricated numbers (Rules #20, #23, #24).
 * ------------------------------------------------------------------
 */
async function resolveValidatedResult({ datasetId, sql, user = null }) {
  if (!datasetId) throw new Error('datasetId is required.');
  if (!sql || !sql.trim()) throw new Error('sql is required.');

  const dataset = DatasetRegistry.get(datasetId);
  if (!dataset) throw new Error(`Dataset "${datasetId}" not found.`);
  if (dataset.status !== 'ready') throw new Error(`Dataset "${dataset.name}" is not ready (status: ${dataset.status}).`);
  if (!dataset.schema || !Array.isArray(dataset.schema.tables)) {
    throw new Error(`Dataset "${dataset.name}" has no queryable schema (is it a document dataset?).`);
  }

  try {
    validateSql(sql, dataset.schema, dataset.type);
  } catch (err) {
    if (err instanceof SQLValidationError) {
      throw new Error(`Query failed safety validation: ${err.message}`);
    }
    throw err;
  }

  // Data-level security applies to tools exactly as it does to chat (Features 22/23):
  // denied columns are refused and row filters wrap the tables the query touches.
  const policy = resolvePolicy({ datasetId, user });
  const execSql = enforcePolicy({ sql, schema: dataset.schema, policy, datasetType: dataset.type });

  const adapter = createAdapter(dataset.type, { datasetId: dataset.dataset_id, location: dataset.location });
  const result = await executeValidatedQuery(adapter, execSql);

  return { dataset, result };
}

module.exports = { resolveValidatedResult };
