/**
 * TOOL REGISTRY (blueprint #12)
 * Every capability is a tool with a name, category, description and the capability a role needs.
 * `GET /api/analytics/registry` lists the tools the signed-in role may use; the orchestrator/agent
 * pick from this same set. Also hosts the three "meta" tools: Schema, Dataset Profiler, Validation.
 */
const { can } = require('../security/rbac');
const { isColumnDenied } = require('../agent/safe.query');

const TOOL_CATALOG = [
  { name: 'sql', label: 'SQL Tool', category: 'query', capability: 'query', description: 'Natural language → validated, read-only SQL with automatic repair and error recovery.' },
  { name: 'document_search', label: 'Document Search Tool', category: 'query', capability: 'query', description: 'Retrieve and rerank passages from PDF/Word/PowerPoint/Markdown/text with page and section evidence.' },
  { name: 'hybrid', label: 'Hybrid Reasoning', category: 'query', capability: 'query', description: 'Combine databases, spreadsheets, APIs and documents in one answer.' },
  { name: 'orchestrator', label: 'Analysis Planner', category: 'agent', capability: 'query', description: 'Plans a multi-tool investigation for broad questions and runs independent steps in parallel.' },
  { name: 'trend', label: 'Trend Tool', category: 'analytics', capability: 'query', description: 'Direction, change, peaks, moving average and seasonality over time.' },
  { name: 'forecast', label: 'Forecast Tool', category: 'analytics', capability: 'query', description: 'Backtested projections with uncertainty ranges, labelled as forecasts.' },
  { name: 'anomaly', label: 'Anomaly Tool', category: 'analytics', capability: 'query', description: 'IQR, z-score, MAD, time-series and Isolation Forest outliers.' },
  { name: 'correlation', label: 'Statistics / Python Tool', category: 'analytics', capability: 'query', description: 'Correlation, regression, percentiles via a whitelisted Python worker (JS fallback).' },
  { name: 'describe', label: 'Descriptive Statistics Tool', category: 'analytics', capability: 'query', description: 'Mean, median, percentiles, spread, skew and distribution.' },
  { name: 'compare', label: 'Comparison Tool', category: 'analytics', capability: 'query', description: 'Compare groups or periods with differences, ratios and shares.' },
  { name: 'scenario', label: 'What-if Tool', category: 'analytics', capability: 'query', description: 'Recalculate with a hypothetical change; results are labelled SIMULATED.' },
  { name: 'kpi', label: 'KPI Tool', category: 'analytics', capability: 'query', description: 'KPIs derived from column roles (totals, averages, rates, growth, completeness).' },
  { name: 'quality', label: 'Data Quality Tool', category: 'data', capability: 'query', description: 'Missing values, duplicates, invalid dates, inconsistent categories, orphaned keys.' },
  { name: 'schema', label: 'Schema Tool', category: 'data', capability: 'query', description: 'Tables, columns, types and relationships of a dataset.', endpoint: 'GET /api/analytics/:datasetId/tool/schema' },
  { name: 'profiler', label: 'Dataset Profiler', category: 'data', capability: 'query', description: 'Semantic roles, statistics and distributions per column.', endpoint: 'GET /api/analytics/:datasetId/tool/profile' },
  { name: 'validation', label: 'Validation Tool', category: 'data', capability: 'query', description: 'Check a SQL statement against schema, safety and cost rules without running it.', endpoint: 'POST /api/analytics/:datasetId/tool/validate' },
  { name: 'chart', label: 'Chart Tool', category: 'output', capability: 'chart', description: 'Automatic chart selection (line/bar/pie/scatter/histogram/stacked/KPI) and SVG/PNG export.' },
  { name: 'export', label: 'Export Tool', category: 'output', capability: 'export', description: 'CSV, Excel and analysis workbooks.' },
  { name: 'report', label: 'Report Tool', category: 'output', capability: 'report', description: 'Management report as PDF, Word, Excel or CSV with an evidence appendix.' },
  { name: 'file', label: 'File Tool', category: 'ingestion', capability: 'upload', description: 'Upload and validate CSV, Excel, JSON, SQLite, PDF, Word, PowerPoint, Markdown, text.' },
  { name: 'connector', label: 'Connector Tool', category: 'ingestion', capability: 'connect', description: 'PostgreSQL, MySQL/MariaDB and REST/GraphQL sources.' },
  { name: 'action', label: 'Action Tool', category: 'automation', capability: 'action.propose', description: 'Email / save report / webhook, only after human approval.' },
  { name: 'briefing', label: 'Executive Briefing', category: 'agent', capability: 'query', description: "Proactive 'Today's Intelligence' alerts across your datasets." },
];

function toolsFor(user) { return TOOL_CATALOG.filter((t) => can(user, t.capability)); }

function schemaTool(dataset, policy) {
  return {
    dataset: dataset.name,
    tables: (dataset.schema?.tables || []).map((t) => ({
      name: t.name, rowCount: t.rowCount, primaryKey: t.columns.filter((c) => c.primaryKey).map((c) => c.name),
      columns: t.columns.filter((c) => !isColumnDenied(policy, t.name, c.name)).map((c) => ({ name: c.name, type: c.type, primaryKey: !!c.primaryKey })),
      foreignKeys: t.foreignKeys || [],
    })),
    relationships: dataset.profile?.relationships || [],
  };
}

function profilerTool(dataset, policy) {
  const sem = dataset.profile?.semantic;
  if (!sem) return null;
  return {
    dataset: dataset.name,
    tables: sem.tables.map((t) => ({
      name: t.name, rowCount: t.rowCount,
      columns: t.columns.filter((c) => !isColumnDenied(policy, t.name, c.name)).map((c) => ({ name: c.name, role: c.role, distinct: c.stats.distinct, missing: c.stats.missing, min: c.stats.min, max: c.stats.max, avg: c.stats.avg, pii: c.pii, distribution: c.stats.distribution ? { p25: c.stats.distribution.p25, median: c.stats.distribution.median, p75: c.stats.distribution.p75, shape: c.stats.distribution.shape } : undefined })),
    })),
  };
}

function validationTool(dataset, sql) {
  const { validateSql, SQLValidationError } = require('../structured/sql.validator');
  const { extractCteNames } = require('../structured/sql.analyzer');
  try {
    const r = validateSql(String(sql || ''), dataset.schema, dataset.type);
    return { valid: true, tables: r.tablesUsed, cost: r.complexity, ctes: extractCteNames(sql) };
  } catch (err) {
    return { valid: false, error: err.message, kind: err instanceof SQLValidationError ? 'validation' : 'error', cost: err.details?.complexity };
  }
}

module.exports = { TOOL_CATALOG, toolsFor, schemaTool, profilerTool, validationTool };
