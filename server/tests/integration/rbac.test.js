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

async function uploadCsv(baseUrl, token, csvText, filename = 'private.csv') {
  const form = new FormData();
  form.append('file', new Blob([csvText], { type: 'text/csv' }), filename);
  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function register(baseUrl, email) {
  const res = await req(baseUrl, 'POST', '/api/auth/register', { body: { email, password: 'password123' } });
  return { token: res.body.token, user: res.body.user };
}

test('rbac: dataset isolation between users', async (t) => {
  freshDb();
  const server = startTestServer();
  t.after(() => server.close());

  const admin = await register(server.baseUrl, 'admin@rbac.test');
  const bob = await register(server.baseUrl, 'bob@rbac.test');
  const charlie = await register(server.baseUrl, 'charlie@rbac.test');

  let datasetId;

  await t.test('Bob uploads a private dataset and becomes its owner', async () => {
    const { status, body } = await uploadCsv(server.baseUrl, bob.token, 'id,secret\n1,100\n2,200\n');
    assert.equal(status, 201);
    assert.equal(body.dataset.status, 'ready');
    datasetId = body.dataset.dataset_id;
  });

  await t.test('Charlie cannot see Bob\'s dataset in the list', async () => {
    const res = await req(server.baseUrl, 'GET', '/api/datasets', { token: charlie.token });
    assert.equal(res.body.datasets.length, 0);
  });

  await t.test('Charlie is rejected accessing it directly by ID', async () => {
    const res = await req(server.baseUrl, 'GET', `/api/datasets/${datasetId}`, { token: charlie.token });
    assert.equal(res.status, 403);
  });

  await t.test('Charlie is rejected previewing it', async () => {
    const res = await req(server.baseUrl, 'GET', `/api/datasets/${datasetId}/preview`, { token: charlie.token });
    assert.equal(res.status, 403);
  });

  await t.test('Charlie is rejected querying it via chat - the permission check happens before any LLM call', async () => {
    const res = await req(server.baseUrl, 'POST', '/api/chat', {
      token: charlie.token,
      body: { question: 'what is the secret?', datasetId },
    });
    assert.equal(res.status, 403);
  });

  await t.test('Admin sees every dataset regardless of ownership', async () => {
    const res = await req(server.baseUrl, 'GET', '/api/datasets', { token: admin.token });
    assert.equal(res.body.datasets.length, 1);
  });

  await t.test('Bob shares the dataset with Charlie at "read" level', async () => {
    const res = await req(server.baseUrl, 'POST', `/api/datasets/${datasetId}/share`, {
      token: bob.token,
      body: { email: 'charlie@rbac.test', permission: 'read' },
    });
    assert.equal(res.status, 200);
  });

  await t.test('Charlie can now see and preview the dataset', async () => {
    const list = await req(server.baseUrl, 'GET', '/api/datasets', { token: charlie.token });
    assert.equal(list.body.datasets.length, 1);
    const preview = await req(server.baseUrl, 'GET', `/api/datasets/${datasetId}/preview`, { token: charlie.token });
    assert.equal(preview.status, 200);
  });

  await t.test('"read" permission does NOT grant delete - manage is a distinct level', async () => {
    const res = await req(server.baseUrl, 'DELETE', `/api/datasets/${datasetId}`, { token: charlie.token });
    assert.equal(res.status, 403);
  });

  await t.test('Bob revokes Charlie\'s access', async () => {
    const res = await req(server.baseUrl, 'DELETE', `/api/datasets/${datasetId}/share/${charlie.user.user_id}`, { token: bob.token });
    assert.equal(res.status, 200);
  });

  await t.test('Charlie loses access again after revocation', async () => {
    const res = await req(server.baseUrl, 'GET', '/api/datasets', { token: charlie.token });
    assert.equal(res.body.datasets.length, 0);
  });

  await t.test('non-admin cannot access admin routes', async () => {
    const res = await req(server.baseUrl, 'GET', '/api/admin/audit', { token: bob.token });
    assert.equal(res.status, 403);
  });

  await t.test('admin CAN access admin routes and sees a non-empty audit trail', async () => {
    const res = await req(server.baseUrl, 'GET', '/api/admin/audit', { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.entries.length > 0);
    assert.ok(res.body.entries.some((e) => e.action === 'dataset.access_denied'));
  });

  await t.test('Bob can delete his own dataset (owner has manage by default)', async () => {
    const res = await req(server.baseUrl, 'DELETE', `/api/datasets/${datasetId}`, { token: bob.token });
    assert.equal(res.status, 200);
  });
});
