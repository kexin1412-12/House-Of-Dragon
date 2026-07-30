const test = require('node:test');
const assert = require('node:assert');
const { chunkScenes, episodeForScene, hashContent } = require('../lib/retrieval/chunkers');

const kb = {
  show_id: 'house-of-the-dragon', video_id: 'v1', season: 3,
  episode_map: [{ from_scene: 's002', to_scene: 's082', episode: 'S03E01' }],
  scenes: [{
    scene_id: 's024', start_time: 812.4, end_time: 861.7, characters: ['rhaenyra'],
    tapestry_meta_reading: { dragon_motif: '龙是资本与武器' },
    visual_beats: [{
      beat_id: 'b1', start_time: 815, end_time: 820,
      meaning: '沉默是观察而非退让', aesthetic_reading: '红线如伤口', thematic_mirrors: ['预言既救国也是负担'],
    }],
  }],
};

test('episodeForScene maps via episode_map', () => {
  assert.strictEqual(episodeForScene(kb, 's024'), 'S03E01');
});

test('chunkScenes emits reading chunks with schema fields', () => {
  const chunks = chunkScenes(kb);
  const beat = chunks.find(c => c.id.includes('b1'));
  assert.strictEqual(beat.knowledge_type, 'scene_reading');
  assert.strictEqual(beat.scene_id, 's024');
  assert.strictEqual(beat.available_from_episode, 'S03E01');
  assert.strictEqual(beat.available_from_time, 815);
  assert.deepStrictEqual(beat.character_ids, ['rhaenyra']);
  assert.strictEqual(beat.schema_version, 1);
  assert.ok(beat.content.includes('沉默'));
  assert.strictEqual(beat.content_hash, hashContent(beat.retrieval_text));
  // tapestry reading uses the scene start_time
  const tap = chunks.find(c => c.id.includes('tapestry'));
  assert.strictEqual(tap.available_from_time, 812.4);
});
