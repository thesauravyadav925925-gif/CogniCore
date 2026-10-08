const express = require('express');
const { getLLMProvider } = require('../../llm/model.manager');
const { asyncHandler } = require('../middleware/asyncHandler');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const llm = getLLMProvider();
  const llmHealth = await llm.healthCheck();
  res.json({
    status: 'ok',
    llmProvider: llm.name,
    llm: llmHealth,
    time: new Date().toISOString(),
  });
}));

module.exports = router;
