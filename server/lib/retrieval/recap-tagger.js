// Offline: assign each whole-season recap point an available_from_episode.
// Fail-closed — anything the model can't place confidently is dropped.

function parseEpisode(s) {
  const m = String(s || '').match(/S\d{2}E\d{2}/i);
  return m ? m[0].toUpperCase() : null;
}

function buildPrompt(point, sceneEpisodes) {
  const catalog = sceneEpisodes.map(s => `${s.episode}: ${s.keywords.join('、')}`).join('\n');
  return [
    '根据剧集关键词目录，判断下面这条解说知识最早在哪一集就已经可以安全知道。',
    '只回答形如 S01E03 的集数；如果无法确定，回答 UNKNOWN。',
    '目录:', catalog,
    '知识:', `${point.title || ''} ${point.summary || point.point || ''}`,
  ].join('\n');
}

async function tagPoint(point, { sceneEpisodes, llmFn }) {
  const ans = await llmFn(buildPrompt(point, sceneEpisodes));
  const ep = parseEpisode(ans);
  return ep ? { available_from_episode: ep } : null;
}

async function tagAll(points, opts) {
  const out = [];
  for (const p of points || []) {
    const tag = await tagPoint(p, opts);
    if (tag) out.push({ ...p, ...tag });
  }
  return out;
}

module.exports = { tagPoint, tagAll, parseEpisode, buildPrompt };
