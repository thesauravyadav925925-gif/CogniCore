const { createAdapter } = require('../ingestion/adapters');
const { validateSql } = require('../structured/sql.validator');
const { executeValidatedQuery } = require('../structured/sql.executor');
const { enforcePolicy } = require('../security/data.policy');

/**
 * SAFE QUERY RUNNER
 * The single path every code-generated analytic query (trend, anomaly, forecast,
 * KPI drill-downs, reports...) takes to the database: AST validation -> data
 * policy (denied columns / row filters) -> read-only execution with a row cap.
 * Nothing in the agent layer is allowed to touch an adapter any other way.
 */
async function runSafeSql({ dataset, sql, policy = null, maxRows = 20000 }) {
  validateSql(sql, dataset.schema, dataset.type);
  const execSql = enforcePolicy({ sql, schema: dataset.schema, policy, datasetType: dataset.type });
  const adapter = createAdapter(dataset.type, { datasetId: dataset.dataset_id, location: dataset.location });
  return executeValidatedQuery(adapter, execSql, { maxRows });
}

/** True when the role's policy makes dataset-wide statistics unsafe to show. */
function policyRestrictsAggregates(policy) {
  return !!(policy && (policy.rowFilters?.length || 0) > 0);
}

function isColumnDenied(policy, table, column) {
  return !!(policy?.deniedColumns || []).some((d) => d.column.toLowerCase() === String(column).toLowerCase() && (!d.table || d.table.toLowerCase() === String(table).toLowerCase()));
}

module.exports = { runSafeSql, policyRestrictsAggregates, isColumnDenied };
