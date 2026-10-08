const Database = require('better-sqlite3');
const { DataSourceAdapter } = require('./base.adapter');
const config = require('../../config/env');

/** Reserved SQLite system tables we should never surface as "domain" tables. */
const SYSTEM_TABLES = new Set(['sqlite_sequence', 'sqlite_stat1', 'sqlite_stat4']);

class SQLiteAdapter extends DataSourceAdapter {
  async connect() {
    this.db = new Database(this.location, { readonly: false, fileMustExist: true });
    this.db.pragma('journal_mode = WAL');
    return this;
  }

  async disconnect() {
    if (this.db) this.db.close();
  }

  async getSchema() {
    const tableRows = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all();

    const tables = [];
    for (const { name } of tableRows) {
      if (SYSTEM_TABLES.has(name)) continue;
      const columnsRaw = this.db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all();
      const fkRaw = this.db.prepare(`PRAGMA foreign_key_list(${quoteIdent(name)})`).all();
      let rowCount = 0;
      try {
        rowCount = this.db.prepare(`SELECT COUNT(*) as c FROM ${quoteIdent(name)}`).get().c;
      } catch (_) { /* ignore */ }

      tables.push({
        name,
        rowCount,
        columns: columnsRaw.map(c => ({
          name: c.name,
          type: c.type || 'UNKNOWN',
          nullable: c.notnull === 0,
          primaryKey: c.pk > 0,
        })),
        foreignKeys: fkRaw.map(fk => ({
          column: fk.from,
          referencesTable: fk.table,
          referencesColumn: fk.to,
        })),
      });
    }
    return { tables };
  }

  async getMetadata() {
    const schema = await this.getSchema();
    return {
      tableCount: schema.tables.length,
      totalRows: schema.tables.reduce((sum, t) => sum + t.rowCount, 0),
    };
  }

  async preview(tableName, limit = 10) {
    assertValidIdentifier(tableName);
    const rows = this.db.prepare(`SELECT * FROM ${quoteIdent(tableName)} LIMIT ?`).all(limit);
    return { columns: rows.length ? Object.keys(rows[0]) : [], rows };
  }

  async executeQuery(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const rows = params.length ? stmt.all(...params) : stmt.all();
    return { columns: rows.length ? Object.keys(rows[0]) : [], rows };
  }

  async validateQuery(sql) {
    // Deeper AST validation happens in structured/sql.validator.js (shared, engine-agnostic).
    return { valid: true };
  }
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function assertValidIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
}

module.exports = { SQLiteAdapter };
