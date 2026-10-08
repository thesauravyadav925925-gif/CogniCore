const path = require('path');
const XLSX = require('xlsx');
const { DataSourceAdapter } = require('./base.adapter');
const { loadRowsIntoSqlite } = require('./tabular.loader');
const { SQLiteAdapter } = require('./sqlite.adapter');
const config = require('../../config/env');

class ExcelAdapter extends DataSourceAdapter {
  /** One SQLite table per worksheet - keeps multi-sheet workbooks fully queryable. */
  async ingest() {
    const workbook = XLSX.readFile(this.location, { cellDates: true });
    const dbPath = path.join(config.paths.data, `${this.datasetId}.db`);

    const allTables = [];
    let combinedProfile = { sheets: {} };

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
      if (!rows.length) continue; // skip empty sheets

      const tableName = sanitizeTableName(sheetName);
      const { schema, profile } = loadRowsIntoSqlite({ dbPath, tableName, rows });
      allTables.push(...schema.tables);
      combinedProfile.sheets[sheetName] = profile;
    }

    if (allTables.length === 0) {
      throw new Error('Workbook contains no non-empty sheets.');
    }

    this.internalDbPath = dbPath;
    this._delegate = new SQLiteAdapter({ datasetId: this.datasetId, location: dbPath });
    return { schema: { tables: allTables }, profile: combinedProfile, internalDbPath: dbPath };
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
  let clean = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(clean)) clean = 't_' + clean;
  return clean || 'sheet';
}

module.exports = { ExcelAdapter };
