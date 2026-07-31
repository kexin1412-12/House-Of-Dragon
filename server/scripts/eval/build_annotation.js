#!/usr/bin/env node
// Builds the human-annotation tool: runs the retriever over the annotation question set
// and generates answers over the answer set, then bakes everything into a single
// self-contained HTML (data embedded, no server needed) that the user labels in-browser.
//
//   node scripts/eval/build_annotation.js
//
// Output: server/eval-annotate.html  (open by double-click; export labels → JSON)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const kbPaths = require('../../lib/kb-paths');
const { retrieve } = require('../../lib/retrieval');
const { cursorAtTime } = require('../../lib/characters');
const { embedQuery, EMBEDDING_MODEL } = require('../../lib/retrieval/vector-store');
const answerEval = require('./lib/answer_eval');

const DATASETS = path.join(__dirname, 'datasets');
const CACHE_DIR = path.join(__dirname, '.cache');
const EMBED_CACHE = path.join(CACHE_DIR, 'query_embeddings.json');
const OUT = path.join(__dirname, '..', '..', 'eval-annotate.html');

const currentScene = (kb, t) => (kb.scenes || []).find(s => s.start_time <= t && t < s.end_time) || null;
const idsOf = s => ((s && s.characters) || []).map(c => (typeof c === 'string' ? c : c && c.id)).filter(Boolean);

function loadEmbedCache() {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(EMBED_CACHE, 'utf8')))); } catch { return new Map(); }
}
function saveEmbedCache(m) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(EMBED_CACHE, JSON.stringify(Object.fromEntries(m))); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function prewarm(queries, client, cache) {
  if (!client) return;
  const todo = queries.filter(q => !cache.has(EMBEDDING_MODEL + ':' + crypto.createHash('sha1').update(String(q)).digest('hex')));
  let done = 0, n = 0, failed = 0;
  const CONC = 6; // proxy is flaky; run several in parallel, each with quick retries
  const queue = [...todo];
  const worker = async () => {
    while (queue.length) {
      const q = queue.shift(); if (q == null) break;
      let ok = false;
      for (let a = 0; a < 4 && !ok; a++) {
        try { await embedQuery(q, { client, cache }); n++; ok = true; }
        catch { await sleep(400 * (a + 1)); }
      }
      if (!ok) failed++;
      done++;
      if (n % 6 === 0) saveEmbedCache(cache);
      process.stdout.write(`\r  预热 ${done}/${todo.length}（成功 ${n}，失败 ${failed}）`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  saveEmbedCache(cache);
  process.stdout.write('\n');
}

async function withRetry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; await sleep(1000 * (i + 1)); }
  }
  throw last;
}

async function buildRetrieval(dataset, deps) {
  const dbCache = {};
  const loadDb = (showId) => (dbCache[showId] ||= (fs.existsSync(kbPaths.charactersDb(showId)) ? JSON.parse(fs.readFileSync(kbPaths.charactersDb(showId), 'utf8')) : { characters: [] }));
  const out = [];
  for (const q of dataset.questions) {
    const kb = JSON.parse(fs.readFileSync(kbPaths.sceneKb(q.videoId), 'utf8'));
    const scene = currentScene(kb, q.cursorTime);
    const db = loadDb(kb.show_id);
    const charNames = [], charAliases = [];
    for (const cid of idsOf(scene)) {
      const e = (db.characters || []).find(c => c.character_id === cid); if (!e) continue;
      if (e.display_name_zh) charNames.push(e.display_name_zh);
      if (e.canonical_name) charAliases.push(e.canonical_name);
      if (Array.isArray(e.aliases)) charAliases.push(...e.aliases);
      if (e.short_identity_zh) charAliases.push(e.short_identity_zh);
    }
    const chunks = await retrieve({
      query: q.query, characterNames: charNames, characterAliases: charAliases, k: 8,
      cursor: { show_id: kb.show_id, video_id: q.videoId, season: kb.season, episode: cursorAtTime(kb, q.cursorTime), cursorTime: q.cursorTime, allowedSpoilerLevel: 0 },
      currentScene: scene, characterIds: idsOf(scene), _deps: deps,
    });
    out.push({
      id: q.id, videoId: q.videoId, cursorTime: q.cursorTime, knowledge_type: q.knowledge_type, query: q.query,
      chunks: chunks.map(c => ({ id: c.id, knowledge_type: c.knowledge_type, content: String(c.content || '').slice(0, 400) })),
    });
    process.stdout.write(`\r  retrieval ${out.length}/${dataset.questions.length}`);
  }
  process.stdout.write('\n');
  return out;
}

async function buildAnswers(dataset) {
  const out = [];
  for (const q of dataset.questions) {
    // Per-item isolation: a flaky-proxy failure on any single answer must never abort the build.
    let context = null, answer = '', err = null;
    try { ({ context } = await withRetry(() => answerEval.buildContext(q))); }
    catch (e) { err = 'context: ' + e.message; }
    if (context) {
      try { answer = await withRetry(() => answerEval.generate(context, q.question)); }
      catch (e) { answer = '(生成失败: ' + e.message + ')'; }
    } else {
      answer = '(生成失败: ' + err + ')';
    }
    const sc = (context && context.current_scene) || {};
    out.push({
      id: q.id, videoId: q.videoId, t: q.t, question: q.question, prompt_kind: q.prompt_kind,
      answer,
      reference: {
        scene_id: sc.scene_id || null,
        plot_fact: sc.plot_fact || null,
        plot_reading: sc.plot_reading || null,
        characters_on_screen: sc.characters_on_screen || [],
        retrieved: ((context && context.retrieved_knowledge) || []).slice(0, 5).map(r => ({ knowledge_type: r.knowledge_type, content: String(r.content || '').slice(0, 260) })),
      },
    });
    process.stdout.write(`\r  answers ${out.length}/${dataset.questions.length}`);
  }
  process.stdout.write('\n');
  return out;
}

async function main() {
  const retrievalSet = JSON.parse(fs.readFileSync(path.join(DATASETS, 'annotate_retrieval.json'), 'utf8'));
  const answerSet = JSON.parse(fs.readFileSync(path.join(DATASETS, 'annotate_answers.json'), 'utf8'));

  const client = (process.env.OPENAI_API_KEY && process.env.RETRIEVAL_DENSE !== 'off')
    ? (() => { try { return require('../../lib/ai/openai-client').createOpenAIClient(); } catch { return null; } })() : null;
  const embedCache = loadEmbedCache();
  console.log('▶ 预热查询向量 …');
  await prewarm(retrievalSet.questions.map(q => q.query), client, embedCache);

  console.log('▶ 跑检索（54 题）…');
  const retrieval = await buildRetrieval(retrievalSet, { embedClient: client, embedCache });
  console.log('▶ 生成回答（40 题，走缓存）…');
  const answers = await buildAnswers(answerSet);

  const data = { generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }), retrieval, answers };
  const html = require('./lib/annotation-page').render(data);
  fs.writeFileSync(OUT, html, 'utf8');
  console.log(`\n✓ 标注页已生成：${OUT}`);
  console.log(`  检索 ${retrieval.length} 题 · 回答 ${answers.length} 题。浏览器打开、逐条标注、点「导出」下载 JSON。`);
}

main().catch(e => { console.error(e); process.exit(1); });
