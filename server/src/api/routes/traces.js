const express = require('express');
const { requireAuth } = require('../../security/rbac');
const { TraceStore } = require('../../observability/trace');

const router = express.Router();
router.use(requireAuth);

// GET /api/traces?limit=  - your own activity (admins see everyone's)
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '40', 10) || 40, 200);
  const all = req.user.role === 'admin' && req.query.scope === 'all';
  const traces = TraceStore.list({ userId: all ? null : req.user.user_id, limit });
  res.json({ traces: traces.map((t) => ({ trace_id: t.trace_id, question: t.question, route: t.route, tool: t.tool, status: t.status, total_ms: t.total_ms, created_at: t.created_at, user_id: t.user_id, step_count: t.steps.length })), scope: all ? 'all' : 'mine' });
});

router.get('/:id', (req, res) => {
  const t = TraceStore.get(req.params.id);
  if (!t || (t.user_id !== req.user.user_id && req.user.role !== 'admin')) return res.status(404).json({ error: true, message: 'Trace not found.' });
  res.json({ trace: t });
});

module.exports = router;
