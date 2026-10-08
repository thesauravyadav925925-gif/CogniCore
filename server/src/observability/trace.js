/**
 * AI TRACE (blueprint #25: observability)
 * Records what the AI actually did for one request - intent, plan, tools, SQL, validation,
 * timings - so it can be shown to the user ("AI Activity") and audited. Steps hold short
 * descriptions only; row data is never stored in a trace.
 */
const { getRegistryDb } = require('../config/registry.db');
const { v4: uuidv4 } = require('uuid');

const DDL = `
  CREATE TABLE IF NOT EXISTS ai_traces (
    trace_id TEXT PRIMARY KEY, session_id TEXT, user_id TEXT, question TEXT, route TEXT, tool TEXT,
    status TEXT, total_ms INTEGER, steps_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trace_user ON ai_traces(user_id, created_at);
`;
const db = () => getRegistryDb('ai_traces', (d) => d.exec(DDL));

class Trace {
  constructor({ question, userId = null, sessionId = null } = {}) {
    this.id = 'tr_' + uuidv4().slice(0, 8);
    this.question = String(question || '').slice(0, 500);
    this.userId = userId; this.sessionId = sessionId;
    this.startedAt = Date.now();
    this.steps = [];
  }
  /** status: ok | warn | error | blocked | skipped */
  add(name, status = 'ok', detail = '', extra = {}) {
    this.steps.push({ n: this.steps.length + 1, name, status, detail: String(detail ?? '').slice(0, 400), at_ms: Date.now() - this.startedAt, ...extra });
    return this;
  }
  addAll(steps = []) { steps.forEach((s) => this.add(s.name, s.status, s.detail, s.ms !== undefined ? { step_ms: s.ms } : {})); return this; }
  async time(name, fn, detailFn = () => '') {
    const t0 = Date.now();
    try { const r = await fn(); this.add(name, 'ok', detailFn(r), { step_ms: Date.now() - t0 }); return r; }
    catch (e) { this.add(name, 'error', e.message, { step_ms: Date.now() - t0 }); throw e; }
  }
  finish({ route = null, tool = null, status = 'ok' } = {}) {
    return { trace_id: this.id, session_id: this.sessionId, user_id: this.userId, question: this.question, route, tool, status, total_ms: Date.now() - this.startedAt, steps: this.steps, created_at: new Date().toISOString() };
  }
}

const TraceStore = {
  save(t) {
    try {
      db().prepare(`INSERT OR REPLACE INTO ai_traces VALUES (?,?,?,?,?,?,?,?,?,?)`).run(t.trace_id, t.session_id, t.user_id, t.question, t.route, t.tool, t.status, t.total_ms, JSON.stringify(t.steps), t.created_at);
    } catch (_) { /* tracing must never break a request */ }
  },
  list({ userId = null, limit = 50 } = {}) {
    const rows = userId
      ? db().prepare(`SELECT * FROM ai_traces WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all(userId, limit)
      : db().prepare(`SELECT * FROM ai_traces ORDER BY created_at DESC LIMIT ?`).all(limit);
    return rows.map((r) => ({ ...r, steps: JSON.parse(r.steps_json), steps_json: undefined }));
  },
  get(id) {
    const r = db().prepare(`SELECT * FROM ai_traces WHERE trace_id = ?`).get(id);
    return r ? { ...r, steps: JSON.parse(r.steps_json), steps_json: undefined } : null;
  },
};

module.exports = { Trace, TraceStore };
