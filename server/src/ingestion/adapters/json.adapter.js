const fs = require('fs');
const path = require('path');
const { DataSourceAdapter } = require('./base.adapter');
const { loadRowsIntoSqlite } = require('./tabular.loader');
const { SQLiteAdapter } = require('./sqlite.adapter');
const config = require('../../config/env');

class JSONAdapter extends DataSourceAdapter {
  /**
   * Supports two shapes:
   *   1. A flat array of objects -> one table named after the file.
   *   2. An object whose values are arrays of objects -> one table per key
   *      (mirrors ExcelAdapter's one-table-per-sheet behaviour).
   */
  async ingest(nameHint = 'data') {
    const raw = fs.readFileSync(this.location, 'utf8');
    const parsed = JSON.parse(raw);
    const dbPath = path.join(config.paths.data, `${this.datasetId}.db`);

    const allTables = [];
    const profile = {};

    if (Array.isArray(parsed)) {
      const tableName = sanitizeTableName(nameHint);
      const { schema, profile: p } = loadRowsIntoSqlite({ dbPath, tableName, rows: parsed });
      allTables.push(...schema.tables);
      profile[tableName] = p;
    } else if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        if (!Array.isArray(value) || value.length === 0) continue;
        const tableName = sanitizeTableName(key);
        const { schema, profile: p } = loadRowsIntoSqlite({ dbPath, tableName, rows: value });
        allTables.push(...schema.tables);
        profile[tableName] = p;
      }
    }

    if (allTables.length === 0) {
      throw new Error('JSON file must be either an array of objects, or an object mapping names to arrays of objects.');
    }

    this._delegate = new SQLiteAdapter({ datasetId: this.datasetId, location: dbPath });
    return { schema: { tables: allTables }, profile, internalDbPath: dbPath };
  }

  async connect() {
    if (!this._delegate) {
      const dbPath = path.join(config.paths.data, `${this.datasetId}.db`);
      this._delegate = new SQLiteAdapter({ datasetId: this.datasetId, location: dbPath });
    }
    return this._delegate.connect();
  }

  async disconnect() { return this._delegate?.disconnect(); }
  async getSchema() { return this._delegate.getSchema(); }
  async getMetadata() { return this._delegate.getMetadata(); }
  async preview(tableName, limit) { return this._delegate.preview(tableName, limit); }
  async executeQuery(sql, params) { return this._delegate.executeQuery(sql, params); }
  async validateQuery(sql) { return this._delegate.validateQuery(sql); }
}

function sanitizeTableName(name) {
  let clean = path.basename(String(name), path.extname(String(name))).replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(clean)) clean = 't_' + clean;
  return clean || 'data';
}

module.exports = { JSONAdapter };
