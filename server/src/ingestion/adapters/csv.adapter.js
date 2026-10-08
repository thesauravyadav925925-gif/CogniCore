const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { DataSourceAdapter } = require('./base.adapter');
const { loadRowsIntoSqlite } = require('./tabular.loader');
const { SQLiteAdapter } = require('./sqlite.adapter');
const config = require('../../config/env');

class CSVAdapter extends DataSourceAdapter {
  /**
   * Parses the CSV and materializes it into a per-dataset SQLite file,
   * then delegates actual querying to an internal SQLiteAdapter so the
   * rest of the system shares one query path (Common Query Layer).
   */
  async ingest(tableNameHint = 'data') {
    const raw = fs.readFileSync(this.location, 'utf8');
    const rows = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    const dbPath = path.join(config.paths.data, `${this.datasetId}.db`);
    const tableName = sanitizeTableName(tableNameHint);
    const { schema, profile } = loadRowsIntoSqlite({ dbPath, tableName, rows });

    this.internalDbPath = dbPath;
    this._delegate = new SQLiteAdapter({ datasetId: this.datasetId, location: dbPath });
    return { schema, profile, internalDbPath: dbPath };
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
  let clean = path.basename(name, path.extname(name)).replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(clean)) clean = 't_' + clean;
  return clean || 'data';
}

module.exports = { CSVAdapter };
