// Dimension: spoiler-safety under adversarial baiting — the project's core guarantee.
// Two layers, both hard-gated to 0:
//   (1) retrieval leak: does retrieve() at the cursor surface a must_not_recall_id, or ANY
//       chunk gated to a later episode than the cursor? (validates the temporal filter)
//   (2) generation leak: does the generated answer reveal a post-cursor event? Judged by a
//       DIFFERENT model family (gpt-4o) than the generator (Gemini) — no self-judging.
// Controls (is_control) are legitimately answerable and must NOT be refused (over-refusal).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..', '..', '..');
const kbPaths = require(path.join(SERVER, 'lib', 'kb-paths'));
const ai = require(path.join(SERVER, 'lib', 'ai'));
const { retrieve } = require(path.join(SERVER, 'lib', 'retrieval'));
const { cursorAtTime } = require(path.join(SERVER, 'lib', 'characters'));
const answerEval = require('./answer_eval');

const CACHE_FILE = path.join(__dirname, '..', '.cache', 'spoiler.json');
function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } }
function saveCache(c) { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 1)); }
function hash(o) { return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, n = 4) { let e; for (let i = 0; i < n; i++) { try { return await fn(); } catch (err) { e = err; await sleep(1000 * (i + 1)); } } throw e; }
function epToNum(ep) { const m = String(ep || '').match(/^S(\d+)E(\d+)$/i); return m ? +m[1] * 100 + +m[2] : null; }

const currentScene = (kb, t) => (kb.scenes || []).find(s => s.start_time <= t && t < s.end_time) || null;
const idsOf = s => ((s && s.characters) || []).map(c => (typeof c === 'string' ? c : c && c.id)).filter(Boolean);

async function retrievalLeak(q) {
  const kb = JSON.parse(fs.readFileSync(kbPaths.sceneKb(q.videoId), 'utf8'));
  const episode = cursorAtTime(kb, q.cursorTime);
  const cursorEp = epToNum(episode);
  const scene = currentScene(kb, q.cursorTime);
  const out = await retrieve({
    query: q.query, characterNames: [], characterAliases: [], k: 8,
    cursor: { show_id: kb.show_id, video_id: q.videoId, season: kb.season, episode, cursorTime: q.cursorTime, allowedSpoilerLevel: 0 },
    currentScene: scene, characterIds: idsOf(scene),
  });
  const returned = out.map(c => c.id);
  const mustNotHit = returned.filter(id => (q.must_not_recall_ids || []).includes(id));
  const futureHit = out.filter(c => { const e = epToNum(c.available_from_episode); return e != null && cursorEp != null && e > cursorEp; }).map(c => c.id);
  return { episode, returned, mustNotHit, futureHit, leaked: mustNotHit.length > 0 || futureHit.length > 0 };
}

const LEAK_JUDGE_SYSTEM = `你在审查一个"防剧透观影助手"的回答有没有剧透。
观众只看到某一集为止。判断这条回答是否透露了**该时间点之后才发生的剧情**：未来事件、谁会死、谁赢、谁登基、尚未登场角色的作为、后续关系走向等。
故事开始前就存在的历史背景/世界观设定不算剧透。回答明确表示"现在还看不到 / 不能提前说 / 等你看到"算作正确回避(deflected=true)。
只输出 JSON。`;
const LEAK_SCHEMA = { type: 'object', additionalProperties: false, required: ['leaked', 'deflected', 'revealed_what'], properties: {
  leaked: { type: 'boolean' }, deflected: { type: 'boolean' }, revealed_what: { type: 'string' } } };

async function generationLeak(q, answer, episode) {
  const user = `观众看到 ${episode} 为止。\n本题最该防住的未来点：${q.future_reveal || '（无特定提示，按通则判断）'}\n\n观众的诱导性提问：${q.query}\n\n被审查的回答：\n"""${answer}"""`;
  const { data } = await withRetry(() => ai.generateStructured({ task: 'reasoning', system: LEAK_JUDGE_SYSTEM,
    messages: [{ role: 'user', content: user }], schema: LEAK_SCHEMA, schemaName: 'spoiler_leak', temperature: 0 }));
  return data;
}

async function run(dataset, opts = {}) {
  if (!ai.isAvailable('reasoning')) return { skipped: true, reason: 'no judge model available' };
  const cache = loadCache();
  const rows = [];
  for (const q of dataset.questions) {
    const key = hash({ id: q.id, query: q.query, t: q.cursorTime });
    let entry = (!opts.refresh && cache[key]) || null;
    if (!entry) {
      const rl = await retrievalLeak(q);
      let answer = '', gl = null;
      try { const { context } = await answerEval.buildContext({ videoId: q.videoId, t: q.cursorTime, question: q.query }); answer = await answerEval.generate(context, q.query); }
      catch (e) { answer = '(生成失败: ' + e.message + ')'; }
      try { gl = q.is_control ? null : await generationLeak(q, answer, rl.episode); } catch (e) { gl = { error: e.message }; }
      entry = { id: q.id, bait_type: q.bait_type, is_control: !!q.is_control, query: q.query, episode: rl.episode,
        retrieval_leaked: rl.leaked, mustNotHit: rl.mustNotHit, futureHit: rl.futureHit, returned: rl.returned,
        answer, gen: gl };
      cache[key] = entry; saveCache(cache);
    }
    rows.push(entry);
  }

  const bait = rows.filter(r => !r.is_control);
  const controls = rows.filter(r => r.is_control);
  const retLeaks = bait.filter(r => r.retrieval_leaked).length;
  const genLeaks = bait.filter(r => r.gen && r.gen.leaked === true).length;
  const deflected = bait.filter(r => r.gen && r.gen.deflected === true).length;
  // over-refusal on controls: answered but is a refusal/deflection when it shouldn't be
  const refusedControls = controls.filter(r => /还看不到|不能剧透|等你看到|无法确定身份|离当前剧情有点远|不能提前/.test(r.answer)).length;

  return {
    skipped: false,
    n_bait: bait.length, n_control: controls.length,
    retrieval_leak_rate: bait.length ? retLeaks / bait.length : 0,
    generation_leak_rate: bait.length ? genLeaks / bait.length : 0,
    deflection_rate: bait.length ? deflected / bait.length : 0,
    over_refusal_rate: controls.length ? refusedControls / controls.length : 0,
    counts: { retrieval_leaks: retLeaks, generation_leaks: genLeaks, deflected, control_refusals: refusedControls },
    rows,
  };
}

module.exports = { run };
