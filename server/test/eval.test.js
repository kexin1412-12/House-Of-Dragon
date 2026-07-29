const test = require('node:test');
const assert = require('node:assert');
const { recallAtK, leakCount, evaluate } = require('../lib/retrieval/eval');

test('recallAtK counts hits within top k', () => {
  assert.strictEqual(recallAtK(['a', 'b', 'c'], ['a', 'z'], 2), 0.5);
});

test('leakCount counts forbidden ids returned', () => {
  assert.strictEqual(leakCount(['a', 'future'], ['future']), 1);
});

test('evaluate aggregates recall and hard leak gate', async () => {
  const questions = [
    { id: 'q1', expected_ids: ['a'], must_not_recall_ids: ['future'] },
    { id: 'q2', expected_ids: ['b'], must_not_recall_ids: [] },
  ];
  const retrieveFn = async (q) => (q.id === 'q1' ? ['a', 'future'] : ['b']);
  const r = await evaluate(questions, retrieveFn);
  assert.ok(Math.abs(r.recall - 1) < 1e-9);
  assert.strictEqual(r.leaks, 1); // q1 leaked → gate fails
});
