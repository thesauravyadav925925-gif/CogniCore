require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, req } = require('../helpers/testServer');
const fs = require('fs');
const path = require('path');
const config = require('../../src/config/env');

function freshDb() {
  // Each test file gets a clean slate: delete any leftover test DB before
  // the app (which creates tables on require) boots.
  try { fs.rmSync(config.paths.registryDb); } catch (_) {}
  try { fs.rmSync(config.paths.registryDb + '-wal'); } catch (_) {}
  try { fs.rmSync(config.paths.registryDb + '-shm'); } catch (_) {}
  fs.mkdirSync(config.paths.data, { recursive: true });
}

test('auth: full flow', async (t) => {
  freshDb();
  const server = startTestServer();
  t.after(() => server.close());

  await t.test('first registered user becomes admin', async () => {
    const res = await req(server.baseUrl, 'POST', '/api/auth/register', {
      body: { email: 'admin@test.com', password: 'password123' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'admin');
    assert.ok(res.body.token);
    assert.equal(res.body.user.password_hash, undefined, 'password hash must never be returned');
  });

  await t.test('second registered user gets the default "user" role', async () => {
    const res = await req(server.baseUrl, 'POST', '/api/auth/register', {
      body: { email: 'second@test.com', password: 'password123' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'user');
  });

  await t.test('duplicate email is rejected', async () => {
    const res = await req(server.baseUrl, 'POST', '/api/auth/register', {
      body: { email: 'admin@test.com', password: 'password123' },
    });
    assert.equal(res.status, 409);
  });

  await t.test('weak password is rejected', async () => {
    const res = await req(server.baseUrl, 'POST', '/api/auth/register', {
      body: { email: 'weak@test.com', password: '123' },
    });
    assert.equal(res.status, 400);
  });

  await t.test('login with wrong password fails', async () => {
    const res = await req(server.baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'admin@test.com', password: 'wrongpassword' },
    });
    assert.equal(res.status, 401);
  });

  await t.test('login with correct password succeeds', async () => {
    const res = await req(server.baseUrl, 'POST', '/api/auth/login', {
      body: { email: 'admin@test.com', password: 'password123' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  await t.test('protected route rejects request with no token', async () => {
    const res = await req(server.baseUrl, 'GET', '/api/datasets');
    assert.equal(res.status, 401);
  });

  await t.test('protected route rejects an invalid token', async () => {
    const res = await req(server.baseUrl, 'GET', '/api/datasets', { token: 'garbage.not.a.jwt' });
    assert.equal(res.status, 401);
  });

  await t.test('health endpoint stays public (no auth required)', async () => {
    const res = await req(server.baseUrl, 'GET', '/api/health');
    assert.equal(res.status, 200);
  });
});
