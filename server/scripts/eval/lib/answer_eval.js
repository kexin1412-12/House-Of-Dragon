// Dimension ②: LLM answer quality on the active Q&A path.
// For each viewer question we reconstruct the production context — spoiler-safe
// retrieve() knowledge + the current cursor-filtered scene slice + on-screen
// relations — generate an answer with the real dialogue system prompt + model,
// then have an LLM judge score it against THAT SAME context (so faithfulness and
// no-spoiler are measured relative to what the generator was actually given).
//
// Non-deterministic (calls the model), so generations + judgments are cached to
// .cache/answers.json keyed by a hash of the inputs. Re-runs read the cache unless
// opts.refresh is set. With no API key the whole dimension reports "skipped".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..', '..', '..');
const kbPaths = require(path.join(SERVER, 'lib', 'kb-paths'));
const ai = require(path.join(SERVER, 'lib', 'ai'));
const { retrieve } = require(path.join(SERVER, 'lib', 'retrieval'));
const { cursorAtTime, lookupRelationships } = require(path.join(SERVER, 'lib', 'characters'));
const { buildDialogueSystemPrompt } = require(path.join(SERVER, 'prompts', 'dialogue'));

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'answers.json');
const SYSTEM_PROMPT = buildDialogueSystemPrompt();

const currentScene = (kb, t) => (kb.scenes || []).find(s => s.start_time <= t && t < s.end_time) || null;
const sceneCharIds = (scene) =>
  ((scene && scene.characters) || []).map(c => (typeof c === 'string' ? c : c && c.id)).filter(Boolean);

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}
function hash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}

// Reconstruct the spoiler-safe context the production streaming endpoint assembles (text-only).
async function buildContext(q) {
  const kb = JSON.parse(fs.readFileSync(kbPaths.sceneKb(q.videoId), 'utf8'));
  const db = (() => {
    const p = kbPaths.charactersDb(kb.show_id);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { characters: [] };
  })();
  const scene = currentScene(kb, q.t);
  const episode = cursorAtTime(kb, q.t);
  const charIds = sceneCharIds(scene);

  const nameOf = (cid) => (db.characters || []).find(c => c.character_id === cid)?.display_name_zh || cid;
  const charNames = [], charAliases = [];
  for (const cid of charIds) {
    const e = (db.characters || []).find(c => c.character_id === cid);
    if (!e) continue;
    if (e.display_name_zh) charNames.push(e.display_name_zh);
    if (e.canonical_name) charAliases.push(e.canonical_name);
    if (Array.isArray(e.aliases)) charAliases.push(...e.aliases);
    if (e.house) charAliases.push(e.house);
    if (e.short_identity_zh) charAliases.push(e.short_identity_zh);
  }

  const retrieved = await retrieve({
    query: q.question, characterNames: charNames, characterAliases: charAliases, k: 8,
    cursor: {
      show_id: kb.show_id, video_id: q.videoId, season: kb.season,
      episode, cursorTime: q.t, allowedSpoilerLevel: 0,
    },
    currentScene: scene, characterIds: charIds,
  });

  // On-screen pairwise relations, cursor-filtered & de-duped (mirrors agent.js).
  const relations = [];
  if (db.characters && charIds.length >= 2) {
    const seen = new Set();
    for (const aId of charIds) {
      for (const r of lookupRelationships(db, aId, episode)) {
        if (!charIds.includes(r.with)) continue;
        const key = [aId, r.with].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        relations.push({ between: [nameOf(aId), nameOf(r.with)], relation: r.relation || r.relation_kind || '关系', summary: r.summary || null });
      }
    }
  }

  const context = {
    video_title: kb.title,
    current_time: q.t,
    current_scene: scene ? {
      scene_id: scene.scene_id,
      time_range: [scene.start_time, scene.end_time],
      plot_fact: scene.plot?.fact || null,
      plot_reading: scene.plot?.reading || null,
      shot_intent: scene.shot?.intent || null,
      tags: scene.tags || [],
      foreshadow_setup_hint: scene.foreshadow?.setup_hint || null,
      characters_on_screen: charIds.map(nameOf),
    } : null,
    on_screen_relations: relations,
    retrieved_knowledge: retrieved.map(r => ({ id: r.id, knowledge_type: r.knowledge_type, content: r.content })),
  };
  return { context, episode };
}

