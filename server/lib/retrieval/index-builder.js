const { EMBEDDING_MODEL } = require('./vector-store');

function syncIndex(existing, freshChunks) {
  const existingById = new Map((existing || []).map(c => [c.id, c]));
  const freshIds = new Set(freshChunks.map(c => c.id));
  const added = [], updated = [], merged = [];

  for (const fresh of freshChunks) {
    const prev = existingById.get(fresh.id);
    if (!prev) { added.push(fresh.id); merged.push(fresh); continue; }
    if (prev.content_hash === fresh.content_hash) {
      merged.push({ ...fresh, embedding: prev.embedding, embedding_model: prev.embedding_model }); // reuse
    } else {
      updated.push(fresh.id);
      merged.push({ ...fresh, embedding: null }); // force re-embed
    }
  }
  const deleted = (existing || []).filter(c => !freshIds.has(c.id)).map(c => c.id);
  return { merged, added, updated, deleted };
}

async function embedMissing(chunks, { embedFn }) {
  for (const c of chunks) {
    if (c.embedding == null) {
      c.embedding = await embedFn(c.retrieval_text || c.content);
      c.embedding_model = EMBEDDING_MODEL;
    }
  }
  return chunks;
}

module.exports = { syncIndex, embedMissing };
