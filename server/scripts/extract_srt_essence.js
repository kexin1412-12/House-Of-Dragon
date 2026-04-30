#!/usr/bin/env node
/**
 * 把 B站影视解说 SRT 抽成两份产物：
 *   <name>.chunks.json    — 按 ~90s 切块，每块逐条 essence_points
 *   <name>.knowledge.json — 跨段去重合并后的 knowledge_points（可直接接 KB）
 *
 * 用法：
 *   node scripts/extract_srt_essence.js references/<file>.srt
 *   node scripts/extract_srt_essence.js <srt> --model gpt-4o-mini --chunk 90 --limit 5
 *
 * Resume：chunk 阶段每完成一块就落盘，崩了重跑会从已写入的下一块继续。
 * 想重跑某 chunk，把对应位置从 .chunks.json 里删掉即可。
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_CHUNK_SECONDS = 90;
const MERGE_BATCH = 15; // 单次 merge 最多塞这么多 chunk 结果，多了走分层 merge
const MERGE_MAX_TOKENS = 16000; // 给足输出额度，防 JSON 被截断

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    srtPath: null,
    model: DEFAULT_MODEL,
    chunkSeconds: DEFAULT_CHUNK_SECONDS,
    limit: null,
    skipMerge: false,
    mergeOnly: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) { opts.model = args[++i]; continue; }
    if (args[i] === '--chunk' && args[i + 1]) { opts.chunkSeconds = parseInt(args[++i], 10); continue; }
    if (args[i] === '--limit' && args[i + 1]) { opts.limit = parseInt(args[++i], 10); continue; }
    if (args[i] === '--skip-merge') { opts.skipMerge = true; continue; }
    if (args[i] === '--merge-only') { opts.mergeOnly = true; continue; }
    if (args[i] === '-h' || args[i] === '--help') { opts.help = true; continue; }
    if (!opts.srtPath && !args[i].startsWith('--')) opts.srtPath = args[i];
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/extract_srt_essence.js <srt_path> [options]

Options:
  --model <name>     OpenAI model (default: ${DEFAULT_MODEL})
  --chunk <seconds>  Chunk window size (default: ${DEFAULT_CHUNK_SECONDS})
  --limit <N>        Only process first N chunks (debug)
  --skip-merge       Only do per-chunk extraction, skip the merge step
  -h, --help         Show help

Outputs (next to the SRT):
  <name>.chunks.json     per-chunk essence_points
  <name>.knowledge.json  merged knowledge_points (KB-ready)
`);
}

function parseSRT(srtText) {
  return srtText
    .replace(/\r/g, '')
    .replace(/^﻿/, '')
    .split(/\n\n+/)
    .map(block => {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      const timeLine = lines.find(l => l.includes('-->'));
      if (!timeLine) return null;
      const textLines = lines.filter(l => !/^\d+$/.test(l) && !l.includes('-->'));
      const [start, end] = timeLine.split('-->').map(s => s.trim());
      const text = textLines
        .join(' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) return null;
      return { start, end, text };
    })
    .filter(Boolean);
}

function timeToSeconds(t) {
  const [h, m, rest] = t.replace(',', '.').split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(rest);
}

function chunkSubtitles(items, chunkSeconds) {
  const groups = [];
  let current = [];
  let chunkStart = null;
  for (const item of items) {
    const startSec = timeToSeconds(item.start);
    if (chunkStart === null) chunkStart = startSec;
    if (startSec - chunkStart > chunkSeconds && current.length) {
      groups.push(current);
      current = [];
      chunkStart = startSec;
    }
    current.push(item);
  }
  if (current.length) groups.push(current);
  return groups.map(g => ({
    start: g[0].start,
    end: g[g.length - 1].end,
    lineCount: g.length,
    text: g.map(it => `[${it.start} - ${it.end}] ${it.text}`).join('\n'),
  }));
}

const EXTRACT_SYSTEM = `你是影视解说内容精炼 Agent。
输入是一段 B站影视解析视频字幕，里面混着寒暄/废话/重复表达/纯剧情复述，以及真正有价值的导演/镜头/伏笔/人物分析。

只提取以下高价值内容：
1. 镜头语言：构图、景别、运镜、光线、色彩、剪辑、音乐、空镜、特写、视角变化。
2. 伏笔暗示：提前出现但后面才有意义的细节、象征物、重复出现的画面、台词呼应。
3. 人物动机：角色为什么这样做、为什么沉默、为什么撒谎、为什么转变态度。
4. 情绪节奏：紧张感、压迫感、悲伤感、反转感、高潮前铺垫。
5. 导演手法：信息隐藏、视角限制、节奏控制、镜头对比、声画关系。
6. 世界观背景（标 lore）：设定、家族、历史、物件解释。
7. 观众容易错过的细节：理解后会显著提升观看体验的点。

过滤：
- 删寒暄、关注点赞、广告、口头禅。
- 删纯剧情复述（除非它在为某个分析观点服务）。
- 不要编字幕里没说的内容。
- 不要直接复制字幕大段，要改写成短句。
- 观点不明确则 confidence 偏低。
- 每个观点尽量保留依据。

只输出严格 JSON，不要 Markdown，不要解释。`;

function extractUserPrompt(chunk, idx) {
  return `chunk_index: ${idx}
chunk_start: ${chunk.start}
chunk_end:   ${chunk.end}

字幕：
${chunk.text}

输出格式（严格 JSON）：
{
  "chunk_start": "${chunk.start}",
  "chunk_end": "${chunk.end}",
  "essence_points": [
    {
      "id": "c${String(idx).padStart(3, '0')}_p1",
      "type": "shot_analysis | foreshadow | character | emotion | directing | lore | missable_detail | plot",
      "title": "一句话标题",
      "point": "详细观点，写清楚为什么重要",
      "evidence": "字幕里支持这个观点的依据，改写表达",
      "visual_or_audio_cue": "画面/音乐/剪辑线索；没有写 null",
      "related_character": ["人物名"],
      "related_symbol": ["符号/物件/场景"],
      "viewer_value": "观众理解后会更懂什么",
      "usable_sidebar_hint": "≤35字，AI 侧栏短提示",
      "possible_user_questions": ["用户可能怎么问"],
      "agent_answer": "1-3句不剧透回答",
      "confidence": 0.0
    }
  ],
  "low_value_removed": ["被过滤的低价值类型，如 寒暄/重复剧情复述"]
}`;
}

const MERGE_SYSTEM = `你是影视知识库整理 Agent。
输入是从同一条解说视频逐段提取出的分析点，会有重复/相近/低质量项。

任务：
1. 合并重复观点（同一个 shot/foreshadow/角色动机的多次出现，归并成一个更完整的 knowledge point）。
2. 删除空泛、没有依据、过度泛化的项。
3. 保留细节丰富的、能直接服务"AI 观影解读侧栏"的项。
4. 改写成产品知识库表达，不要直接复制原字幕。
5. kid 从 kp_001 起按顺序编号。

只输出严格 JSON，不要 Markdown，不要解释。`;

function mergeUserPrompt(items) {
  return `逐段结果：
${JSON.stringify(items)}

输出格式（严格 JSON）：
{
  "source_summary": {
    "main_topic": "这条解说视频主要分析什么",
    "valuable_for_demo": "最适合补充哪类产品能力",
    "overall_quality": 0.0
  },
  "knowledge_points": [
    {
      "kid": "kp_001",
      "type": "shot_analysis | foreshadow | character | emotion | directing | lore | missable_detail | plot",
      "title": "知识点标题",
      "summary": "完整说明",
      "evidence": ["依据1", "依据2"],
      "related_characters": [],
      "related_symbols": [],
      "related_scene_or_moment": "如果字幕提到具体情节/场景",
      "use_in_agent": "什么情况下被 Agent 调用",
      "safe_hint": "侧栏不剧透短提示",
      "expanded_explanation": "用户点开后的详细解释",
      "possible_user_questions": [],
      "recommended_card_type": "shot | foreshadow | character | emotion | lore | missed",
      "importance": 0.0,
      "confidence": 0.0
    }
  ]
}`;
}

async function callJSON(client, model, system, user, maxTokens) {
  const req = {
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (maxTokens) req.max_tokens = maxTokens;
  const res = await client.chat.completions.create(req);
  const txt = res.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error(`Model returned non-JSON: ${e.message}\n--- raw ---\n${txt.slice(0, 500)}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();
  if (!opts.srtPath) {
    console.error('Error: <srt_path> is required.\n');
    printHelp();
    process.exit(1);
  }
  if (!fs.existsSync(opts.srtPath)) {
    console.error(`Error: SRT not found: ${opts.srtPath}`);
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY not set (server/.env)');
    process.exit(1);
  }

  const srt = fs.readFileSync(opts.srtPath, 'utf-8');
  const items = parseSRT(srt);
  console.log(`Parsed ${items.length} subtitle entries from ${path.basename(opts.srtPath)}`);

  let chunks = chunkSubtitles(items, opts.chunkSeconds);
  console.log(`Split into ${chunks.length} chunks (~${opts.chunkSeconds}s each)`);
  if (opts.limit && opts.limit < chunks.length) {
    chunks = chunks.slice(0, opts.limit);
    console.log(`(--limit) processing first ${chunks.length}`);
  }

  const OpenAI = require('openai');
  const client = new OpenAI();

  const baseDir = path.dirname(opts.srtPath);
  const baseName = path.basename(opts.srtPath, path.extname(opts.srtPath));
  const chunksOut = path.join(baseDir, `${baseName}.chunks.json`);
  const mergedOut = path.join(baseDir, `${baseName}.knowledge.json`);

  let chunkResults = [];
  if (fs.existsSync(chunksOut)) {
    try {
      const arr = JSON.parse(fs.readFileSync(chunksOut, 'utf-8'));
      if (Array.isArray(arr)) chunkResults = arr;
    } catch { /* ignore corrupt resume file */ }
  }
  const startIdx = chunkResults.length;
  if (startIdx > 0) console.log(`Resuming: ${startIdx} chunks already done, continuing from ${startIdx + 1}`);

  if (opts.mergeOnly) {
    if (chunkResults.length === 0) {
      console.error('Error: --merge-only set but no existing chunks.json to merge from.');
      process.exit(1);
    }
    console.log(`[merge-only] skipping extraction, merging ${chunkResults.length} existing chunks`);
  } else {

  console.log(`\n[1/2] Per-chunk extraction (model=${opts.model})`);
  for (let i = startIdx; i < chunks.length; i++) {
    const t0 = Date.now();
    process.stdout.write(`  [${i + 1}/${chunks.length}] ${chunks[i].start} → ${chunks[i].end}  `);
    try {
      const r = await callJSON(client, opts.model, EXTRACT_SYSTEM, extractUserPrompt(chunks[i], i + 1));
      chunkResults.push(r);
      fs.writeFileSync(chunksOut, JSON.stringify(chunkResults, null, 2));
      const n = Array.isArray(r.essence_points) ? r.essence_points.length : 0;
      console.log(`+${n} pts  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
      throw e;
    }
  }
  console.log(`  → ${path.relative(process.cwd(), chunksOut)}`);

  if (opts.skipMerge) {
    console.log(`\n--skip-merge set; stopping after chunk extraction.`);
    return;
  }

  } // end else (not merge-only)

  const totalPoints = chunkResults.reduce((s, c) => s + (c.essence_points?.length || 0), 0);
  console.log(`\n[2/2] Merging ${chunkResults.length} chunks (${totalPoints} raw points) → knowledge points`);

  let merged;
  if (chunkResults.length <= MERGE_BATCH) {
    merged = await callJSON(client, opts.model, MERGE_SYSTEM, mergeUserPrompt(chunkResults), MERGE_MAX_TOKENS);
  } else {
    const batches = [];
    for (let i = 0; i < chunkResults.length; i += MERGE_BATCH) {
      batches.push(chunkResults.slice(i, i + MERGE_BATCH));
    }
    console.log(`  hierarchical merge: ${batches.length} batches`);
    const partials = [];
    for (let i = 0; i < batches.length; i++) {
      process.stdout.write(`  batch ${i + 1}/${batches.length} ... `);
      const t0 = Date.now();
      const r = await callJSON(client, opts.model, MERGE_SYSTEM, mergeUserPrompt(batches[i]), MERGE_MAX_TOKENS);
      partials.push(r);
      console.log(`${(r.knowledge_points?.length || 0)} pts  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
    process.stdout.write(`  final merge ... `);
    const t0 = Date.now();
    merged = await callJSON(client, opts.model, MERGE_SYSTEM, mergeUserPrompt(partials), MERGE_MAX_TOKENS);
    console.log(`${(merged.knowledge_points?.length || 0)} pts  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  merged.source = {
    platform: 'bilibili',
    type: 'commentary_srt',
    file: path.basename(opts.srtPath),
    processed_at: new Date().toISOString().slice(0, 10),
    model: opts.model,
  };

  fs.writeFileSync(mergedOut, JSON.stringify(merged, null, 2));
  console.log(`\n✓ Done.`);
  console.log(`  chunks:    ${path.relative(process.cwd(), chunksOut)}`);
  console.log(`  knowledge: ${path.relative(process.cwd(), mergedOut)}  (${merged.knowledge_points?.length || 0} points)`);
}

main().catch(err => {
  console.error(`\n✗ ERROR: ${err.message}`);
  if (err.status) console.error(`  HTTP ${err.status}`);
  process.exit(1);
});
