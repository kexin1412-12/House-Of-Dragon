// Deterministic reranker over the fused, already time-filtered candidates.
//
// PRIMARY signal = the query-relevance order this function receives (the fused
// dense+lexical ranking from index.js). Scene / character / location / time context
// is only a small, bounded tie-break bonus: it can nudge chunks that are already close
// in query relevance, but must NOT override a clearly more relevant chunk. (Before, the
// score was context-only and threw the query ranking away, so every question at a given
// cursor returned near-identical results — see scripts/eval dimension ①.)

const INTENT_TYPE_BONUS = {
  character: { character_motivation: 3, character_relationship: 2.5, scene_reading: 1 },
  shot: { scene_shot: 3, symbol_occurrence: 2, symbol_definition: 1 },
  fact: { scene_fact: 3, subtitle_window: 2 },
};

// Bounded context bonus, ~0..2.9. Kept small relative to the 1.0 gap between adjacent
// query ranks so it only reorders near-equally-relevant chunks.
function contextScore(c, ctx = {}) {
  let s = 0;
  if (ctx.sceneId && c.scene_id === ctx.sceneId) s += 0.8;
  const ctxChars = new Set(ctx.characterIds || []);
  if ((c.character_ids || []).some(id => ctxChars.has(id))) s += 0.6;
  const ctxLoc = new Set(ctx.locationIds || []);
  if ((c.location_ids || []).some(id => ctxLoc.has(id))) s += 0.3;
  const ctxSym = new Set(ctx.symbolIds || []);
  if ((c.symbol_ids || []).some(id => ctxSym.has(id))) s += 0.3;
  if (typeof c.available_from_time === 'number' && typeof ctx.cursorTime === 'number') {
    const dist = Math.abs(ctx.cursorTime - c.available_from_time);
    s += Math.max(0, 0.2 * (1 - dist / 3600)); // closer in time → up to +0.2
  }
  const intentBonus = (INTENT_TYPE_BONUS[ctx.intent] || {})[c.knowledge_type] || 0;
  s += intentBonus * 0.2; // up to +0.6
  s += (typeof c.confidence === 'number' ? c.confidence : 0.5) * 0.1; // up to +0.1
  return s;
}

function rerank(chunks, ctx = {}) {
  const list = chunks || [];
  const n = list.length;
  return list
    .map((c, i) => ({ c, s: (n - i) + contextScore(c, ctx) })) // (n-i) = query-relevance rank
    .sort((a, b) => b.s - a.s)
    .map(x => x.c);
}

module.exports = { rerank, contextScore, scoreChunk: contextScore };
