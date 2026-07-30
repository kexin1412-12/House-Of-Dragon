#!/usr/bin/env node
/**
 * 用 Gemini 校对/完善角色字典 (kb/characters/<show>.json)。
 *
 * 输入：
 *   - 一个已经跑完 preprocess + track-characters 的视频 KB（kb/<video_id>.json）
 *   - 该视频对应的剧集 (e.g. S01E05)
 *
 * 流程：
 *   1. 从 KB 里挑出所有出现过的 character_id（按 characters_on_screen 聚合）
 *   2. 每个角色：抽 2-3 张该角色出镜的关键帧 + 当前角色字典条目
 *   3. 发给 Gemini 视觉任务：「基于这些画面 + 你对该剧的常识，对这条角色条目提改进建议」
 *   4. 写到 kb/characters/_suggestions/<video_id>.json （**不动主 DB**，需人工 review）
 *
 * 用法：
 *   node scripts/enrich_characters.js <video_id> [--episode S01E05] [--per-char-frames 3]
 *   npm run enrich-characters -- house_of_dragon_05
 *
 * 设计原则：
 *   - 一次只发一个角色给 Gemini（控制 token + 隔离失败）
 *   - 默认 dry-run，输出 suggestions 文件让人复核
 *   - --apply 才会合并进主 DB（保守 merge：只追加新 state_timeline 条目，不覆盖已有 title_zh）
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');
const kbPaths = require('../lib/kb-paths');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { videoId: null, episode: null, perCharFrames: 3, apply: false, help: false, show: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--episode' && args[i + 1]) { opts.episode = args[++i]; continue; }
    if (a === '--per-char-frames' && args[i + 1]) { opts.perCharFrames = parseInt(args[++i], 10); continue; }
    if (a === '--show' && args[i + 1]) { opts.show = args[++i]; continue; }
    if (a === '--apply') { opts.apply = true; continue; }
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (!opts.videoId && !a.startsWith('--')) opts.videoId = a;
  }
  return opts;
}

function inferEpisode(videoId) {
  // house_of_dragon_05 → S01E05；house_of_dragon_s02e03 → S02E03
  const m1 = /s(\d{1,2})e(\d{1,2})/i.exec(videoId);
  if (m1) return `S${m1[1].padStart(2, '0')}E${m1[2].padStart(2, '0')}`;
  const m2 = /_(\d{1,2})$/.exec(videoId);
  if (m2) return `S01E${m2[1].padStart(2, '0')}`;
  return null;
}

function printHelp() {
  console.log(`
Usage: node scripts/enrich_characters.js <video_id> [options]

Options:
  --episode <S01E05>     Episode tag (default: inferred from video_id)
  --per-char-frames <N>  Sample frames to send Gemini per character (default 3)
  --show <show_id>       Show DB to update (default: from KB.show_id)
  --apply                Merge suggestions into main DB (default: dry-run, write only suggestions file)
  -h, --help

Example:
  node scripts/enrich_characters.js house_of_dragon_05
  node scripts/enrich_characters.js house_of_dragon_05 --episode S01E05 --per-char-frames 4
  node scripts/enrich_characters.js house_of_dragon_05 --apply
`);
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readImageAsDataUrl(absPath) {
  if (!fs.existsSync(absPath)) return null;
  const buf = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

// 从 KB 收集每个 character_id 的出镜信息
function collectAppearances(kb, framesDir) {
  const byChar = new Map(); // cid → [{ scene_id, t, bbox, frame_path? }, ...]
  for (const scene of kb.scenes || []) {
    const recs = scene.characters_on_screen || [];
    for (const r of recs) {
      const cid = r.character_id;
      if (!cid) continue;
      if (!byChar.has(cid)) byChar.set(cid, []);
      byChar.get(cid).push({
        scene_id: scene.scene_id,
        scene_keyframe: scene.keyframe || null,
        t: r.t,
        bbox: r.bbox,
        confidence: r.confidence,
      });
    }
  }
  return byChar;
}

// 从一个角色的所有出镜里挑 N 张「最有代表性」的帧
// 策略：按场景分组，每个场景取一张（confidence 最高的），最多 N 张
function pickRepresentativeFrames(appearances, n, framesDir) {
  const bestPerScene = new Map();
  for (const a of appearances) {
    const cur = bestPerScene.get(a.scene_id);
    if (!cur || (a.confidence || 0) > (cur.confidence || 0)) {
      bestPerScene.set(a.scene_id, a);
    }
  }
  const sorted = [...bestPerScene.values()].sort((x, y) => (y.confidence || 0) - (x.confidence || 0));
  const picked = sorted.slice(0, n);

  // 解析 keyframe 实际路径
  return picked.map(a => {
    if (!a.scene_keyframe) return null;
    const abs = path.join(__dirname, '..', 'kb', a.scene_keyframe);
    const dataUrl = readImageAsDataUrl(abs);
    return dataUrl ? { ...a, dataUrl } : null;
  }).filter(Boolean);
}

// OpenAI strict schema 要求所有 object 必须 additionalProperties: false 且
// required 列出全部 properties。Gemini provider 会自动 strip 这些字段。
const SUGGESTED_ENTRY = {
  type: 'object', additionalProperties: false,
  required: ['from', 'to', 'title_en', 'title_zh', 'political_role_zh', 'alive', 'safe_summary_zh'],
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    title_en: { type: 'string' },
    title_zh: { type: 'string' },
    political_role_zh: { type: 'string' },
    alive: { type: 'boolean' },
    safe_summary_zh: { type: 'string' },
  },
};
const SUGGESTION_ITEM = {
  type: 'object', additionalProperties: false,
  required: ['field_path', 'change_type', 'current_value', 'suggested_value',
             'suggested_entry', 'reason', 'episode_scope', 'confidence'],
  properties: {
    field_path: { type: 'string' },
    change_type: { type: 'string' },           // "replace" | "append" | "add_state_timeline_entry"
    current_value: { type: 'string' },
    suggested_value: { type: 'string' },
    suggested_entry: SUGGESTED_ENTRY,          // 仅 add_state_timeline_entry 时有意义
    reason: { type: 'string' },
    episode_scope: { type: 'string' },
    confidence: { type: 'number' },
  },
};
const SUGGESTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['character_id', 'review'],
  properties: {
    character_id: { type: 'string' },
    review: {
      type: 'object', additionalProperties: false,
      required: ['confirmed_correct_fields', 'suggestions'],
      properties: {
        confirmed_correct_fields: { type: 'array', items: { type: 'string' } },
        suggestions: { type: 'array', items: SUGGESTION_ITEM },
      },
    },
  },
};

const OFFICIAL_CANON_SOURCES = [
  {
    name: 'HBO House of the Dragon Interactive Guide',
    url: 'https://hotd-interactive-map.micro.hbo.com/',
    priority: 'official',
    use_for: [
      'canonical_name',
      'title_en',
      'house',
      'family',
      'faction',
      'map_context',
      'dragon_entries',
    ],
  },
];

const SYSTEM_PROMPT = `你是 HBO 剧集《House of the Dragon》/《Game of Thrones》的角色考据员。
你会拿到：
1. 主角色字典里某个角色的当前条目（display_name / short_identity / state_timeline 等）
2. 该角色在一集（episode）里的若干出镜画面
3. 当前剧集编号（如 S01E05）

任务：
- 基于画面 + 你对该剧的常识，**校对**这条角色条目，找出不准确、过时、或缺失的地方
- 严格按 episode_scope 给出建议（不要写未来集数才发生的事，避免剧透）
- 每条建议明确：field_path（用 JSON path）、change_type（replace / append / add_state_timeline_entry）、current_value、suggested_value、reason、confidence

铁律：
1. 只在你 80%+ 确信时给建议；不确定就放进 confirmed_correct_fields 或干脆不动
2. confidence < 0.6 的不要返回
3. **不要剧透未来**：如果某个改动需要未来剧情才合理，标 episode_scope 为更晚的集数并明确说明
4. 中文翻译要符合常见汉化（参考 weibo / 维基百科中文版命名）
5. 只输出严格 JSON，符合给定 schema

如果当前条目都已正确，返回空 suggestions 数组 + 把对的字段名列在 confirmed_correct_fields 里。`;

async function reviewCharacter({ characterEntry, frames, episode, allCharacters }) {
  // 给 Gemini 一份"其他角色的简短列表"作为同剧上下文（防止它把姓名搞混）
  const otherChars = allCharacters
    .filter(c => c.character_id !== characterEntry.character_id)
    .map(c => ({
      character_id: c.character_id,
      display_name_zh: c.display_name_zh,
      short_identity_zh: c.short_identity_zh,
    }));

  const userText = `当前剧集：${episode}

正在校对的角色条目（JSON）：
\`\`\`json
${JSON.stringify(characterEntry, null, 2)}
\`\`\`

同剧其他主要角色（避免姓名混淆，仅作参考）：
\`\`\`json
${JSON.stringify(otherChars, null, 2)}
\`\`\`

Official canon sources to prefer when checking canonical English names, titles, houses, factions, maps, and dragons:
\`\`\`json
${JSON.stringify(OFFICIAL_CANON_SOURCES, null, 2)}
\`\`\`

下面附了 ${frames.length} 张该角色在本集的出镜帧（按场景时间顺序）。请结合画面与你对该剧的常识，给出对这条条目的校对建议（严格按 schema 输出 JSON）。`;

  const content = [
    ...frames.map(f => ({ type: 'image', dataUrl: f.dataUrl, detail: 'high' })),
    { type: 'text', text: userText },
  ];

  const { data, provider, model } = await ai.generateStructured({
    task: 'vision',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    schema: SUGGESTION_SCHEMA,
    schemaName: 'character_review',
    temperature: 0.2,
  });

  return { ...data, _meta: { provider, model, frames_used: frames.length } };
}

function applySuggestions(showDb, allReviews, opts) {
  // 保守 merge 策略（避免 Gemini 错误把已正确的 title 改坏）：
  //   - replace 类只在 confidence >= 0.85 时应用
  //   - add_state_timeline_entry 在 confidence >= 0.7 时追加（避免与已有 from/to 完全相同的条目重复）
  let appliedCount = 0;
  for (const review of allReviews) {
    const cid = review.character_id;
    const charIdx = showDb.characters.findIndex(c => c.character_id === cid);
    if (charIdx < 0) continue;
    const c = showDb.characters[charIdx];

    for (const s of (review.review?.suggestions || [])) {
      if (s.change_type === 'replace' && s.confidence >= 0.85) {
        // 简化：只支持顶层字段或 state_timeline[i].field
        const m = /^state_timeline\[(\d+)\]\.(.+)$/.exec(s.field_path);
        if (m) {
          const idx = parseInt(m[1], 10);
          const field = m[2];
          if (c.state_timeline?.[idx]) {
            c.state_timeline[idx][field] = s.suggested_value;
            appliedCount++;
          }
        } else if (s.field_path in c) {
          c[s.field_path] = s.suggested_value;
          appliedCount++;
        }
      } else if (s.change_type === 'add_state_timeline_entry' && s.confidence >= 0.7 && s.suggested_entry) {
        const exists = (c.state_timeline || []).some(e =>
          e.from === s.suggested_entry.from && e.to === s.suggested_entry.to
        );
        if (!exists) {
          c.state_timeline = c.state_timeline || [];
          c.state_timeline.push(s.suggested_entry);
          appliedCount++;
        }
      }
    }
  }
  return appliedCount;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.videoId) {
    printHelp();
    process.exit(opts.help ? 0 : 1);
  }

  const serverDir = path.join(__dirname, '..');
  const kbPath = kbPaths.sceneKb(opts.videoId);
  if (!fs.existsSync(kbPath)) {
    console.error(`✗ KB not found: ${kbPath}`);
    console.error(`先跑：npm run preprocess -- uploads/${opts.videoId}.mp4`);
    console.error(`     PYTHON=<conda> npm run track-characters -- uploads/${opts.videoId}.mp4`);
    process.exit(1);
  }

  const kb = loadJson(kbPath);
  const showId = opts.show || kb.show_id || 'house-of-the-dragon';
  const showDbPath = path.join(serverDir, 'kb', 'characters', `${showId}.json`);
  if (!fs.existsSync(showDbPath)) {
    console.error(`✗ show DB not found: ${showDbPath}`);
    process.exit(1);
  }
  const showDb = loadJson(showDbPath);

  const episode = opts.episode || inferEpisode(opts.videoId);
  if (!episode) {
    console.error(`✗ cannot infer episode from video_id=${opts.videoId}; pass --episode S01EXX`);
    process.exit(1);
  }

  if (!ai.isAvailable('vision')) {
    console.error(`✗ vision task has no available provider — set GEMINI_API_KEY or OPENAI_API_KEY`);
    process.exit(1);
  }

  const framesDir = path.join(serverDir, 'kb', 'frames', opts.videoId);
  console.log(`[init] video_id=${opts.videoId}  episode=${episode}  show=${showId}`);
  console.log(`[init] vision provider:`, ai.describe().vision.active);

  const byChar = collectAppearances(kb, framesDir);
  if (byChar.size === 0) {
    console.error(`✗ no characters_on_screen records in ${kbPath} — did track-characters run?`);
    process.exit(1);
  }
  console.log(`[init] ${byChar.size} characters appear in this episode`);

  const allReviews = [];
  let i = 0;
  for (const [cid, appearances] of byChar) {
    i++;
    const charEntry = showDb.characters.find(c => c.character_id === cid);
    if (!charEntry) {
      console.log(`  [${i}/${byChar.size}] ${cid} — not in show DB, skip`);
      continue;
    }
    const frames = pickRepresentativeFrames(appearances, opts.perCharFrames, framesDir);
    if (frames.length === 0) {
      console.log(`  [${i}/${byChar.size}] ${cid} — no usable keyframes, skip`);
      continue;
    }
    process.stdout.write(`  [${i}/${byChar.size}] ${cid} (${charEntry.display_name_zh}) — `
      + `${frames.length} frames... `);
    try {
      const review = await reviewCharacter({
        characterEntry: charEntry,
        frames,
        episode,
        allCharacters: showDb.characters,
      });
      const sCount = (review.review?.suggestions || []).length;
      console.log(`${sCount} suggestion(s)`);
      allReviews.push(review);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
  }

  // 写 suggestions 文件
  const suggDir = path.join(serverDir, 'kb', 'characters', '_suggestions');
  fs.mkdirSync(suggDir, { recursive: true });
  const suggPath = path.join(suggDir, `${opts.videoId}.json`);
  const suggDoc = {
    video_id: opts.videoId,
    episode,
    show_id: showId,
    generated_at: new Date().toISOString(),
    generated_by: `enrich_characters.js (${ai.describe().vision.active.provider}/${ai.describe().vision.active.model})`,
    official_canon_sources: OFFICIAL_CANON_SOURCES,
    reviews: allReviews,
    apply_thresholds: { replace: 0.85, add_state_timeline_entry: 0.7 },
  };
  fs.writeFileSync(suggPath, JSON.stringify(suggDoc, null, 2), 'utf8');
  console.log(`\n✓ Suggestions written: ${path.relative(process.cwd(), suggPath)}`);

  if (opts.apply) {
    console.log(`\n[apply] merging high-confidence suggestions into ${showId}.json ...`);
    // 备份
    const backupPath = showDbPath.replace(/\.json$/, `.backup-${Date.now()}.json`);
    fs.copyFileSync(showDbPath, backupPath);
    const applied = applySuggestions(showDb, allReviews, opts);
    fs.writeFileSync(showDbPath, JSON.stringify(showDb, null, 2), 'utf8');
    console.log(`  applied ${applied} change(s)`);
    console.log(`  backup: ${path.relative(process.cwd(), backupPath)}`);
  } else {
    console.log(`\n  Review the suggestions, then run with --apply to merge high-confidence ones`);
    console.log(`  Or edit kb/characters/${showId}.json manually using the suggestions as guide.`);
  }
}

main().catch(err => {
  console.error(`✗ FAIL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
