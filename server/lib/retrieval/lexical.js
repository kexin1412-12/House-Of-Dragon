// Sparse/keyword arm — bigram + character-id matching. Ported from the
// original retrieval.js so exact names / IDs / 台词 stay reliably matchable.

function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    // Skip bigrams that are purely punctuation/symbols (all chars are non-alphanumeric and not CJK)
    if (/^[^\p{L}\p{N}]+$/u.test(b)) continue;
    out.push(b);
  }
  return out;
}

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[\s·\-]+/g, '');
}

function rankLexical(chunks, { query = '', nameKeys = [] } = {}) {
  const qBigrams = bigrams(query);
  const keys = (nameKeys || []).map(normalizeName).filter(Boolean);

  const scored = (chunks || []).map(c => {
    const blob = String(c.retrieval_text || c.content || '').toLowerCase();
    const blobNorm = blob.replace(/[\s·\-]+/g, '');
    const charNorms = (c.character_ids || []).map(normalizeName);
    let score = 0;
    for (const nk of keys) {
      if (charNorms.some(cn => cn.includes(nk) || nk.includes(cn))) score += 5;
      else if (blobNorm.includes(nk)) score += 2;
    }
    if (qBigrams.length) {
      let hits = 0;
      for (const bg of qBigrams) if (blob.includes(bg)) hits++;
      score += Math.min(hits * 0.3, 3);
    }
    return { id: c.id, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.id);
}

module.exports = { bigrams, normalizeName, rankLexical };
