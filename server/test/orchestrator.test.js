const test = require('node:test');
const assert = require('node:assert');
const { retrieve } = require('../lib/retrieval/index');

const chunks = [
  { id: 'here', knowledge_type: 'scene_reading', show_id: 's', video_id: 'v1', season: 1,
    available_from_episode: 'S01E01', available_from_time: 10, scene_id: 's024',
    character_ids: ['alicent'], content: '沉默是观察', retrieval_text: '沉默 观察 alicent', embedding: [1, 0] },
  { id: 'future', knowledge_type: 'scene_reading', show_id: 's', video_id: 'v1', season: 1,
    available_from_episode: 'S01E09', available_from_time: 0, scene_id: 's900',
    character_ids: [], content: '未来剧透', retrieval_text: '未来 剧透', embedding: [1, 0] },
];
const cursor = { show_id: 's', video_id: 'v1', season: 1, episode: 'S01E01', cursorTime: 900, allowedSpoilerLevel: 0 };

test('lexical-only path (no embed client) never returns future chunk', async () => {
  const out = await retrieve({
    query: '沉默', characterNames: ['alicent'], cursor,
    _deps: { loadChunks: () => chunks, embedClient: null },
  });
  const ids = out.map(c => c.id);
  assert.ok(ids.includes('here'));
  assert.ok(!ids.includes('future'));
});

test('hybrid path with fake embed client also excludes future chunk', async () => {
  const embedClient = { embeddings: { create: async () => ({ data: [{ embedding: [1, 0] }] }) } };
  const out = await retrieve({
    query: '沉默', characterNames: ['alicent'], cursor,
    _deps: { loadChunks: () => chunks, embedClient, embedCache: new Map() },
  });
  assert.ok(!out.map(c => c.id).includes('future'));
});
