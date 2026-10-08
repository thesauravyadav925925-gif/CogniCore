require('../helpers/testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { ingestFile } = require('../../src/ingestion/ingestion.pipeline');
const { routeQuery } = require('../../src/core/query.router');

test('analysis mode: multi-step plan/execute/synthesize against real data', async (t) => {
  const csvPath = `/tmp/analysis-test-${Date.now()}.csv`;
  fs.writeFileSync(csvPath,
    'appointment_id,patient_name,doctor_name,department,status\n' +
    '1,A,Dr. X,Cardiology,Completed\n' +
    '2,B,Dr. Y,Orthopedics,Completed\n' +
    '3,C,Dr. X,Cardiology,Cancelled\n' +
    '4,D,Dr. Z,Dermatology,Completed\n' +
    '5,E,Dr. Y,Orthopedics,No-show\n'
  );

  class FakeAnalysisLLM {
    async complete(prompt) {
      if (prompt.includes('data analysis planner')) {
        return JSON.stringify([
          'How many total appointments are there?',
          'What is the breakdown by status?',
        ]);
      }
      if (prompt.includes('SQL generation engine')) {
        if (prompt.includes('breakdown by status')) {
          return 'SELECT status, COUNT(*) as cnt FROM analysis_test GROUP BY status';
        }
        return 'SELECT COUNT(*) as total FROM analysis_test';
      }
      if (prompt.includes('broke a complex question')) {
        return 'There are 5 total appointments: 3 completed, 1 cancelled, 1 no-show.';
      }
      return 'x';
    }
  }

  const ds = await ingestFile({ filePath: csvPath, originalFilename: 'analysis_test.csv' });

  const result = await routeQuery({
    question: 'Give me a summary of appointment performance.',
    datasetIds: [ds.dataset_id],
    session: { active_dataset_id: null },
    llmProvider: new FakeAnalysisLLM(),
    embeddingProvider: null,
    conversationContext: '',
    analysisMode: true,
  });

  assert.equal(result.routeType, 'ANALYSIS');
  assert.equal(result.evidence.source_type, 'analysis');
  assert.equal(result.evidence.steps.length, 2);

  // Both sub-queries must have produced CORRECT results against the real data.
  const totalStep = result.evidence.steps.find((s) => s.question.includes('total'));
  assert.equal(totalStep.evidence.sample_rows[0].total, 5);

  const statusStep = result.evidence.steps.find((s) => s.question.includes('breakdown'));
  const statusMap = Object.fromEntries(statusStep.evidence.sample_rows.map((r) => [r.status, r.cnt]));
  assert.deepEqual(statusMap, { Completed: 3, Cancelled: 1, 'No-show': 1 });

  assert.ok(result.answer.length > 0);
  assert.equal(result.evidence.confidence, 1); // both steps succeeded

  fs.rmSync(csvPath, { force: true });
});

test('analysis mode: a sub-question that fails is reported, not silently dropped', async (t) => {
  const csvPath = `/tmp/analysis-test2-${Date.now()}.csv`;
  fs.writeFileSync(csvPath, 'id,val\n1,10\n2,20\n');

  class PartiallyFailingLLM {
    async complete(prompt) {
      if (prompt.includes('data analysis planner')) {
        return JSON.stringify(['What is the total?', 'What is the nonexistent_field breakdown?']);
      }
      if (prompt.includes('SQL generation engine')) {
        if (prompt.includes('nonexistent_field')) return 'NO_QUERY_POSSIBLE';
        return 'SELECT SUM(val) as total FROM analysis_test2';
      }
      return 'The total is 30. The breakdown by a nonexistent field could not be determined.';
    }
  }

  const ds = await ingestFile({ filePath: csvPath, originalFilename: 'analysis_test2.csv' });
  const result = await routeQuery({
    question: 'total and nonexistent breakdown',
    datasetIds: [ds.dataset_id],
    session: { active_dataset_id: null },
    llmProvider: new PartiallyFailingLLM(),
    embeddingProvider: null,
    conversationContext: '',
    analysisMode: true,
  });

  assert.equal(result.evidence.steps.length, 2);
  assert.equal(result.evidence.steps.filter((s) => s.failed).length, 1);
  assert.ok(result.evidence.confidence < 1, 'confidence should reflect the partial failure');

  fs.rmSync(csvPath, { force: true });
});
