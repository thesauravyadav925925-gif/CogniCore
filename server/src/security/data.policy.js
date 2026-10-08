/**
 * DATA-LEVEL SECURITY (Features 22 & 23)
 * Enforced in plain code AFTER the SQL is generated and BEFORE it runs - the
 * LLM is never the security layer. Two policy kinds, per dataset and per role
 * (or '*' for everyone):
 *   deny_column : the role may not reference this column at all
 *   row_filter  : the role only sees rows where <column> <op> <value>; the value
 *                 may use {{user.email}}, {{user.user_id}}, {{user.name}}, {{user.role}}
 * Row filters are applied by shadowing the table with a filtered CTE, so the
 * user's query (and any JOIN in it) can only ever see permitted rows.
 * Fails CLOSED: unsupported combinations (row filters on MySQL) deny access.
 */
const { getRegistryDb } = require('../config/registry.db');
const { v4: uuidv4 } = require('uuid');
const { tokenize } = require('../structured/sql.analyzer');
const { isSqliteBacked } = require('../utils/sqlident');

const DDL = `
  CREATE TABLE IF NOT EXISTS data_policies (
    policy_id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    role TEXT NOT NULL,            -- admin | manager | analyst | employee | viewer | user | *
    kind TEXT NOT NULL,            -- deny_column | row_filter
    table_name TEXT,               -- optional: restrict to one table
    column_name TEXT NOT NULL,
    op TEXT,                       -- = | != | IN   (row_filter)
    value TEXT,                    -- literal or {{user.*}} template (row_filter)
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_policy_dataset ON data_policies(dataset_id);
`;
const getDb = () => getRegistryDb('policies', (d) => d.exec(DDL));

class PolicyError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'PolicyError'; this.details = details; this.status = 403; }
}

const lc = (s) => String(s).toLowerCase();

