require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { validateUpload, sanitizeFilename } = require('../../src/security/file.validator');
const { zip } = require('../../src/report/docx.writer');
const { AuthRegistry } = require('../../src/security/auth.registry');
const { signToken, verifyToken } = require('../../src/security/auth');
const config = require('../../src/config/env');

const tmp = (name, data) => { const p = `/tmp/${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`; fs.writeFileSync(p, data); return p; };

test('file validation: content must match the claimed type', () => {
  assert.equal(validateUpload(tmp('a.csv', 'a,b\n1,2\n'), 'a.csv').kind, 'text');
  assert.equal(validateUpload(tmp('a.json', '[{"a":1}]'), 'a.json').kind, 'text');
  assert.equal(validateUpload(tmp('a.pdf', '%PDF-1.4\n...'), 'a.pdf').kind, 'pdf');
  const real = zip([{ name: 'word/document.xml', data: '<w/>' }, { name: '[Content_Types].xml', data: '<T/>' }]);
  assert.equal(validateUpload(tmp('a.docx', real), 'a.docx').kind, 'office');
  assert.equal(validateUpload(tmp('a.db', Buffer.concat([Buffer.from('SQLite format 3\u0000'), Buffer.alloc(100)])), 'a.db').kind, 'sqlite');

  assert.throws(() => validateUpload(tmp('x.csv', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)])), 'report.csv'), /Windows executable/);
  assert.throws(() => validateUpload(tmp('x.pdf', 'not a pdf at all'), 'x.pdf'), /not a PDF/);
  assert.throws(() => validateUpload(tmp('x.xlsx', 'plain text pretending'), 'x.xlsx'), /not a valid Office file/);
  assert.throws(() => validateUpload(tmp('x.xlsx', zip([{ name: 'evil.exe', data: 'x' }])), 'x.xlsx'), /not a real \.xlsx/);
  assert.throws(() => validateUpload(tmp('x.csv', Buffer.from([0, 1, 2, 0, 3, 4])), 'x.csv'), /binary/);
  assert.throws(() => validateUpload(tmp('x.db', 'nope'), 'x.db'), /not a SQLite/);
  assert.throws(() => validateUpload(tmp('x.exe', 'abc'), 'x.exe'), /Unsupported file type/);
  assert.throws(() => validateUpload(tmp('x.csv', ''), 'x.csv'), /empty/);
  assert.throws(() => validateUpload(tmp('x.json', 'hello'), 'x.json'), /does not start like JSON/);
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('a<b>:c.csv'), 'a_b_c.csv');
});

test('sessions: listed, revocable server-side, and bound to the token', () => {
  const u = AuthRegistry.createUser({ email: `s${Date.now()}@x.com`, passwordHash: 'x', name: 'S', role: 'analyst' });
  const jti = AuthRegistry.createSession({ userId: u.user_id, expiresAt: new Date(Date.now() + 86400000).toISOString(), ip: '1.2.3.4', userAgent: 'test' });
  const jti2 = AuthRegistry.createSession({ userId: u.user_id });
  const token = signToken(u, jti);
  assert.equal(verifyToken(token).jti, jti);
  assert.equal(AuthRegistry.isSessionActive(jti), true);
  assert.equal(AuthRegistry.listSessions(u.user_id).length, 2);
  assert.equal(AuthRegistry.revokeSession(jti, 'someone-else'), false, 'cannot revoke another user\'s session');
  assert.equal(AuthRegistry.revokeSession(jti, u.user_id), true);
  assert.equal(AuthRegistry.isSessionActive(jti), false);
  assert.equal(AuthRegistry.revokeSession(jti, u.user_id), false);
  assert.equal(AuthRegistry.revokeAllSessions(u.user_id, null), 1);
  assert.equal(AuthRegistry.isSessionActive(jti2), false);
  assert.equal(AuthRegistry.isSessionActive('unknown'), false);
  const expired = AuthRegistry.createSession({ userId: u.user_id, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(AuthRegistry.isSessionActive(expired), false);
});

test('production refuses weak or default signing secrets', () => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => config.assertProductionSecrets({ auth: { jwtSecret: 'CHANGE_ME_dev_only_insecure_secret' } }), /JWT_SECRET/);
    assert.throws(() => config.assertProductionSecrets({ auth: { jwtSecret: 'short' } }), /JWT_SECRET/);
    assert.equal(config.assertProductionSecrets({ auth: { jwtSecret: 'x9Kq2mP7vL4nB8tR1cW6yH3jD5fG0aZs' } }), true);
  } finally { process.env.NODE_ENV = old; }
});
