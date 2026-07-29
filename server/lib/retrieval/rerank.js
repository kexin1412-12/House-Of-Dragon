// Deterministic rule reranker over the fused, already time-filtered candidates.

const INTENT_TYPE_BONUS = {
  character: { character_motivation: 3, character_relationship: 2.5, scene_reading: 1 },
  shot: { scene_shot: 3, symbol_occurrence: 2, symbol_definition: 1 },
  fact: { scene_fact: 3, subtitle_window: 2 },
};

function scoreChunk(c, ctx) {
  let s = 0;
  if (ctx.sceneId && c.scene_id === ctx.sceneId) s += 4;
  const ctxChars = new Set(ctx.characterIds || []);
  if ((c.character_ids || []).some(id => ctxChars.has(id))) s += 3;
  const ctxLoc = new Set(ctx.locationIds || []);
  if ((c.location_ids || []).some(id => ctxLoc.has(id))) s += 1.5;
  const ctxSym = new Set(ctx.symbolIds || []);
  if ((c.symbol_ids || []).some(id => ctxSym.has(id))) s += 1.5;
  if (typeof c.available_from_time === 'number' && typeof ctx.cursorTime === 'number') {
    const dist = Math.abs(ctx.cursorTime - c.available_from_time);
    s += Math.max(0, 1 - dist / 3600); // closer in time → up to +1
  }
  s += (typeof c.confidence === 'number' ? c.confidence : 0.5) * 0.5;
  const bonus = (INTENT_TYPE_BONUS[ctx.intent] || {})[c.knowledge_type] || 0;
  s += bonus;
  return s;
}

function rerank(chunks, ctx = {}) {
  return (chunks || [])
    .map(c => ({ c, s: scoreChunk(c, ctx) }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.c);
}

module.exports = { rerank, scoreChunk };
