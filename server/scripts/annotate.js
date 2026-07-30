#!/usr/bin/env node
/**
 * LLM-based KB annotation (L1 continuation):
 *   KB skeleton + keyframes (+ optional .srt) → gpt-4o(-mini) with vision
 *   + strict JSON schema → annotated KB
 *
 * Reads server/kb/<video_id>.json (from preprocess.js), sends all keyframes
 * + any subtitle windows in one structured-output call, merges the response
 * back into the KB on disk.
 *
 * Usage:
 *   node scripts/annotate.js <video_id> [--model gpt-4o-mini] [--srt path/to/subs.srt]
 *
 * Or via npm:
 *   npm run annotate -- test_scenes
 *   npm run annotate -- got_s06e10 --model gpt-4o --srt uploads/got.srt
 *
 * NOTE: The annotator sees the WHOLE video (including payoff scenes) on
 * purpose — the KB needs full knowledge to link foreshadows. Spoiler safety
 * is enforced at query time (agent.js filters by cursor_time). The system
 * prompt instructs the model to write `setup_hint` in a non-revealing way.
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const kbPaths = require('../lib/kb-paths');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { videoId: null, model: 'gpt-4o-mini', srt: null, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) { opts.model = args[++i]; continue; }
    if (args[i] === '--srt' && args[i + 1]) { opts.srt = args[++i]; continue; }
    if (args[i] === '-h' || args[i] === '--help') { opts.help = true; continue; }
    if (!opts.videoId && !args[i].startsWith('--')) opts.videoId = args[i];
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/annotate.js <video_id> [options]

Options:
  --model <name>   OpenAI model (default: gpt-4o-mini, also: gpt-4o)
  --srt <path>     Optional .srt subtitle file
  -h, --help       Show this help

Examples:
  node scripts/annotate.js test_scenes
  node scripts/annotate.js got_s06e10 --model gpt-4o --srt uploads/got.srt
`);
}

function srtTimeToSec(t) {
  const [hms, msPart] = t.split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + (Number(msPart || 0) / 1000);
}

function parseSrt(text) {
  return text.split(/\r?\n\r?\n/).map(block => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) return null;
    const [s, e] = timeLine.split('-->').map(t => srtTimeToSec(t.trim()));
    const body = lines.slice(lines.indexOf(timeLine) + 1).join(' ').trim();
    return body ? { start: s, end: e, text: body } : null;
  }).filter(Boolean);
}

function subsForScene(subs, startTime, endTime) {
  return subs
    .filter(s => s.start < endTime && s.end > startTime)
    .map(s => s.text);
}

function imageToDataUrl(imgPath) {
  const data = fs.readFileSync(imgPath);
  const mime = /\.png$/i.test(imgPath) ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${data.toString('base64')}`;
}

const SYSTEM_PROMPT = `你是视频场景标注员。你会收到一部短片的全部关键帧（每个场景一张），按时间顺序排列。为每个场景生成结构化标注。

规则：
1. 你可以看到全片（包括未来场景）——这是故意的，因为 KB 需要完整知识才能支持"伏笔回扣"功能。
2. \`setup_hint\` 字段严格不剧透——只能说"注意这个细节"类的话，**绝不**解释它未来如何回扣、也不提 payoff 场景。
3. \`is_setup_for\` / \`is_payoff_of\` 可以准确填写 scene_id，是内部元数据，不会直接展示给用户。
4. 没有伏笔特征的场景，\`setup_hint\` 填 null，\`is_setup_for\` / \`is_payoff_of\` 填 空数组。
5. \`plot.fact\` 是客观画面描述（一句话），\`plot.reading\` 是叙事层解读（一句话）。
6. \`narrative.importance\` 和 \`shot.importance\` 都是 0.0-1.0 的浮点数，反映该场景在整部短片叙事 / 镜头语言上的权重。
7. \`narrative.phase\` 必须是：setup / rising / development / turning / climax / resolution 之一。
8. 如果画面里没有可辨认的人物（纯环境、纯道具、抽象），\`characters\` 填空数组。
9. \`tags\` 是 3-6 个中文短标签。

为**所有**场景返回完整标注，按给定 schema。`;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scenes'],
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scene_id', 'plot', 'narrative', 'shot', 'characters', 'foreshadow', 'tags'],
        properties: {
          scene_id: { type: 'string' },
          plot: {
            type: 'object',
            additionalProperties: false,
            required: ['fact', 'reading'],
            properties: {
              fact: { type: 'string' },
              reading: { type: 'string' },
            },
          },
          narrative: {
            type: 'object',
            additionalProperties: false,
            required: ['phase', 'importance', 'tension', 'role', 'should_hint'],
            properties: {
              phase: {
                type: 'string',
                enum: ['setup', 'rising', 'development', 'turning', 'climax', 'resolution'],
              },
              importance: { type: 'number' },
              tension: { type: 'number' },
              role: { type: 'string' },
              should_hint: { type: 'boolean' },
            },
          },
          shot: {
            type: 'object',
            additionalProperties: false,
            required: ['framing', 'camera', 'light', 'intent', 'emotion', 'narrative_role', 'importance'],
            properties: {
              framing: { type: 'string' },
              camera: { type: 'string' },
              light: { type: 'string' },
              intent: { type: 'string' },
              emotion: { type: 'string' },
              narrative_role: { type: 'string' },
              importance: { type: 'number' },
            },
          },
          characters: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'emotion', 'motivation_shift'],
              properties: {
                id: { type: 'string' },
                emotion: { type: 'string' },
                motivation_shift: { type: 'string' },
              },
            },
          },
          foreshadow: {
            type: 'object',
            additionalProperties: false,
            required: ['is_setup_for', 'is_payoff_of', 'setup_hint'],
            properties: {
              is_setup_for: { type: 'array', items: { type: 'string' } },
              is_payoff_of: { type: 'array', items: { type: 'string' } },
              setup_hint: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();

  if (!opts.videoId) {
    console.error('Error: <video_id> is required.\n');
    printHelp();
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY not set. Put it in server/.env');
    process.exit(1);
  }

  const serverDir = path.join(__dirname, '..');
  const kbPath = kbPaths.sceneKb(opts.videoId);
  if (!fs.existsSync(kbPath)) {
    console.error(`Error: KB not found: ${kbPath}`);
    console.error(`Run: node scripts/preprocess.js <video_path> first.`);
    process.exit(1);
  }

  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  console.log(`\n[1/3] Loaded KB: ${kb.scenes.length} scenes from ${path.basename(kbPath)}`);

  // Use explicit --srt if given, else auto-detect uploads/<video_id>.srt
  // (that's where transcribe.js writes to).
  let srtPath = opts.srt;
  if (!srtPath) {
    const autoPath = path.join(serverDir, 'uploads', `${opts.videoId}.srt`);
    if (fs.existsSync(autoPath)) srtPath = autoPath;
  }
  let subs = [];
  if (srtPath) {
    if (!fs.existsSync(srtPath)) {
      console.error(`Error: SRT file not found: ${srtPath}`);
      process.exit(1);
    }
    subs = parseSrt(fs.readFileSync(srtPath, 'utf8'));
    console.log(`       Loaded ${subs.length} subtitle lines from ${path.basename(srtPath)}`);
  } else {
    console.log(`       No SRT found (skipping subtitle context — run 'npm run transcribe' first if you want it)`);
  }

  console.log(`\n[2/3] Sending to ${opts.model} (vision + structured output)...`);
  const userContent = [
    {
      type: 'text',
      text: `下面是视频《${kb.title}》的 ${kb.scenes.length} 个场景，按时间顺序排列。每个场景附一张关键帧。

场景 id 列表（必须在 scenes[].scene_id 里全部返回）：${kb.scenes.map(s => s.scene_id).join(', ')}

请按 schema 给每个场景生成完整标注。`,
    },
  ];

  let missingFrames = 0;
  for (const scene of kb.scenes) {
    const keyframeRel = (scene.keyframe || '').replace(/^\//, '');
    const keyframePath = keyframeRel
      ? path.join(serverDir, 'kb', keyframeRel)
      : null;
    if (!keyframePath || !fs.existsSync(keyframePath)) {
      console.warn(`       warning: keyframe missing for ${scene.scene_id}`);
      missingFrames++;
      continue;
    }
    const subLines = subsForScene(subs, scene.start_time, scene.end_time);
    const sceneText = `场景 ${scene.scene_id}（${scene.start_time}s - ${scene.end_time}s）` +
      (subLines.length ? `\n字幕：${subLines.join(' / ')}` : '');
    userContent.push({ type: 'text', text: sceneText });
    userContent.push({
      type: 'image_url',
      image_url: { url: imageToDataUrl(keyframePath), detail: 'auto' },
    });
  }
  if (missingFrames > 0) {
    console.warn(`       ${missingFrames} keyframes missing; those scenes may be under-annotated`);
  }

  const OpenAI = require('openai');
  const client = new OpenAI();

  const t0 = Date.now();
  const resp = await client.chat.completions.create({
    model: opts.model,
    max_tokens: 4000,
    temperature: 0.3,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'kb_annotation',
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    },
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const payload = JSON.parse(resp.choices[0].message.content);
  console.log(`       Received ${payload.scenes.length} annotations in ${elapsed}s`);
  console.log(`       Usage: input ${resp.usage.prompt_tokens} / output ${resp.usage.completion_tokens} tokens`);

  console.log(`\n[3/3] Merging into KB...`);
  const annMap = new Map(payload.scenes.map(s => [s.scene_id, s]));
  let annotated = 0;
  for (const scene of kb.scenes) {
    const ann = annMap.get(scene.scene_id);
    if (!ann) {
      console.warn(`       no annotation for ${scene.scene_id}; keeping skeleton`);
      continue;
    }
    scene.plot = ann.plot;
    scene.narrative = ann.narrative;
    scene.shot = ann.shot;
    scene.characters = ann.characters;
    scene.foreshadow = ann.foreshadow;
    scene.tags = ann.tags;
    annotated++;
  }

  kb.annotated_by = `annotate.js + ${opts.model}`;
  kb.annotated_at = new Date().toISOString();
  fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2));

  console.log(`\n✓ Done. ${annotated}/${kb.scenes.length} scenes annotated.`);
  console.log(`  KB written: ${path.relative(process.cwd(), kbPath)}`);
  console.log(`\nRestart the server (it reads KB from disk on each request, so just refreshing the`);
  console.log(`frontend is enough) to see passive cards + grounded chat responses.`);
}

main().catch(err => {
  console.error(`\n✗ ERROR: ${err.message}`);
  if (err.status) console.error(`  HTTP ${err.status}`);
  if (err.error) console.error(`  Details: ${JSON.stringify(err.error)}`);
  process.exit(1);
});
