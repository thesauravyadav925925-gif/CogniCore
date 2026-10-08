require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startTestServer, req } = require('../helpers/testServer');
const config = require('../../src/config/env');

function freshDb() {
  try { fs.rmSync(config.paths.registryDb); } catch (_) {}
  try { fs.rmSync(config.paths.registryDb + '-wal'); } catch (_) {}
  try { fs.rmSync(config.paths.registryDb + '-shm'); } catch (_) {}
  fs.mkdirSync(config.paths.data, { recursive: true });
  fs.mkdirSync(config.paths.uploads, { recursive: true });
}

test('ingestion: CSV upload, schema discovery, relationship inference, preview', async (t) => {
  freshDb();
  const server = startTestServer();
  t.after(() => server.close());

  const { body: authBody } = await req(server.baseUrl, 'POST', '/api/auth/register', {
    body: { email: 'ingest@test.com', password: 'password123' },
  });
  const token = authBody.token;

  let datasetId;

  await t.test('uploads a multi-column CSV and discovers a correct schema', async () => {
    const csv = 'product_id,name,category_id,price\n1,Widget,10,9.99\n2,Gadget,20,19.99\n';
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'products.csv');
    const res = await fetch(`${server.baseUrl}/api/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    assert.equal(body.dataset.status, 'ready');
    assert.equal(body.dataset.schema.tables[0].columns.length, 4);
    datasetId = body.dataset.dataset_id;
  });

  await t.test('schema endpoint returns correct column types', async () => {
    const res = await req(server.baseUrl, 'GET', `/api/schema/${datasetId}`, { token });
    assert.equal(res.status, 200);
    const priceCol = res.body.schema.tables[0].columns.find((c) => c.name === 'price');
    assert.equal(priceCol.type, 'REAL');
    const idCol = res.body.schema.tables[0].columns.find((c) => c.name === 'product_id');
    assert.equal(idCol.type, 'INTEGER');
  });

  await t.test('preview endpoint returns real rows matching the upload', async () => {
    const res = await req(server.baseUrl, 'GET', `/api/datasets/${datasetId}/preview`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.rows.length, 2);
    assert.equal(res.body.rows[0].name, 'Widget');
    assert.equal(res.body.rows[1].price, 19.99);
  });

  await t.test('rejects an unsupported file type with a clear error, not a crash', async () => {
    const form = new FormData();
    form.append('file', new Blob(['not a real file']), 'weird.xyz');
    const res = await fetch(`${server.baseUrl}/api/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    assert.equal(res.status, 500); // ingestFile throws -> caught by asyncHandler -> errorHandler
    const body = await res.json();
    assert.ok(body.message.includes('Unable to determine file type'));
  });
});
