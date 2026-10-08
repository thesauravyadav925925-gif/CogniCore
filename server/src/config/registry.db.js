/**
 * Shared lazy accessor for the registry SQLite file. Modules that keep their own tables
 * in the registry (data policies, org knowledge, actions) call getDb() on first use
 * instead of opening a connection at import time.
 */
const Database = require('better-sqlite3');
const config = require('./env');

const cache = new Map(); // path -> { db, inits:Set }

function getRegistryDb(initKey, initFn) {
  const file = config.paths.registryDb;
  let entry = cache.get(file);
  if (!entry) {
    require('fs').mkdirSync(require('path').dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    entry = { db, inits: new Set() };
    cache.set(file, entry);
  }
  if (initKey && !entry.inits.has(initKey)) { initFn(entry.db); entry.inits.add(initKey); }
  return entry.db;
}

module.exports = { getRegistryDb };
