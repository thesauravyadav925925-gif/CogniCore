/**
 * DataSourceAdapter - the universal contract (Section 9 of spec).
 *
 * Every structured-data adapter (SQLite, Postgres, MySQL, CSV, Excel, JSON)
 * MUST implement this interface so the core engine never needs to know
 * where the data actually came from.
 *
 * This is an abstract base class - concrete adapters extend it.
 */
class DataSourceAdapter {
  constructor({ datasetId, location }) {
    if (new.target === DataSourceAdapter) {
      throw new Error('DataSourceAdapter is abstract and cannot be instantiated directly.');
    }
    this.datasetId = datasetId;
    this.location = location;
  }

  /** Establish a connection / open the underlying resource. */
  async connect() {
    throw new Error('connect() not implemented');
  }

  /** Close / release the underlying resource. */
  async disconnect() {
    throw new Error('disconnect() not implemented');
  }

  /**
   * Return the dynamically discovered schema:
   * { tables: [ { name, columns: [ { name, type, nullable, primaryKey } ], rowCount } ] }
   */
  async getSchema() {
    throw new Error('getSchema() not implemented');
  }

  /** Return dataset-level metadata (size, table count, etc). */
  async getMetadata() {
    throw new Error('getMetadata() not implemented');
  }

  /** Return a small preview (first N rows) of a given table. */
  async preview(tableName, limit = 10) {
    throw new Error('preview() not implemented');
  }

  /** Execute a validated, read-only query. Must return { columns, rows }. */
  async executeQuery(sql, params = []) {
    throw new Error('executeQuery() not implemented');
  }

  /** Adapter-level sanity check of a query before the shared validator runs. */
  async validateQuery(sql) {
    throw new Error('validateQuery() not implemented');
  }
}

module.exports = { DataSourceAdapter };
