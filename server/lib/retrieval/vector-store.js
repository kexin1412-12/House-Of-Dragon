const crypto = require('crypto');

const EMBEDDING_MODEL = 'text-embedding-3-small';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function rankDense(chunks, queryEmbedding) {
  return (chunks || [])
    .filter(c => Array.isArray(c.embedding))
    .map(c => ({ id: c.id, score: cosine(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .map(s => s.id);
}

async function embedQuery(text, { client, cache } = {}) {
  const key = EMBEDDING_MODEL + ':' + crypto.createHash('sha1').update(String(text)).digest('hex');
  if (cache && cache.has(key)) return cache.get(key);
  const resp = await client.embeddings.create({ model: EMBEDDING_MODEL, input: String(text) });
  const vec = resp.data[0].embedding;
  if (cache) cache.set(key, vec);
  return vec;
}

module.exports = { cosine, rankDense, embedQuery, EMBEDDING_MODEL };
