const test = require('node:test');
const assert = require('node:assert');
const { epToNum, isEligible, filterEligible } = require('../lib/retrieval/temporal-filter');

const cursor = {
  show_id: 'house-of-the-dragon', video_id: 'v1', season: 3,
  episode: 'S03E01', cursorTime: 900, allowedSpoilerLevel: 0, crossVideo: false,
};
const base = {
  show_id: 'house-of-the-dragon', video_id: 'v1', season: 3,
  spoiler_level: 0, available_from_episode: 'S03E01',
};

test('epToNum parses episode codes', () => {
  assert.strictEqual(epToNum('S03E01'), 301);
  assert.strictEqual(epToNum('S01E10'), 110);
  assert.strictEqual(epToNum('nope'), null);
});

test('same episode gated by available_from_time', () => {
  assert.ok(isEligible({ ...base, available_from_time: 800 }, cursor));
  assert.ok(!isEligible({ ...base, available_from_time: 1000 }, cursor));
});

test('earlier episode is time-independent', () => {
  assert.ok(isEligible({ ...base, available_from_episode: 'S02E05', available_from_time: 99999 }, cursor));
});

test('future episode is blocked', () => {
  assert.ok(!isEligible({ ...base, available_from_episode: 'S03E02', available_from_time: 0 }, cursor));
});

test('higher spoiler level blocked', () => {
  assert.ok(!isEligible({ ...base, available_from_time: 0, spoiler_level: 2 }, cursor));
});

test('other show blocked; other video blocked unless crossVideo', () => {
  assert.ok(!isEligible({ ...base, available_from_time: 0, show_id: 'got' }, cursor));
  assert.ok(!isEligible({ ...base, available_from_time: 0, video_id: 'v2' }, cursor));
  assert.ok(isEligible({ ...base, available_from_time: 0, video_id: 'v2' }, { ...cursor, crossVideo: true }));
});

test('missing cursor → baseline only (lore/no time key)', () => {
  const loreish = { show_id: 'house-of-the-dragon', video_id: 'v1', season: 1, spoiler_level: 0, available_from_episode: 'S01E01' };
  assert.ok(isEligible(loreish, null));
  assert.ok(!isEligible({ ...base, available_from_time: 0 }, null)); // has scene time → not baseline
});

test('filterEligible returns only eligible', () => {
  const chunks = [
    { ...base, id: 'a', available_from_time: 800 },
    { ...base, id: 'b', available_from_episode: 'S03E02', available_from_time: 0 },
  ];
  assert.deepStrictEqual(filterEligible(chunks, cursor).map(c => c.id), ['a']);
});