const PolicyStore = {
  add({ datasetId, role = '*', kind, tableName = null, columnName, op = null, value = null, createdBy = null }) {
    if (!['deny_column', 'row_filter'].includes(kind)) throw new Error('kind must be deny_column or row_filter');
    if (!columnName) throw new Error('columnName is required');
    if (kind === 'row_filter' && !['=', '!=', 'IN'].includes(op)) throw new Error('row_filter op must be =, != or IN');
    if (kind === 'row_filter' && (value === null || value === undefined)) throw new Error('row_filter requires a value');
    const id = 'pol_' + uuidv4().slice(0, 8);
    getDb().prepare(`INSERT INTO data_policies VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, datasetId, role, kind, tableName, columnName, op, value === null ? null : String(value), createdBy, new Date().toISOString());
    return id;
  },
  list(datasetId) { return getDb().prepare(`SELECT * FROM data_policies WHERE dataset_id = ? ORDER BY created_at`).all(datasetId); },
  remove(policyId) { getDb().prepare(`DELETE FROM data_policies WHERE policy_id = ?`).run(policyId); },
  removeForDataset(datasetId) { getDb().prepare(`DELETE FROM data_policies WHERE dataset_id = ?`).run(datasetId); },
};

/** Effective policy for a user on a dataset. Admins are never restricted. */
function resolvePolicy({ datasetId, user }) {
  if (!user || user.role === 'admin') return { deniedColumns: [], rowFilters: [] };
  const rows = PolicyStore.list(datasetId).filter((p) => p.role === '*' || p.role === user.role);
  const sub = (v) => String(v).replace(/\{\{\s*user\.(\w+)\s*\}\}/g, (_, k) => (user[k] ?? ''));
  return {
    deniedColumns: rows.filter((p) => p.kind === 'deny_column').map((p) => ({ table: p.table_name, column: p.column_name })),
    rowFilters: rows.filter((p) => p.kind === 'row_filter').map((p) => ({ table: p.table_name, column: p.column_name, op: p.op, value: sub(p.value) })),
  };
}

/** Throws PolicyError if the SQL references a denied column (directly, via alias, or via SELECT *). */
function assertColumnAccess(sql, schema, policy) {
  if (!policy?.deniedColumns?.length) return;
  const tokens = tokenize(sql);
  const used = new Set();
  tokens.forEach((t, i) => {
    if ((t.t === 'word' || t.t === 'qid') && (tokens[i - 1]?.v === 'from' || /^(from|join)$/i.test(tokens[i - 1]?.v || ''))) used.add(lc(t.v));
  });
  const usedTables = schema.tables.filter((t) => used.has(lc(t.name)));
  const scope = usedTables.length ? usedTables : schema.tables;

  const denied = policy.deniedColumns.filter((d) => !d.table || scope.some((t) => lc(t.name) === lc(d.table)));
  if (!denied.length) return;

  const hasStar = tokens.some((t, i) => t.v === '*' && t.t === 'p' && (!tokens[i - 1] || tokens[i - 1].v !== '(') && !/^count$/i.test(tokens[i - 2]?.v || ''));
  if (hasStar) {
    const cols = denied.map((d) => d.column).join(', ');
    throw new PolicyError(`Your role cannot access the restricted column(s): ${cols}. Ask for specific columns instead of "all columns".`, { columns: denied.map((d) => d.column) });
  }
  const deniedNames = new Set(denied.map((d) => lc(d.column)));
  for (const t of tokens) {
    if ((t.t === 'word' || t.t === 'qid') && deniedNames.has(lc(t.v))) {
      throw new PolicyError(`Your role does not have access to the column "${t.v}".`, { column: t.v });
    }
  }
}

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Wraps permitted tables in filtered CTEs. Returns possibly-rewritten SQL. */
function applyRowFilters(sql, schema, policy, datasetType) {
  const filters = policy?.rowFilters || [];
  if (!filters.length) return sql;
  const referenced = new Set(tokenize(sql).filter((t) => t.t === 'word' || t.t === 'qid').map((t) => lc(t.v)));
  const byTable = new Map();
  for (const t of schema.tables) {
    const rel = filters.filter((f) => (!f.table || lc(f.table) === lc(t.name)) && t.columns.some((c) => lc(c.name) === lc(f.column)));
    if (rel.length && referenced.has(lc(t.name))) byTable.set(t, rel);
  }
  if (!byTable.size) return sql;
  if (datasetType === 'mysql') throw new PolicyError('Row-level restrictions are not supported on MySQL connections; access denied to protect restricted rows.');

  const ctes = [];
  for (const [table, rels] of byTable) {
    const conds = rels.map((f) => {
      const col = `"${table.columns.find((c) => lc(c.name) === lc(f.column)).name.replace(/"/g, '""')}"`;
      if (f.op === 'IN') return `${col} IN (${String(f.value).split(',').map((v) => sqlStr(v.trim())).join(', ')})`;
      return `${col} ${f.op === '!=' ? '<>' : '='} ${sqlStr(f.value)}`;
    });
    const base = isSqliteBacked(datasetType) ? `main."${table.name.replace(/"/g, '""')}"` : `"${table.name.replace(/"/g, '""')}"`;
    ctes.push(`"${table.name.replace(/"/g, '""')}" AS (SELECT * FROM ${base} WHERE ${conds.join(' AND ')})`);
  }
  const trimmed = sql.trim();
  const m = trimmed.match(/^WITH\s+(RECURSIVE\s+)?/i);
  if (m) return `WITH ${m[1] || ''}${ctes.join(', ')}, ${trimmed.slice(m[0].length)}`;
  return `WITH ${ctes.join(', ')} ${trimmed}`;
}

/** Convenience: enforce everything, return the SQL that is safe to execute. */
function enforcePolicy({ sql, schema, policy, datasetType }) {
  assertColumnAccess(sql, schema, policy);
  return applyRowFilters(sql, schema, policy, datasetType);
}

module.exports = { PolicyStore, PolicyError, resolvePolicy, assertColumnAccess, applyRowFilters, enforcePolicy };