async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; }
  }
  throw last;
}

async function generate(context, question) {
  const userMessage = `Context:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n用户问题：${question}`;
  const result = await withRetry(() => ai.chat({
    task: 'chat', system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 420, temperature: 0.4,
  }));
  return result.text || '';
}

const JUDGE_SYSTEM = `你是一个严格的评测裁判，评价一个"防剧透观影助手"对观众提问的回答质量。
你只能依据给定的 CONTEXT（这是回答生成时唯一可用的、已按观看进度过滤过的资料）来判断，不要用你自己对剧情后续的了解。
按三个维度各打 1-5 分（整数）：
- faithfulness 忠实度：回答的每一句是否都能在 CONTEXT 里找到依据，有没有编造/张冠李戴。5=完全有据，1=大量臆造。
- helpfulness 有用性：是否切题、具体、真正帮观众理解当前这一幕（而不是空泛套话或答非所问）。5=非常有用，1=没用。
- no_spoiler 无剧透：回答有没有引入 CONTEXT 之外、超出当前观看进度的未来剧情信息。5=完全没有超前信息，1=明显剧透。
只输出 JSON。rationale 用一句中文说明扣分原因（若满分写"无明显问题"）。`;

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    faithfulness: { type: 'integer', minimum: 1, maximum: 5 },
    helpfulness: { type: 'integer', minimum: 1, maximum: 5 },
    no_spoiler: { type: 'integer', minimum: 1, maximum: 5 },
    rationale: { type: 'string' },
  },
  required: ['faithfulness', 'helpfulness', 'no_spoiler', 'rationale'],
};

async function judge(context, question, answer) {
  const userMessage = `CONTEXT:\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n观众问题：${question}\n\n被评测的回答：\n"""${answer}"""`;
  const data = await withRetry(() => ai.generateStructured({
    task: 'reasoning', system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
    schema: JUDGE_SCHEMA, schemaName: 'answer_judgment', temperature: 0,
  }));
  // ai.generateStructured wraps the parsed object as { data, provider, model }.
  return data && typeof data === 'object' && data.data ? data.data : data;
}

async function run(dataset, opts = {}) {
  if (!ai.isAvailable('chat')) {
    return { skipped: true, reason: 'no chat provider / API key configured', per_question: [] };
  }
  const cache = loadCache();
  const perQuestion = [];
  let fSum = 0, hSum = 0, sSum = 0, judged = 0;

  for (const q of dataset.questions) {
    const { context, episode } = await buildContext(q);
    const key = hash({ id: q.id, videoId: q.videoId, t: q.t, question: q.question });

    let entry = (!opts.refresh && cache[key]) || null;
    if (!entry) {
      let answer = '';
      try { answer = await generate(context, q.question); }
      catch (e) { answer = ''; }
      let judgment = null;
      if (answer) {
        try { judgment = await judge(context, q.question, answer); }
        catch (e) { judgment = { error: e.message }; }
      } else {
        judgment = { error: 'generation failed after retries' };
      }
      entry = {
        id: q.id, videoId: q.videoId, t: q.t, episode, question: q.question,
        answer, judgment,
        retrieved_ids: context.retrieved_knowledge.map(r => r.id),
        scene_id: context.current_scene?.scene_id || null,
        generated_at: new Date().toISOString(),
      };
      cache[key] = entry;
      saveCache(cache);
    }

    const j = entry.judgment || {};
    if (typeof j.faithfulness === 'number') {
      fSum += j.faithfulness; hSum += j.helpfulness; sSum += j.no_spoiler; judged++;
    }
    perQuestion.push({ ...entry, cached: !opts.refresh && !!cache[key] });
  }

  const denom = judged || 1;
  return {
    skipped: false,
    n: dataset.questions.length,
    judged,
    avg_faithfulness: fSum / denom,
    avg_helpfulness: hSum / denom,
    avg_no_spoiler: sSum / denom,
    avg_overall: (fSum + hSum + sSum) / (3 * denom),
    per_question: perQuestion,
  };
}

module.exports = { run };
