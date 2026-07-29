const test = require('node:test');
const assert = require('node:assert');
const { rerank } = require('../lib/retrieval/rerank');

const ctx = { sceneId: 's024', characterIds: ['rhaenyra'], locationIds: ['dragonstone'], symbolIds: [], cursorTime: 900, intent: 'character' };

test('current-scene chunk beats an off-scene one', () => {
  const chunks = [
    { id: 'off', scene_id: 's002', character_ids: [], knowledge_type: 'scene_reading', confidence: 0.9 },
    { id: 'here', scene_id: 's024', character_ids: [], knowledge_type: 'scene_reading', confidence: 0.5 },
  ];
  assert.strictEqual(rerank(chunks, ctx)[0].id, 'here');
});

test('character intent lifts character_motivation for the current character', () => {
  const chunks = [
    { id: 'reading', scene_id: 's002', character_ids: ['rhaenyra'], knowledge_type: 'scene_reading', confidence: 0.9 },
    { id: 'motive', scene_id: 's002', character_ids: ['rhaenyra'], knowledge_type: 'character_motivation', confidence: 0.6 },
  ];
  assert.strictEqual(rerank(chunks, ctx)[0].id, 'motive');
});

test('stable when ctx is empty (no throw)', () => {
  const chunks = [{ id: 'a', knowledge_type: 'lore_card' }];
  assert.deepStrictEqual(rerank(chunks, {}).map(c => c.id), ['a']);
});
