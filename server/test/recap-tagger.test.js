const test = require('node:test');
const assert = require('node:assert');
const { tagPoint, tagAll } = require('../lib/retrieval/recap-tagger');

const opts = {
  sceneEpisodes: [{ episode: 'S01E03', keywords: ['继承', '婚姻'] }],
  llmFn: async (prompt) => {
    // Check if the POINT content (after "知识:") contains '继承'
    const knowledgePart = prompt.split('知识:')[1] || '';
    return knowledgePart.includes('继承') ? 'S01E03' : 'UNKNOWN';
  },
};

test('tagPoint assigns episode from llm', async () => {
  const r = await tagPoint({ title: '继承危机', summary: '国王讨论继承' }, opts);
  assert.deepStrictEqual(r, { available_from_episode: 'S01E03' });
});

test('tagPoint returns null on UNKNOWN', async () => {
  const r = await tagPoint({ title: '无关', summary: '模糊内容' }, opts);
  assert.strictEqual(r, null);
});

test('tagAll drops untaggable points', async () => {
  const points = [{ title: '继承危机', summary: '继承' }, { title: '无关', summary: 'x' }];
  const out = await tagAll(points, opts);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].available_from_episode, 'S01E03');
});
