const { Pool } = require('pg');
const { DataSourceAdapter } = require('./base.adapter');
const { DatasetRegistry } = require('../dataset.registry');

/**
 * PostgresAdapter
 * `this.location` for connection-based datasets is a SANITIZED display
 * string only (no password). Real credentials are pulled separately from
 * DatasetRegistry.getCredentials() - never stored on the adapter as plain
 * config passed around the app.
 */
class PostgresAdapter extends DataSourceAdapter {
  async connect() {
    const creds = DatasetRegistry.getCredentials(this.datasetId);
    if (!creds) throw new Error('No connection credentials found for this dataset.');

    this.pool = new Pool({
      host: creds.host,
      port: creds.port || 5432,
      database: creds.database,
      user: creds.user,
      password: creds.password,
      ssl: creds.ssl ? { rejectUnauthorized: false } : false,
      max: 3,
      connectionTimeoutMillis: 8000,
    });
    // Fail fast if unreachable rather than lazily on first query.
    const client = await this.pool.connect();
    client.release();
    return this;
  }

  async disconnect() {
    if (this.pool) await this.pool.end();
  }

  async getSchema() {
    const tablesRes = await this.pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const tables = [];
    for (const { table_name } of tablesRes.rows) {
      const colsRes = await this.pool.query(`
        SELECT c.column_name, c.data_type, c.is_nullable,
               (pk.column_name IS NOT NULL) AS is_primary_key
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 AND tc.table_schema = 'public'
        ) pk ON pk.column_name = c.column_name
        WHERE c.table_schema = 'public' AND c.table_name = $1
        ORDER BY c.ordinal_position
      `, [table_name]);

      const fkRes = await this.pool.query(`
        SELECT kcu.column_name, ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1 AND tc.table_schema = 'public'
      `, [table_name]);

      let rowCount = 0;
      try {
        const countRes = await this.pool.query(`SELECT COUNT(*)::int AS c FROM ${quoteIdent(table_name)}`);
        rowCount = countRes.rows[0].c;
      } catch (_) { /* ignore */ }

      tables.push({
        name: table_name,
        rowCount,
        columns: colsRes.rows.map(c => ({
          name: c.column_name,
          type: c.data_type.toUpperCase(),
          nullable: c.is_nullable === 'YES',
          primaryKey: c.is_primary_key,
        })),
        foreignKeys: fkRes.rows.map(fk => ({
          column: fk.column_name,
          referencesTable: fk.referenced_table,
          referencesColumn: fk.referenced_column,
        })),
      });
    }
    return { tables };
  }

  async getMetadata() {
    const schema = await this.getSchema();
    return { tableCount: schema.tables.length, totalRows: schema.tables.reduce((s, t) => s + t.rowCount, 0) };
  }

  async preview(tableName, limit = 10) {
    assertValidIdentifier(tableName);
    const res = await this.pool.query(`SELECT * FROM ${quoteIdent(tableName)} LIMIT $1`, [limit]);
    return { columns: res.fields.map(f => f.name), rows: res.rows };
  }

  async executeQuery(sql) {
    const res = await this.pool.query(sql);
    return { columns: res.fields.map(f => f.name), rows: res.rows };
  }

  async validateQuery() {
    return { valid: true };
  }
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function assertValidIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid identifier: ${name}`);
}

/** Quick reachability + credential check, used by the /connect endpoint before registering. */
async function testPostgresConnection(creds) {
  const pool = new Pool({
    host: creds.host,
    port: creds.port || 5432,
    database: creds.database,
    user: creds.user,
    password: creds.password,
    ssl: creds.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
  });
  try {
    const client = await pool.connect();
    client.release();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await pool.end();
  }
}

module.exports = { PostgresAdapter, testPostgresConnection };
