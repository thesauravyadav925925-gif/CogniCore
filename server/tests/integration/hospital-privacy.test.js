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

async function register(baseUrl, email) {
  const res = await req(baseUrl, 'POST', '/api/auth/register', { body: { email, password: 'password123' } });
  return { token: res.body.token, user: res.body.user };
}

/**
 * HOSPITAL PRIVACY SCENARIO
 * This is the scenario that matters most for a real hospital deployment:
 * a doctor uploads patient records containing diagnoses, and an unrelated
 * staff member (e.g. a receptionist with no clinical need-to-know) must
 * NOT be able to see them, while a nurse explicitly granted access should
 * be able to view but not delete records. This directly exercises Rule #9
 * ("enforce permissions outside the LLM") against genuinely sensitive
 * data, not a toy example.
 */
test('rbac: patient data privacy (hospital scenario)', async (t) => {
  freshDb();
  const server = startTestServer();
  t.after(() => server.close());

  const doctor = await register(server.baseUrl, 'doctor@hospital.test');
  const nurse = await register(server.baseUrl, 'nurse@hospital.test');
  const receptionist = await register(server.baseUrl, 'receptionist@hospital.test');

  let datasetId;

  await t.test('doctor uploads patient records', async () => {
    const patientsJson = JSON.stringify([
      { patient_id: 1, name: 'Sunita Rao', diagnosis: 'Type 2 Diabetes' },
      { patient_id: 2, name: 'Vikram Nair', diagnosis: 'Hypertension' },
    ]);
    const form = new FormData();
    form.append('file', new Blob([patientsJson], { type: 'application/json' }), 'patients.json');
    const res = await fetch(`${server.baseUrl}/api/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${doctor.token}` }, body: form,
    });
    const body = await res.json();
    assert.equal(res.status, 201);
    datasetId = body.dataset.dataset_id;
  });

  await t.test('receptionist (no clinical need-to-know) sees NOTHING - not even that the dataset exists', async () => {
    const list = await req(server.baseUrl, 'GET', '/api/datasets', { token: receptionist.token });
    assert.equal(list.body.datasets.length, 0);
    const direct = await req(server.baseUrl, 'GET', `/api/datasets/${datasetId}`, { token: receptionist.token });
    assert.equal(direct.status, 403);
  });

  await t.test('receptionist cannot query patient diagnoses via chat either', async () => {
    const res = await req(server.baseUrl, 'POST', '/api/chat', {
      token: receptionist.token,
      body: { question: 'what conditions do the patients have?', datasetId },
    });
    assert.equal(res.status, 403);
  });

  await t.test('doctor grants the nurse read access', async () => {
    const res = await req(server.baseUrl, 'POST', `/api/datasets/${datasetId}/share`, {
      token: doctor.token,
      body: { email: 'nurse@hospital.test', permission: 'read' },
    });
    assert.equal(res.status, 200);
  });

  await t.test('nurse can now view patient records', async () => {
    const res = await req(server.baseUrl, 'GET', `/api/datasets/${datasetId}/preview`, { token: nurse.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.rows.length, 2);
  });

  await t.test('nurse CANNOT delete patient records - viewing is not the same as managing sensitive data', async () => {
    const res = await req(server.baseUrl, 'DELETE', `/api/datasets/${datasetId}`, { token: nurse.token });
    assert.equal(res.status, 403);
  });

  await t.test('a direct SQL injection attempt against patient records is blocked even via the tools endpoint (not just chat)', async () => {
    const res = await req(server.baseUrl, 'POST', '/api/tools/export', {
      token: doctor.token,
      body: { datasetId, sql: 'DELETE FROM patients WHERE 1=1', format: 'csv' },
    });
    assert.equal(res.status, 500);
    assert.ok(res.body.message.includes('DELETE'));
  });

  await t.test('doctor (owner) can still delete their own data', async () => {
    const res = await req(server.baseUrl, 'DELETE', `/api/datasets/${datasetId}`, { token: doctor.token });
    assert.equal(res.status, 200);
  });
});
