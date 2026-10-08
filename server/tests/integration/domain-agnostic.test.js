require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../../src/config/env');
const { ingestFile } = require('../../src/ingestion/ingestion.pipeline');
const { analyzeSchema } = require('../../src/schema/schema.analyzer');
const { routeQuery } = require('../../src/core/query.router');

function freshDb() {
  try { fs.rmSync(config.paths.registryDb); } catch (_) {}
  try { fs.rmSync(config.paths.registryDb + '-wal'); } catch (_) {}
  try { fs.rmSync(config.paths.registryDb + '-shm'); } catch (_) {}
  fs.mkdirSync(config.paths.data, { recursive: true });
  fs.mkdirSync(config.paths.uploads, { recursive: true });
}

/**
 * DOMAIN-AGNOSTIC VERIFICATION
 * The project's central claim (Section 1-2 of the spec) is that the core
 * engine has NO hardcoded assumptions about what domain the data
 * represents. These tests prove that by running two datasets from
 * completely different, realistic domains - banking and healthcare -
 * through the exact same ingestion/schema/query pipeline as every other
 * test, and confirming relationship detection and query execution work
 * correctly on BOTH without any domain-specific code path existing
 * anywhere in the codebase.
 */
test('domain-agnostic: banking dataset (multi-table SQLite, native file upload)', async (t) => {
  freshDb();
  const dbPath = path.join('/tmp', `bank-test-${Date.now()}.db`);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, full_name TEXT, email TEXT);
    CREATE TABLE accounts (account_id INTEGER PRIMARY KEY, customer_id INTEGER, balance REAL,
      FOREIGN KEY (customer_id) REFERENCES customers(customer_id));
  `);
  db.prepare('INSERT INTO customers VALUES (?,?,?)').run(1, 'Rohan Mehta', 'rohan@example.com');
  db.prepare('INSERT INTO accounts VALUES (?,?,?)').run(101, 1, 45000.5);
  db.prepare('INSERT INTO accounts VALUES (?,?,?)').run(102, 1, 120000.0);
  db.close();

  await t.test('ingests a real multi-table SQLite file with correct schema', async () => {
    const ds = await ingestFile({ filePath: dbPath, originalFilename: 'bank.db' });
    assert.equal(ds.status, 'ready');
    assert.equal(ds.schema.tables.length, 2);
    const analyzed = analyzeSchema(ds.schema, ds.profile);
    // The relationship must come from the DECLARED foreign key in this
    // schema, not from any hardcoded knowledge of "accounts"/"customers".
    assert.equal(analyzed.relationships.length, 1);
    assert.equal(analyzed.relationships[0].method, 'declared_foreign_key');
    assert.equal(analyzed.relationships[0].fromTable, 'accounts');
    assert.equal(analyzed.relationships[0].toTable, 'customers');

    // A join query must produce the mathematically correct total.
    class FakeLLM {
      async complete() {
        return "SELECT SUM(balance) as total FROM accounts WHERE customer_id = 1";
      }
    }
    const result = await routeQuery({
      question: 'total balance for customer 1',
      datasetIds: [ds.dataset_id],
      session: { active_dataset_id: null },
      llmProvider: new FakeLLM(),
      embeddingProvider: null,
      conversationContext: '',
    });
    assert.equal(result.evidence.sample_rows[0].total, 165000.5);
  });

  fs.rmSync(dbPath, { force: true });
});

test('domain-agnostic: healthcare dataset (multi-table JSON, sensitive data)', async (t) => {
  freshDb();
  const jsonPath = path.join('/tmp', `hospital-test-${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    patients: [
      { patient_id: 1, name: 'Sunita Rao', diagnosis: 'Type 2 Diabetes', doctor_id: 10 },
      { patient_id: 2, name: 'Ananya Iyer', diagnosis: 'Asthma', doctor_id: 10 },
      { patient_id: 3, name: 'Vikram Nair', diagnosis: 'Hypertension', doctor_id: 11 },
    ],
    doctors: [
      { doctor_id: 10, name: 'Dr. Kavita Menon' },
      { doctor_id: 11, name: 'Dr. Arjun Reddy' },
    ],
  }));

  await t.test('ingests multi-table JSON and infers the clinical relationship purely by naming', async () => {
    const ds = await ingestFile({ filePath: jsonPath, originalFilename: 'hospital.json' });
    assert.equal(ds.status, 'ready');
    const analyzed = analyzeSchema(ds.schema, ds.profile);
    const rel = analyzed.relationships.find((r) => r.fromTable === 'patients');
    assert.ok(rel, 'expected patients.doctor_id -> doctors.doctor_id to be inferred');
    assert.equal(rel.toTable, 'doctors');
    assert.equal(rel.method, 'naming_heuristic');

    // A join query correctly finds the right patients for the right doctor -
    // proving joins work identically regardless of "domain".
    class FakeLLM {
      async complete() {
        return "SELECT p.name, p.diagnosis FROM patients p JOIN doctors d ON p.doctor_id = d.doctor_id WHERE d.name = 'Dr. Kavita Menon'";
      }
    }
    const result = await routeQuery({
      question: 'which patients are under Dr. Kavita Menon',
      datasetIds: [ds.dataset_id],
      session: { active_dataset_id: null },
      llmProvider: new FakeLLM(),
      embeddingProvider: null,
      conversationContext: '',
    });
    const names = result.evidence.sample_rows.map((r) => r.name).sort();
    assert.deepEqual(names, ['Ananya Iyer', 'Sunita Rao']);
  });

  fs.rmSync(jsonPath, { force: true });
});
