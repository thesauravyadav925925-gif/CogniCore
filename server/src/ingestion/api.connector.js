/**
 * REST / GraphQL CONNECTOR (Feature 31, "APIs" ingestion)
 * Pulls JSON from an HTTP API, extracts the record array, flattens it and ingests
 * it through the normal pipeline - so the data gets the same schema detection,
 * semantic model, data-quality report, security and analytics as an upload.
 *
 * SSRF protection (fails closed): http(s) only; the host is resolved and every
 * address must be public (no loopback / private / link-local / cloud-metadata);
 * redirects are not followed; response size and time are capped; an optional
 * host allowlist (API_CONNECTOR_ALLOWED_HOSTS) narrows it further. Credentials
 * passed in headers are used for the single fetch and are NEVER stored.
 */
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');
const { ingestFile } = require('./ingestion.pipeline');

const MAX_BYTES = parseInt(process.env.API_CONNECTOR_MAX_MB || '20', 10) * 1024 * 1024;
const TIMEOUT_MS = 15000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true;
}

async function assertPublicUrl(rawUrl, { lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { throw new Error('A valid URL is required.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs are allowed.');
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not allowed; use headers instead.');
  const allow = (process.env.API_CONNECTOR_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(u.hostname.toLowerCase())) throw new Error(`Host not allowed. Approved hosts: ${allow.join(', ')}.`);
  if (process.env.API_CONNECTOR_ALLOW_PRIVATE === 'true') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('That address resolves to a private or internal network, which is blocked.');
  return u;
}

async function readLimited(res) {
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { try { await reader.cancel(); } catch (_) { /* ignore */ } throw new Error(`Response exceeds the ${MAX_BYTES / 1024 / 1024} MB limit.`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function getPath(obj, dotted) {
  return String(dotted).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** First array of objects found (breadth-first, depth-limited) - used when recordsPath is not given. */
function findRecordArray(obj, depth = 0) {
  if (Array.isArray(obj)) return obj.length && obj.every((x) => x && typeof x === 'object' && !Array.isArray(x)) ? obj : null;
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  let best = null;
  for (const v of Object.values(obj)) {
    const found = findRecordArray(v, depth + 1);
    if (found && (!best || found.length > best.length)) best = found;
  }
  return best;
}

function flattenRecord(rec, prefix = '', out = {}, depth = 0) {
  for (const [k, v] of Object.entries(rec)) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) flattenRecord(v, key, out, depth + 1);
    else out[key] = Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : v;
  }
  return out;
}

async function fetchRecords({ url, method = 'GET', headers = {}, query = null, body = null, graphql = null, recordsPath = null }) {
  const u = await assertPublicUrl(url);
  const isGql = !!graphql;
  const m = isGql ? 'POST' : String(method).toUpperCase();
  if (!['GET', 'POST'].includes(m)) throw new Error('Only GET and POST are supported.');
  const safeHeaders = { Accept: 'application/json', ...Object.fromEntries(Object.entries(headers || {}).filter(([k]) => !/^(host|content-length|connection|transfer-encoding)$/i.test(k))) };
  if (m === 'POST') safeHeaders['Content-Type'] = 'application/json';
  const res = await fetch(u.toString(), {
    method: m, headers: safeHeaders, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    body: m === 'POST' ? JSON.stringify(isGql ? { query: graphql.query, variables: graphql.variables || {} } : (body || {})) : undefined,
  });
  if (res.status >= 300 && res.status < 400) throw new Error('The API responded with a redirect, which is not followed for safety.');
  if (!res.ok) throw new Error(`The API responded with HTTP ${res.status}.`);
  const text = await readLimited(res);
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new Error('The API response was not valid JSON.'); }
  if (isGql && json.errors?.length) throw new Error(`GraphQL error: ${json.errors[0].message}`);
  const root = isGql ? json.data : json;
  const records = recordsPath ? getPath(root, recordsPath) : findRecordArray(root);
  if (!Array.isArray(records) || !records.length) throw new Error('No array of records was found in the response. Provide "recordsPath" (e.g. "data.items").');
  if (!records.every((r) => r && typeof r === 'object')) throw new Error('The records are not JSON objects.');
  return records.slice(0, 200000).map((r) => flattenRecord(r));
}

async function ingestApi({ url, name, ownerId = null, ...opts }) {
  const records = await fetchRecords({ url, ...opts });
  fs.mkdirSync(config.paths.uploads, { recursive: true });
  const file = path.join(config.paths.uploads, `${uuidv4()}.json`);
  fs.writeFileSync(file, JSON.stringify(records));
  const safeName = String(name || new URL(url).hostname).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'api_data';
  const dataset = await ingestFile({ filePath: file, originalFilename: `${safeName}.json`, ownerId });
  return { dataset, recordCount: records.length };
}

module.exports = { ingestApi, fetchRecords, assertPublicUrl, isPrivateIp, findRecordArray, flattenRecord };
