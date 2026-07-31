#!/usr/bin/env node
// LLM first-pass annotation: grades every retrieval item's chunks (核心/相关/无关) and every
// answer (factuality + helpfulness), then bakes the labels into eval-annotate.html as
// pre-fills the user only has to CORRECT. Also writes eval-annotations-llm.json (export
// schema) and prints the LLM's version of the scores as a baseline.
//
//   node scripts/eval/llm_annotate.js
//
// Reuses the EXACT data already in eval-annotate.html (same chunks + answers) — no
// regeneration — so the pre-labels line up with what the user sees. LLM calls are cached.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ai = require('../../lib/ai');
const annotationPage = require('./lib/annotation-page');

const HTML = path.join(__dirname, '..', '..', 'eval-annotate.html');
const CACHE_FILE = path.join(__dirname, '.cache', 'llm_annotations.json');
const EXPORT = path.join(__dirname, '..', '..', 'eval-annotations-llm.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, tries = 4) { let e; for (let i = 0; i < tries; i++) { try { return await fn(); } catch (err) { e = err; await sleep(1000 * (i + 1)); } } throw e; }
function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } }
function saveCache(c) { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 1)); }
function hash(o) { return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12); }

function extractData() {
  const html = fs.readFileSync(HTML, 'utf8');
  const line = html.split('\n').find(l => l.startsWith('window.__DATA__ = JSON.parse('));
  return JSON.parse(JSON.parse(line.slice('window.__DATA__ = JSON.parse('.length, line.lastIndexOf(');'))));
}

const REL_SYSTEM = `你在为一个"防剧透观影助手"的检索质量做相关性标注。
给定观众在某个时间点提出的问题，以及系统召回的若干知识块，为每个块打相关性等级：
- 2 = 核心：直接、准确地回答了这个问题（就是用户想要的那条）。
- 1 = 相关：和问题沾边、能作为背景或补充，但不是直接答案。
- 0 = 无关：跟这个问题基本没关系。
只依据块的内容判断，宽松地把"能帮到这个问题"的算 1，只有真正命中的才算 2。必须给每个块一个等级。只输出 JSON。`;
const REL_SCHEMA = { type: 'object', additionalProperties: false, required: ['grades'], properties: {
  grades: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'grade'], properties: {
    id: { type: 'string' }, grade: { type: 'integer', minimum: 0, maximum: 2 } } } } } };

async function gradeRetrieval(item) {
  if (!item.chunks.length) return {};
  const user = `观众问题：${item.query}\n（视频 ${item.videoId}，时间点 ${item.cursorTime}s）\n\n召回的知识块：\n${JSON.stringify(item.chunks.map(c => ({ id: c.id, knowledge_type: c.knowledge_type, content: c.content })), null, 1)}`;
  const { data } = await withRetry(() => ai.generateStructured({ task: 'reasoning', system: REL_SYSTEM,
    messages: [{ role: 'user', content: user }], schema: REL_SCHEMA, schemaName: 'relevance', temperature: 0 }));
  const out = {};
  for (const g of (data.grades || [])) out[g.id] = g.grade;
  for (const c of item.chunks) if (out[c.id] == null) out[c.id] = 0; // default any missed to 无关
  return out;
}

const ANS_SYSTEM = `你在为一个"防剧透观影助手"的回答做质量标注，给两个轴打标签。
判断依据：给定的参考资料（当前场景事实/解读 + 检索到的知识）+ 你对《龙之家族》《权力的游戏》的常识。允许回答补充通用世界观背景（不算编造）。
- factuality 事实性：ok=完全正确；minor=大体对但有小错/小含糊；bad=有明显编造、说错事实或认错人；na=信息不足无法判断。只惩罚"虚构具体剧情/认错身份/与参考冲突"，通用背景补充不惩罚。
- helpfulness 有用性：hi=切题且具体、真帮观众看懂这一幕；mid=对但偏泛；no=答非所问或空话。
note 用一句中文说明扣分点（满分写"无明显问题"）。只输出 JSON。`;
const ANS_SCHEMA = { type: 'object', additionalProperties: false, required: ['factuality', 'helpfulness', 'note'], properties: {
  factuality: { type: 'string', enum: ['ok', 'minor', 'bad', 'na'] },
  helpfulness: { type: 'string', enum: ['hi', 'mid', 'no'] },
  note: { type: 'string' } } };

