const path = require('path');
const fs = require('fs');
const kbPaths = require('../kb-paths');
const { filterEligible } = require('./temporal-filter');
const { rankLexical } = require('./lexical');
const { rankDense, embedQuery } = require('./vector-store');
const { rrf } = require('./fusion');
const { rerank } = require('./rerank');
const { buildContext } = require('./context-builder');

let VECTOR_CACHE = null;
let QUERY_EMBED_CACHE = new Map();

function defaultLoadChunks(showId) {
  if (VECTOR_CACHE) return VECTOR_CACHE;
  const fp = kbPaths.vectors(showId || 'house-of-the-dragon');
  VECTOR_CACHE = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : [];
  return VECTOR_CACHE;
}

function defaultEmbedClient() {
  if (!process.env.OPENAI_API_KEY || process.env.RETRIEVAL_DENSE === 'off') return null;
  // Route through the project's proxy-aware client (honors OPENAI_PROXY_URL).
  try { const { createOpenAIClient } = require('../ai/openai-client'); return createOpenAIClient(); } catch { return null; }
}

async function retrieve(params = {}) {
  const {
    query = '', characterNames = [], characterAliases = [], k = 8,
    cursor = null, characterIds = [], intent = null, currentScene = null,
    excludeIds = null,
    _deps = {},
  } = params;

  const showId = cursor && cursor.show_id;
  const loadChunks = _deps.loadChunks || defaultLoadChunks;
  const embedClient = _deps.embedClient !== undefined ? _deps.embedClient : defaultEmbedClient();
  const embedCache = _deps.embedCache || QUERY_EMBED_CACHE;

  const all = loadChunks(showId);
  let eligible = filterEligible(all, cursor);
  if (excludeIds && excludeIds.size) {
    eligible = eligible.filter(c => !excludeIds.has(c.id));
  }
  if (eligible.length === 0) return [];

  const byId = new Map(eligible.map(c => [c.id, c]));
  const nameKeys = [...characterNames, ...characterAliases, ...characterIds];

  const lexRanked = rankLexical(eligible, { query, nameKeys }).slice(0, 40);

  let rankedIds;
  if (embedClient) {
    try {
      const qEmb = await embedQuery(query, { client: embedClient, cache: embedCache });
      const denseRanked = rankDense(eligible, qEmb).slice(0, 40);
      rankedIds = rrf([denseRanked, lexRanked]).map(r => r.id);
    } catch {
      rankedIds = lexRanked; // fallback
    }
  } else {
    rankedIds = lexRanked;
  }

  const cursorCtx = {
    sceneId: currentScene && currentScene.scene_id, characterIds,
    locationIds: (currentScene && currentScene.location_ids) || [],
    symbolIds: [], cursorTime: cursor && cursor.cursorTime, intent,
  };
  const reranked = rerank(rankedIds.map(id => byId.get(id)).filter(Boolean), cursorCtx);
  const raw = buildContext(reranked, { total: k });
  return raw.map(({ id, knowledge_type, content, scene_id, available_from_episode, source_type, confidence, character_ids }) =>
    ({ id, knowledge_type, content, scene_id, available_from_episode, source_type, confidence, character_ids }));
}

function clearCache() { VECTOR_CACHE = null; QUERY_EMBED_CACHE = new Map(); }

module.exports = { retrieve, clearCache };
