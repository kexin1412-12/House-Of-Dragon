const test = require('node:test');
const assert = require('node:assert');
const { buildContext } = require('../lib/retrieval/context-builder');

test('per-type quota enforced in ranked order', () => {
  const chunks = [
    { id: 'r1', knowledge_type: 'scene_reading' },
    { id: 'r2', knowledge_type: 'scene_reading' },
    { id: 'r3', knowledge_type: 'scene_reading' },
    { id: 'l1', knowledge_type: 'lore_card' },
  ];
  const kept = buildContext(chunks, { quotas: { scene_reading: 2, lore_card: 1 }, total: 8 });
  assert.deepStrictEqual(kept.map(c => c.id), ['r1', 'r2', 'l1']);
});

test('total cap enforced', () => {
  const chunks = Array.from({ length: 5 }, (_, i) => ({ id: 'x' + i, knowledge_type: 'lore_card' }));
  const kept = buildContext(chunks, { quotas: { lore_card: 10 }, total: 3 });
  assert.strictEqual(kept.length, 3);
});

test('dedups by id', () => {
  const chunks = [{ id: 'a', knowledge_type: 'lore_card' }, { id: 'a', knowledge_type: 'lore_card' }];
  assert.strictEqual(buildContext(chunks, { quotas: { lore_card: 5 }, total: 8 }).length, 1);
});
