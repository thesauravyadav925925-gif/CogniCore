require('./testEnv');
const { createApp } = require('../../src/app');

/** Starts the real app on a random free port. Caller must close() it after. */
function startTestServer() {
  const app = createApp();
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Small fetch wrapper that always parses JSON and never throws on non-2xx. */
async function req(baseUrl, method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON response, fine */ }
  return { status: res.status, body: json, headers: res.headers };
}

module.exports = { startTestServer, req };
