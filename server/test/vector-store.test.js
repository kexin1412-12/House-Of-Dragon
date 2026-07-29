const test = require('node:test');
const assert = require('node:assert');
const { cosine, rankDense, embedQuery, EMBEDDING_MODEL } = require('../lib/retrieval/vector-store');

test('cosine of identical vectors is 1', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
});

test('rankDense orders by similarity, skips embedding-less chunks', () => {
  const q = [1, 0];
  const chunks = [
    { id: 'far', embedding: [0, 1] },
    { id: 'near', embedding: [0.9, 0.1] },
    { id: 'none' },
  ];
  assert.deepStrictEqual(rankDense(chunks, q), ['near', 'far']);
});

test('embedQuery uses injected client and caches', async () => {
  let calls = 0;
  const client = { embeddings: { create: async () => { calls++; return { data: [{ embedding: [1, 2, 3] }] }; } } };
  const cache = new Map();
  const a = await embedQuery('hi', { client, cache });
  const b = await embedQuery('hi', { client, cache });
  assert.deepStrictEqual(a, [1, 2, 3]);
  assert.deepStrictEqual(b, [1, 2, 3]);
  assert.strictEqual(calls, 1); // second call served from cache
  assert.strictEqual(EMBEDDING_MODEL, 'text-embedding-3-small');
});
