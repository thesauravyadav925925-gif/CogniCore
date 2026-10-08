require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { isPrivateIp, assertPublicUrl, findRecordArray, flattenRecord, ingestApi } = require('../../src/ingestion/api.connector');
const { ActionRegistry } = require('../../src/actions/action.registry');
const { approveAndExecute, reject } = require('../../src/actions/action.executor');
const { proposeFromChat } = require('../../src/actions/chat.action');
const { AuthRegistry } = require('../../src/security/auth.registry');
const { can, CAPABILITIES } = require('../../src/security/rbac');

test('SSRF guard blocks private/internal addresses and bad schemes', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '100.64.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:8080/x'), /private or internal/);
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data'), /private or internal/);
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /http and https/);
  await assert.rejects(() => assertPublicUrl('http://user:pw@8.8.8.8/'), /embedded credentials/);
  await assert.rejects(() => assertPublicUrl('http://internal.example/', { lookup: async () => [{ address: '10.0.0.4' }] }), /private or internal/);
  const ok = await assertPublicUrl('https://api.example.com/x', { lookup: async () => [{ address: '93.184.216.34' }] });
  assert.equal(ok.hostname, 'api.example.com');
});

test('record extraction and flattening', () => {
  const resp = { meta: { n: 1 }, data: { items: [{ id: 1, user: { name: 'A', geo: { lat: 1 } }, tags: ['x'] }, { id: 2, user: { name: 'B', geo: { lat: 2 } }, tags: [] }] } };
  assert.equal(findRecordArray(resp).length, 2);
  assert.deepEqual(flattenRecord(resp.data.items[0]), { id: 1, user_name: 'A', user_geo_lat: 1, tags: '["x"]' });
});

test('REST connector ingests an API into a queryable dataset with semantic model', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ results: Array.from({ length: 12 }, (_, i) => ({ ticket_id: i + 1, team: ['A', 'B', 'C'][i % 3], cost: 100 + i * 5, opened: `2026-01-${String(i + 1).padStart(2, '0')}` })) }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.API_CONNECTOR_ALLOW_PRIVATE = 'true';
  try {
    const { dataset, recordCount } = await ingestApi({ url: `http://127.0.0.1:${port}/tickets`, name: 'tickets_api' });
    assert.equal(recordCount, 12);
    assert.equal(dataset.status, 'ready');
    assert.equal(dataset.profile.semantic.tables[0].columns.find((c) => c.name === 'team').role, 'categorical');
    await assert.rejects(() => ingestApi({ url: `http://127.0.0.1:${port}/redir`, name: 'x' }), /redirect/);
  } finally { delete process.env.API_CONNECTOR_ALLOW_PRIVATE; server.close(); }
});

test('roles and capabilities', () => {
  assert.equal(can({ role: 'admin' }, 'anything'), true);
  assert.equal(can({ role: 'viewer' }, 'export'), false);
  assert.equal(can({ role: 'viewer' }, 'query'), true);
  assert.equal(can({ role: 'employee' }, 'upload'), false);
  assert.equal(can({ role: 'analyst' }, 'action.approve'), false);
  assert.equal(can({ role: 'manager' }, 'action.approve'), true);
  assert.deepEqual(['admin', 'manager', 'analyst', 'employee', 'viewer'].filter((r) => !CAPABILITIES[r]), []);
});

test('actions: propose -> pending -> approval by a different person -> executed (simulated outbox)', async () => {
  const analyst = AuthRegistry.createUser({ email: `an${Date.now()}@x.com`, passwordHash: 'x', name: 'An', role: 'analyst' });
  const manager = AuthRegistry.createUser({ email: `mg${Date.now()}@x.com`, passwordHash: 'x', name: 'Mg', role: 'manager' });
  const p = proposeFromChat({ question: 'Send the report to finance@corp.com', user: analyst, datasetId: null });
  assert.match(p.answer, /Please select a dataset/);
  const noEmail = proposeFromChat({ question: 'Send the report', user: analyst, datasetId: 'ds_1' });
  assert.match(noEmail.answer, /need a recipient/);
  const denied = proposeFromChat({ question: 'email a@b.com', user: { role: 'viewer', user_id: 'v' }, datasetId: 'ds' });
  assert.equal(denied.denied, true);

  const act = ActionRegistry.propose({ type: 'send_email', params: { to: ['Finance@Corp.com'], subject: 'Hi', body: 'Body' }, requestedBy: analyst.user_id });
  assert.equal(act.status, 'pending');
  assert.deepEqual(act.params.to, ['finance@corp.com']);
  await assert.rejects(() => approveAndExecute(act.action_id, analyst), /cannot approve/);
  const done = await approveAndExecute(act.action_id, manager, 'ok');
  assert.equal(done.status, 'executed');
  assert.equal(done.result.delivery, 'simulated');
  assert.equal(ActionRegistry.listOutbox(act.action_id).length, 1);
  await assert.rejects(() => approveAndExecute(act.action_id, manager), /already executed/);

  const a2 = ActionRegistry.propose({ type: 'send_email', params: { to: ['a@b.com'] }, requestedBy: manager.user_id });
  await assert.rejects(() => approveAndExecute(a2.action_id, manager), /someone other than the requester/);
  assert.equal(reject(a2.action_id, AuthRegistry.createUser({ email: `ad${Date.now()}@x.com`, passwordHash: 'x', role: 'admin' })).status, 'rejected');

  assert.throws(() => ActionRegistry.propose({ type: 'drop_database', params: {}, requestedBy: 'u' }), /Unknown action type/);
  assert.throws(() => ActionRegistry.propose({ type: 'send_email', params: { to: ['not-an-email'] }, requestedBy: 'u' }), /valid email/);
  assert.throws(() => ActionRegistry.propose({ type: 'webhook', params: { url: 'https://evil.com/x' }, requestedBy: 'u' }), /No webhooks are approved|host must be/);
});
