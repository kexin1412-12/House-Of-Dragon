const test = require('node:test');
const assert = require('node:assert');
const { syncIndex, embedMissing } = require('../lib/retrieval/index-builder');

test('syncIndex adds/updates/keeps/deletes by id+hash', () => {
  const existing = [
    { id: 'keep', content_hash: 'h1', embedding: [1] },
    { id: 'change', content_hash: 'old', embedding: [2] },
    { id: 'gone', content_hash: 'h3', embedding: [3] },
  ];
  const fresh = [
    { id: 'keep', content_hash: 'h1', embedding: null },
    { id: 'change', content_hash: 'new', embedding: null },
    { id: 'add', content_hash: 'h4', embedding: null },
  ];
  const { merged, added, updated, deleted } = syncIndex(existing, fresh);
  assert.deepStrictEqual(added, ['add']);
  assert.deepStrictEqual(updated, ['change']);
  assert.deepStrictEqual(deleted, ['gone']);
  assert.deepStrictEqual(merged.find(c => c.id === 'keep').embedding, [1]); // preserved
  assert.strictEqual(merged.find(c => c.id === 'change').embedding, null); // dropped for re-embed
});

test('embedMissing only fills null embeddings', async () => {
  const chunks = [{ id: 'a', content: 'x', embedding: null }, { id: 'b', content: 'y', embedding: [9] }];
  const out = await embedMissing(chunks, { embedFn: async () => [1, 1] });
  assert.deepStrictEqual(out.find(c => c.id === 'a').embedding, [1, 1]);
  assert.strictEqual(out.find(c => c.id === 'a').embedding_model, 'text-embedding-3-small');
  assert.deepStrictEqual(out.find(c => c.id === 'b').embedding, [9]); // untouched
});
