// Caps are anti-flood only (stop the top-k from being 8-of-a-kind); they must not starve
// the answer. The old 1-caps meant a question whose answer is e.g. a character_state got a
// single state slot, which the on-screen character's state could occupy instead of the
// queried one. Relaxed so up to 2-3 of the most relevant type survive.
const DEFAULT_QUOTAS = {
  scene_reading: 3, character_state: 2, character_relationship: 2,
  character_motivation: 2, lore_card: 2, external_knowledge: 2,
};

function buildContext(rankedChunks, { quotas = DEFAULT_QUOTAS, total = 8 } = {}) {
  const used = {};
  const seen = new Set();
  const out = [];
  for (const c of rankedChunks || []) {
    if (out.length >= total) break;
    if (seen.has(c.id)) continue;
    const type = c.knowledge_type || 'other';
    const cap = quotas[type] != null ? quotas[type] : total;
    if ((used[type] || 0) >= cap) continue;
    used[type] = (used[type] || 0) + 1;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

module.exports = { buildContext, DEFAULT_QUOTAS };
