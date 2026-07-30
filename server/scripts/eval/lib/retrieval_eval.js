// Dimension ①: retrieval recall@k over the spoiler-safe hybrid retriever.
// Deterministic given the built vectors index + a query embedding (cached by the
// vector store). Mirrors agent.js's active-Q&A retrieval call site: seed the query
// with the on-screen characters' names/aliases, gate everything by the cursor.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..', '..', '..');
const kbPaths = require(path.join(SERVER, 'lib', 'kb-paths'));
const { retrieve } = require(path.join(SERVER, 'lib', 'retrieval'));
const { cursorAtTime } = require(path.join(SERVER, 'lib', 'characters'));
const { embedQuery, EMBEDDING_MODEL } = require(path.join(SERVER, 'lib', 'retrieval', 'vector-store'));

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const EMBED_CACHE_FILE = path.join(CACHE_DIR, 'query_embeddings.json');

// The hybrid retriever embeds the query at call time; that network call is flaky through
// the proxy and retrieve() silently falls back to lexical on failure — which would make
// recall non-reproducible. We instead pre-embed every eval query ONCE (with retry),
// persist the vectors, and feed them back through the retriever's own cache so the dense
// path always applies and the score is stable run-to-run.
function embedKey(text) {
  return EMBEDDING_MODEL + ':' + crypto.createHash('sha1').update(String(text)).digest('hex');
}
function loadEmbedCache() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(EMBED_CACHE_FILE, 'utf8')))); }
  catch { return new Map(); }
}
function saveEmbedCache(map) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(EMBED_CACHE_FILE, JSON.stringify(Object.fromEntries(map), null, 0));
}
function makeEmbedClient() {
  if (!process.env.OPENAI_API_KEY || process.env.RETRIEVAL_DENSE === 'off') return null;
  try { const { createOpenAIClient } = require(path.join(SERVER, 'lib', 'ai', 'openai-client')); return createOpenAIClient(); }
  catch { return null; }
}
async function prewarmEmbeddings(queries, client, cache) {
  if (!client) return { dense: false, embedded: 0 };
  let embedded = 0;
  for (const q of queries) {
    if (cache.has(embedKey(q))) continue;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try { await embedQuery(q, { client, cache }); ok = true; embedded++; }
      catch (e) { if (attempt === 2) console.warn(`   ⚠ embed failed for query (${e.message}); will fall back to lexical for it`); }
    }
  }
  if (embedded) saveEmbedCache(cache);
  return { dense: true, embedded };
}

function recallAtK(returnedIds, expectedIds, k) {
  if (!expectedIds || expectedIds.length === 0) return 1;
  const top = new Set((returnedIds || []).slice(0, k));
  const hits = expectedIds.filter(id => top.has(id)).length;
  return hits / expectedIds.length;
}

// Reciprocal rank of the FIRST expected id in the returned list (0 if none present).
function reciprocalRank(returnedIds, expectedIds) {
  if (!expectedIds || expectedIds.length === 0) return 1;
  const want = new Set(expectedIds);
  for (let i = 0; i < (returnedIds || []).length; i++) {
    if (want.has(returnedIds[i])) return 1 / (i + 1);
  }
  return 0;
}

function leakCount(returnedIds, mustNotIds) {
  const forbidden = new Set(mustNotIds || []);
  return (returnedIds || []).filter(id => forbidden.has(id)).length;
}

const currentScene = (kb, t) => (kb.scenes || []).find(s => s.start_time <= t && t < s.end_time) || null;

function buildCharDbLoader() {
  const cache = {};
  return (showId) => {
    if (!(showId in cache)) {
      const p = kbPaths.charactersDb(showId);
      cache[showId] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { characters: [] };
    }
    return cache[showId];
  };
}

async function retrieveIdsFor(q, loadCharDb, deps) {
  const kb = JSON.parse(fs.readFileSync(kbPaths.sceneKb(q.videoId), 'utf8'));
  const cursor = {
    show_id: kb.show_id, video_id: q.videoId, season: kb.season,
    episode: cursorAtTime(kb, q.cursorTime), cursorTime: q.cursorTime, allowedSpoilerLevel: 0,
  };
  const scene = currentScene(kb, q.cursorTime);
  const db = loadCharDb(kb.show_id);
  const charNames = [], charAliases = [];
  for (const cid of (scene && scene.characters) || []) {
    const id = typeof cid === 'string' ? cid : cid && cid.id;
    const entry = (db.characters || []).find(c => c.character_id === id);
    if (!entry) continue;
    if (entry.display_name_zh) charNames.push(entry.display_name_zh);
    if (entry.canonical_name) charAliases.push(entry.canonical_name);
    if (Array.isArray(entry.aliases)) charAliases.push(...entry.aliases);
    if (entry.house) charAliases.push(entry.house);
    if (entry.short_identity_zh) charAliases.push(entry.short_identity_zh);
  }
  const out = await retrieve({
    query: q.query, characterNames: charNames, characterAliases: charAliases,
    cursor, currentScene: scene,
    characterIds: ((scene && scene.characters) || []).map(c => (typeof c === 'string' ? c : c && c.id)).filter(Boolean),
    _deps: deps,
  });
  return out.map(c => c.id);
}

async function run(dataset) {
  const k = dataset.k || 8;
  const loadCharDb = buildCharDbLoader();
  const perQuestion = [];
  let recallSum = 0, mrrSum = 0, leaks = 0;
  const byType = {};

  // Pre-warm + persist query embeddings so the dense path applies deterministically.
  const embedClient = makeEmbedClient();
  const embedCache = loadEmbedCache();
  const warm = await prewarmEmbeddings(dataset.questions.map(q => q.query), embedClient, embedCache);
  const deps = { embedClient, embedCache };

  for (const q of dataset.questions) {
    const ids = await retrieveIdsFor(q, loadCharDb, deps);
    const recall = recallAtK(ids, q.expected_ids, k);
    const rr = reciprocalRank(ids, q.expected_ids);
    const leak = leakCount(ids, q.must_not_recall_ids);
    recallSum += recall; mrrSum += rr; leaks += leak;

    const type = q.knowledge_type || 'unknown';
    (byType[type] = byType[type] || { recall: 0, n: 0 }).recall += recall;
    byType[type].n += 1;

    perQuestion.push({
      id: q.id, knowledge_type: type, query: q.query, videoId: q.videoId, cursorTime: q.cursorTime,
      recall, reciprocal_rank: rr, leak,
      expected_ids: q.expected_ids || [], returned_ids: ids.slice(0, k),
      hit_ids: (q.expected_ids || []).filter(id => ids.slice(0, k).includes(id)),
      miss_ids: (q.expected_ids || []).filter(id => !ids.slice(0, k).includes(id)),
    });
  }

  const n = dataset.questions.length || 1;
  const perTypeRecall = Object.fromEntries(
    Object.entries(byType).map(([t, v]) => [t, { recall: v.recall / v.n, n: v.n }])
  );

  return {
    k,
    n: dataset.questions.length,
    dense_active: warm.dense,
    recall_at_k: recallSum / n,
    mrr: mrrSum / n,
    leaks,
    per_type_recall: perTypeRecall,
    per_question: perQuestion,
  };
}

module.exports = { run, recallAtK, reciprocalRank, leakCount };