async function gradeAnswer(item) {
  const ref = item.reference || {};
  const user = `观众问题：${item.question}\n\n参考资料：\n${JSON.stringify({ plot_fact: ref.plot_fact, plot_reading: ref.plot_reading, characters_on_screen: ref.characters_on_screen, retrieved: ref.retrieved }, null, 1)}\n\n被评测的回答：\n"""${item.answer}"""`;
  const { data } = await withRetry(() => ai.generateStructured({ task: 'reasoning', system: ANS_SYSTEM,
    messages: [{ role: 'user', content: user }], schema: ANS_SCHEMA, schemaName: 'answer_label', temperature: 0 }));
  return data;
}

async function main() {
  const data = extractData();
  const cache = loadCache();
  const prelabels = { ret: {}, ans: {} };

  console.log(`▶ 检索相关性预标（${data.retrieval.length} 题）…`);
  let i = 0;
  for (const item of data.retrieval) {
    const key = 'rel:' + hash({ q: item.query, ch: item.chunks.map(c => c.id) });
    if (!cache[key]) { try { cache[key] = await gradeRetrieval(item); saveCache(cache); } catch (e) { cache[key] = {}; } }
    prelabels.ret[item.id] = cache[key];
    process.stdout.write(`\r  ${++i}/${data.retrieval.length}`);
  }
  process.stdout.write('\n');

  console.log(`▶ 回答质量预标（${data.answers.length} 题）…`);
  i = 0;
  for (const item of data.answers) {
    const key = 'ans:' + hash({ q: item.question, a: item.answer });
    if (!cache[key]) { try { cache[key] = await gradeAnswer(item); saveCache(cache); } catch (e) { cache[key] = { factuality: 'na', helpfulness: 'mid', note: 'LLM 判分失败' }; } }
    prelabels.ans[item.id] = cache[key];
    process.stdout.write(`\r  ${++i}/${data.answers.length}`);
  }
  process.stdout.write('\n');

  // Bake pre-labels into the SAME data and re-render the HTML (no regeneration).
  data.prelabels = prelabels;
  fs.writeFileSync(HTML, annotationPage.render(data), 'utf8');

  // Export in the human-export schema so score_annotations.js runs directly.
  const exportJson = { tool: 'hotd-eval-annotation', version: 1, source: 'llm-prelabel', exportedAt: new Date().toISOString(), builtAt: data.generatedAt,
    retrieval: data.retrieval.map(it => ({ id: it.id, videoId: it.videoId, cursorTime: it.cursorTime, knowledge_type: it.knowledge_type, query: it.query, labels: prelabels.ret[it.id] || {}, done: true })),
    answers: data.answers.map(it => ({ id: it.id, videoId: it.videoId, t: it.t, prompt_kind: it.prompt_kind, question: it.question, factuality: (prelabels.ans[it.id] || {}).factuality || null, helpfulness: (prelabels.ans[it.id] || {}).helpfulness || null, note: (prelabels.ans[it.id] || {}).note || '' })) };
  fs.writeFileSync(EXPORT, JSON.stringify(exportJson, null, 1));

  console.log(`\n✓ 预标已烤进 ${HTML}（打开即见 LLM 预标，逐条修正后导出）`);
  console.log(`  LLM 标注副本：${EXPORT}`);
  console.log(`  基线分数：node scripts/eval/score_annotations.js ${path.relative(path.join(__dirname, '..', '..'), EXPORT)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
