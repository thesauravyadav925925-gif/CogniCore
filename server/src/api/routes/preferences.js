const express = require('express');
const { requireAuth } = require('../../security/rbac');
const { Preferences } = require('../../memory/preferences.store');

const router = express.Router();
router.use(requireAuth);
router.get('/', (req, res) => res.json({ preferences: Preferences.get(req.user.user_id), options: Object.fromEntries(Object.entries(Preferences.SCHEMA).map(([k, v]) => [k, v.values])) }));
router.put('/', (req, res) => {
  try { res.json({ preferences: Preferences.set(req.user.user_id, req.body || {}) }); } catch (e) { res.status(400).json({ error: true, message: e.message }); }
});
module.exports = router;
