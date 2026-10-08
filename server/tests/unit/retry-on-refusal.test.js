require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ingestFile } = require('../../src/ingestion/ingestion.pipeline');
const { routeQuery } = require('../../src/core/query.router');
const fs = require('fs');

test('structured engine: retries once when the model gives up on a genuinely answerable question', async (t) => {
  const csvPath = `/tmp/retry-test-${Date.now()}.csv`;
  fs.writeFileSync(csvPath, 'name,status\nAlice,Completed\nBob,Cancelled\nCharlie,No-show\n');

  const ds = await ingestFile({ filePath: csvPath, originalFilename: 'retry_test.csv' });

  let callCount = 0;
  class FlakyLLM {
    async complete(prompt) {
      if (prompt.includes('SQL generation engine')) {
        callCount++;
        // First attempt gives up; the retry (which includes the stronger
        // nudge text) succeeds - mirrors exactly what was observed live.
        if (!prompt.includes('gave up and answered NO_QUERY_POSSIBLE')) {
          return 'NO_QUERY_POSSIBLE';
        }
        return "SELECT name FROM retry_test WHERE status IN ('Cancelled', 'No-show')";
      }
      return 'explanation';
    }
  }

  const result = await routeQuery({
    question: 'Which people have a Cancelled or No-show status?',
    datasetIds: [ds.dataset_id],
    session: { active_dataset_id: null },
    llmProvider: new FlakyLLM(),
    embeddingProvider: null,
    conversationContext: '',
  });

  assert.equal(callCount, 2, 'expected exactly one retry (two total generation attempts)');
  assert.ok(result.evidence, 'the retry should have produced usable evidence instead of giving up');
  assert.equal(result.evidence.row_count, 2);

  fs.rmSync(csvPath, { force: true });
});

test('structured engine: still gives an honest answer if the retry also gives up', async (t) => {
  const csvPath = `/tmp/retry-test2-${Date.now()}.csv`;
  fs.writeFileSync(csvPath, 'name,status\nAlice,Completed\n');
  const ds = await ingestFile({ filePath: csvPath, originalFilename: 'retry_test2.csv' });

  class AlwaysGivesUpLLM {
    async complete(prompt) {
      if (prompt.includes('SQL generation engine')) return 'NO_QUERY_POSSIBLE';
      return 'x';
    }
  }

  const result = await routeQuery({
    question: 'something genuinely unanswerable',
    datasetIds: [ds.dataset_id],
    session: { active_dataset_id: null },
    llmProvider: new AlwaysGivesUpLLM(),
    embeddingProvider: null,
    conversationContext: '',
  });

  assert.equal(result.evidence, null);
  assert.ok(result.answer.includes("don't have enough information"));

  fs.rmSync(csvPath, { force: true });
});
