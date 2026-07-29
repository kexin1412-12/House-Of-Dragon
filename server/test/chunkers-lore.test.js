const test = require('node:test');
const assert = require('node:assert');
const { chunkLore, chunkRecap } = require('../lib/retrieval/chunkers');

const meta = { show_id: 'house-of-the-dragon', video_id: null, season: 1 };

test('chunkLore emits timeless lore_card from S01E01', () => {
  const kj = { knowledge_points: [{ title: '月亮茶', summary: '避孕/堕胎药', safe_hint: '女性政治工具', related_characters: ['rhaenyra'], importance: 0.7 }] };
  const [c] = chunkLore(kj, meta);
  assert.strictEqual(c.knowledge_type, 'lore_card');
  assert.strictEqual(c.available_from_episode, 'S01E01');
  assert.strictEqual(c.available_from_time, null);
  assert.ok(c.content.includes('月亮茶'));
  assert.deepStrictEqual(c.character_ids, ['rhaenyra']);
});

test('chunkRecap keeps only tagged points', () => {
  const points = [
    { title: 'a', summary: '早期事件', available_from_episode: 'S01E03', related_characters: [] },
    { title: 'b', summary: '未标记', related_characters: [] }, // no tag → dropped
  ];
  const chunks = chunkRecap(points, meta);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].knowledge_type, 'external_knowledge');
  assert.strictEqual(chunks[0].available_from_episode, 'S01E03');
});
