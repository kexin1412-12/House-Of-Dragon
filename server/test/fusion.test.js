const test = require('node:test');
const assert = require('node:assert');
const { rrf } = require('../lib/retrieval/fusion');

test('id ranked high in both lists wins', () => {
  const fused = rrf([['a', 'b', 'c'], ['a', 'c', 'd']]);
  assert.strictEqual(fused[0].id, 'a');
});

test('union of all ids preserved', () => {
  const ids = rrf([['a', 'b'], ['c']]).map(r => r.id).sort();
  assert.deepStrictEqual(ids, ['a', 'b', 'c']);
});

test('score uses 1/(k+rank), rank starting at 1', () => {
  const fused = rrf([['x']], 60);
  assert.ok(Math.abs(fused[0].score - 1 / 61) < 1e-9);
});

test('empty input → empty output', () => {
  assert.deepStrictEqual(rrf([]), []);
});
