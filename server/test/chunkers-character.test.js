const test = require('node:test');
const assert = require('node:assert');
const { chunkCharacters } = require('../lib/retrieval/chunkers');

const charDb = {
  characters: [{
    character_id: 'alicent_hightower', display_name_zh: '阿莉选特·海塔尔',
    state_timeline: [{ from: 'S01E05', title_zh: '王后', safe_summary_zh: '以沉默表达不满' }],
    motivations_timeline: [{ from: 'S01E05', motivation_zh: '保住儿子的继承主张', evidence_zh: '御前会议' }],
  }],
  relationships: [{
    source: 'alicent_hightower', target: 'rhaenyra',
    timeline: [{ from: 'S01E05', relation_zh: '决裂的旧友', summary_zh: '继承权对立' }],
  }],
};
const meta = { show_id: 'house-of-the-dragon', video_id: 'v1', season: 1 };

test('emits state, motivation, relationship chunks with episode key', () => {
  const chunks = chunkCharacters(charDb, meta);
  const byType = t => chunks.filter(c => c.knowledge_type === t);
  assert.strictEqual(byType('character_state').length, 1);
  assert.strictEqual(byType('character_motivation').length, 1);
  assert.strictEqual(byType('character_relationship').length, 1);
  const state = byType('character_state')[0];
  assert.strictEqual(state.available_from_episode, 'S01E05');
  assert.strictEqual(state.available_from_time, null); // episode-granular
  assert.deepStrictEqual(state.character_ids, ['alicent_hightower']);
  assert.ok(state.content.includes('沉默'));
  const rel = byType('character_relationship')[0];
  assert.deepStrictEqual(rel.character_ids.sort(), ['alicent_hightower', 'rhaenyra']);
});
