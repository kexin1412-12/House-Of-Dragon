const DEFAULT_QUOTAS = {
  scene_reading: 2, character_state: 1, character_relationship: 1,
  character_motivation: 1, lore_card: 1, external_knowledge: 2,
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
