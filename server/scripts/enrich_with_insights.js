#!/usr/bin/env node
/**
 * 把 reference knowledge.json（B站解说提炼出的"分析方法"）迁移到原片 KB 上：
 * 对 KB 里每个 scene，参考 knowledge_points 的分析角度，用 scene 自己的事实
 * （shot / characters / plot.fact / subtitles / 关键帧没在这里再调用，因为已在 annotate 阶段编码进 KB）
 * 生成 1-3 条新解读，写回 scene.interpretations。
 *
 *   reference_insights = 参考分析方法（不是事实来源）
 *   target_scene       = 当前片段事实（事实来源）
 *
 * 用法：
 *   node scripts/enrich_with_insights.js <video_id> --insights references/<file>.knowledge.json
 *   node scripts/enrich_with_insights.js <video_id> --insights ... --limit 5
 *
 * Resume：scene.interpretations 已经存在的会被跳过。想强制重跑加 --rebuild。
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    videoId: null,
    insights: null,
    model: DEFAULT_MODEL,
    limit: null,
    rebuild: false,
    sceneId: null,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--insights' && args[i + 1]) { opts.insights = args[++i]; continue; }
    if (args[i] === '--model' && args[i + 1]) { opts.model = args[++i]; continue; }
    if (args[i] === '--limit' && args[i + 1]) { opts.limit = parseInt(args[++i], 10); continue; }
    if (args[i] === '--scene' && args[i + 1]) { opts.sceneId = args[++i]; continue; }
    if (args[i] === '--rebuild') { opts.rebuild = true; continue; }
    if (args[i] === '-h' || args[i] === '--help') { opts.help = true; continue; }
    if (!opts.videoId && !args[i].startsWith('--')) opts.videoId = args[i];
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/enrich_with_insights.js <video_id> --insights <knowledge.json> [options]

Options:
  --insights <path>  Reference knowledge.json from extract_srt_essence.js (required)
  --model <name>     OpenAI model (default: ${DEFAULT_MODEL})
  --limit <N>        Process first N scenes only (debug)
  --scene <id>       Process only one scene (e.g. s07)
  --rebuild          Re-generate interpretations even if already present
  -h, --help         Show help

Reads kb/<video_id>.json (from annotate.js) and writes back in place,
adding scene.interpretations[] to each annotated scene.
`);
}

const SYSTEM_PROMPT = `你是影视镜头解读 Agent。

你会收到两类信息：
A. reference_insights：从一段影视解说视频提炼出的分析观点。它们只是"参考分析角度/范式"，不能直接照搬，更不能当作 target_scene 的事实。
B. target_scene：原片当前片段的事实（plot.fact、shot、characters、subtitles、narrative 等）。这才是事实来源。

任务：
1. 参考 reference_insights 的分析方法（如"低角度强化压迫感"、"空镜延长情绪余韵"），而不是复制原句。
2. 对 target_scene 生成 1-3 条新影视解读。
3. 优先从镜头语言、人物动机、情绪节奏、伏笔暗示、导演手法中选择最相关的角度。
4. 如果 reference_insights 没有任何能套用的分析方法，宁可少出（甚至 0 条），不要强行套用。
5. 不要编造 target_scene 字段里没有的画面/台词/情节。
6. 不要剧透 target_scene 之后的剧情；只解读当前片段呈现出的内容。
7. analysis 必须基于 target_scene 的具体细节（提到 shot.framing / characters[].emotion / plot.fact 之类的真实字段）。
8. reference_used 写"参考了哪类分析角度"，例如"低角度→权力压迫"或"空镜→情绪延长"，不要直接引用 reference_insights 原文。

只输出严格 JSON，不要 Markdown，不要解释。`;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['interpretations'],
  properties: {
    interpretations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'title', 'analysis', 'reference_used', 'sidebar_hint', 'confidence'],
        properties: {
          type: { type: 'string', enum: ['shot_analysis', 'character', 'foreshadow', 'emotion', 'directing'] },
          title: { type: 'string' },
          analysis: { type: 'string' },
          reference_used: { type: 'string' },
          sidebar_hint: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

function buildSceneContext(scene) {
  return {
    scene_id: scene.scene_id,
    time: `${scene.start_time}s - ${scene.end_time}s`,
    plot: scene.plot || null,
    narrative: scene.narrative || null,
    shot: scene.shot || null,
    characters: scene.characters || [],
    foreshadow: scene.foreshadow ? {
      is_setup_for: scene.foreshadow.is_setup_for,
      setup_hint: scene.foreshadow.setup_hint,
    } : null,
    tags: scene.tags || [],
    subtitles: (scene.subtitles || []).map(s => s.text || s).slice(0, 12),
  };
}

function trimInsightsForPrompt(knowledgePoints) {
  return knowledgePoints.map(kp => ({
    type: kp.type,
    title: kp.title,
    summary: kp.summary,
    use_in_agent: kp.use_in_agent,
    related_characters: kp.related_characters,
    related_symbols: kp.related_symbols,
  }));
}

async function generateForScene(client, model, scene, insights) {
  const userPrompt = `reference_insights（参考分析方法，不是事实）：
${JSON.stringify(insights, null, 2)}

target_scene（当前片段事实）：
${JSON.stringify(buildSceneContext(scene), null, 2)}

请生成 1-3 条 interpretation。如无可套用的分析角度，可返回空数组。`;

  const res = await client.chat.completions.create({
    model,
    temperature: 0.35,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'scene_interpretations', strict: true, schema: RESPONSE_SCHEMA },
    },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
  return JSON.parse(res.choices[0].message.content);
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();
  if (!opts.videoId) {
    console.error('Error: <video_id> is required.\n');
    printHelp();
    process.exit(1);
  }
  if (!opts.insights) {
    console.error('Error: --insights <path> is required.\n');
    printHelp();
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY not set (server/.env)');
    process.exit(1);
  }

  const serverDir = path.join(__dirname, '..');
  const kbPath = path.join(serverDir, 'kb', `${opts.videoId}.json`);
  if (!fs.existsSync(kbPath)) {
    console.error(`Error: KB not found: ${kbPath}`);
    console.error(`Run preprocess + annotate first.`);
    process.exit(1);
  }
  if (!fs.existsSync(opts.insights)) {
    console.error(`Error: insights file not found: ${opts.insights}`);
    process.exit(1);
  }

  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const knowledge = JSON.parse(fs.readFileSync(opts.insights, 'utf8'));
  const knowledgePoints = Array.isArray(knowledge.knowledge_points) ? knowledge.knowledge_points : [];
  if (knowledgePoints.length === 0) {
    console.error('Error: insights file has no knowledge_points.');
    process.exit(1);
  }
  console.log(`Loaded KB: ${kb.scenes.length} scenes`);
  console.log(`Loaded insights: ${knowledgePoints.length} knowledge points (${path.basename(opts.insights)})`);

  const trimmedInsights = trimInsightsForPrompt(knowledgePoints);

  let scenes = kb.scenes;
  if (opts.sceneId) {
    scenes = scenes.filter(s => s.scene_id === opts.sceneId);
    if (scenes.length === 0) {
      console.error(`Scene ${opts.sceneId} not found in KB.`);
      process.exit(1);
    }
  }
  if (opts.limit) scenes = scenes.slice(0, opts.limit);

  const OpenAI = require('openai');
  const client = new OpenAI();

  let done = 0, skipped = 0, generated = 0;
  for (const scene of scenes) {
    if (!opts.rebuild && Array.isArray(scene.interpretations)) {
      skipped++;
      continue;
    }
    if (!scene.plot && !scene.shot) {
      console.warn(`  ${scene.scene_id}: no annotation yet (run annotate.js first); skipping`);
      skipped++;
      continue;
    }
    const t0 = Date.now();
    process.stdout.write(`  ${scene.scene_id}  `);
    try {
      const result = await generateForScene(client, opts.model, scene, trimmedInsights);
      scene.interpretations = result.interpretations || [];
      generated += scene.interpretations.length;
      done++;
      fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2));
      console.log(`+${scene.interpretations.length} interpretations  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      console.log(`✗ ${e.message}`);
      throw e;
    }
  }

  console.log(`\n✓ Done.`);
  console.log(`  scenes processed:    ${done}`);
  console.log(`  scenes skipped:      ${skipped}`);
  console.log(`  interpretations:     ${generated}`);
  console.log(`  KB written:          ${path.relative(process.cwd(), kbPath)}`);
}

main().catch(err => {
  console.error(`\n✗ ERROR: ${err.message}`);
  if (err.status) console.error(`  HTTP ${err.status}`);
  process.exit(1);
});
