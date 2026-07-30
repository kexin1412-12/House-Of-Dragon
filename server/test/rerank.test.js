const test = require('node:test');
const assert = require('node:assert');
const { rerank } = require('../lib/retrieval/rerank');

const ctx = { sceneId: 's024', characterIds: ['rhaenyra'], locationIds: ['dragonstone'], symbolIds: [], cursorTime: 900, intent: 'character' };

test('query relevance dominates: a much more relevant chunk beats an on-scene one', () => {
  // 'relevant' is first in input (top query relevance) but off-scene; 'onscene' is far
  // down but matches scene + character. Query relevance must still win.
  const chunks = [
    { id: 'relevant', scene_id: 's002', character_ids: [], knowledge_type: 'character_relationship' },
    { id: 'x', scene_id: 's002', character_ids: [] },
    { id: 'y', scene_id: 's002', character_ids: [] },
    { id: 'onscene', scene_id: 's024', character_ids: ['rhaenyra'], knowledge_type: 'character_motivation' },
  ];
  assert.strictEqual(rerank(chunks, ctx)[0].id, 'relevant');
});

test('context breaks a near-tie: on-scene+on-character chunk lifts past its immediate neighbor', () => {
  const chunks = [
    { id: 'neighbor', scene_id: 's002', character_ids: [], knowledge_type: 'lore_card' },
    { id: 'contextual', scene_id: 's024', character_ids: ['rhaenyra'], knowledge_type: 'character_motivation' },
  ];
  assert.strictEqual(rerank(chunks, ctx)[0].id, 'contextual');
});

test('stable when ctx is empty (preserves query order)', () => {
  const chunks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepStrictEqual(rerank(chunks, {}).map(c => c.id), ['a', 'b', 'c']);
});
