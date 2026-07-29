const test = require('node:test');
const assert = require('node:assert');
const { retrieve } = require('../lib/retrieval');

test('retrieve is awaitable and returns an array with cursor context', async () => {
  const out = await retrieve({
    query: '继承', characterNames: [],
    cursor: { show_id: 'house-of-the-dragon', video_id: 'house_of_dragon_s03e01', season: 3, episode: 'S03E01', cursorTime: 900, allowedSpoilerLevel: 0 },
  });
  assert.ok(Array.isArray(out));
});
