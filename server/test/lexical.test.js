const test = require('node:test');
const assert = require('node:assert');
const { bigrams, normalizeName, rankLexical } = require('../lib/retrieval/lexical');

test('bigrams strips whitespace and yields 2-grams', () => {
  assert.deepStrictEqual(bigrams('沉默'), ['沉默']);
  assert.ok(bigrams('御前 会议').includes('会议'));
});

test('normalizeName lowercases and strips separators', () => {
  assert.strictEqual(normalizeName('阿莉森特·海塔尔'), '阿莉森特海塔尔');
});

test('character-id match outranks pure text match', () => {
  const chunks = [
    { id: 'txt', retrieval_text: '关于沉默的解读', character_ids: [] },
    { id: 'char', retrieval_text: '会议', character_ids: ['alicent_hightower'] },
  ];
  const ranked = rankLexical(chunks, { query: '沉默', nameKeys: ['alicent_hightower'] });
  assert.strictEqual(ranked[0], 'char');
});

test('zero-score chunks dropped', () => {
  const chunks = [{ id: 'x', retrieval_text: '无关内容', character_ids: [] }];
  assert.deepStrictEqual(rankLexical(chunks, { query: 'zzz', nameKeys: [] }), []);
});
