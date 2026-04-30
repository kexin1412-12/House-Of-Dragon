#!/usr/bin/env node
/**
 * 用 Gemini 给 KB 里的 scene 补 plot / shot / foreshadow / tags 字段。
 *
 * 为什么要这个脚本：
 *   preprocess.js 跑完后，scene.plot / shot / foreshadow 都是 null —— 只有 face-rec
 *   数据。perspective、character_card、chat 三条线都吃这些字段，没填的话只能从
 *   角色 DB 兜底，画面侧的"这一幕在拍什么"完全缺失。
 *
 * 设计要点：
 *   - 走 lib/ai 路由（vision task → gemini-2.5-flash + openai 兜底）
 *   - 一个 scene 一个 LLM 请求（不是 annotate.js 那种"全片塞一次"），方便 resumable
 *   - 默认跳过已有 plot.fact 的 scene；--rebuild 强制重跑
 *   - Spoiler-safe by data filter：注入 LLM 的角色 DB 已按 episode cursor 过滤
 *   - 每 50 scene 写盘一次 checkpoint，崩了最多丢 50 个的代价
 *
 * 用法：
 *   node scripts/enrich_scenes_gemini.js house_of_dragon_05
 *   node scripts/enrich_scenes_gemini.js house_of_dragon_05 --limit 5         # 先看 5 个样例
 *   node scripts/enrich_scenes_gemini.js house_of_dragon_05 --scene s100      # 单个 scene
 *   node scripts/enrich_scenes_gemini.js house_of_dragon_05 --rebuild         # 全部重跑
 *   node scripts/enrich_scenes_gemini.js house_of_dragon_05 --concurrency 8
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');

const SERVER_DIR = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    videoId: null,
    limit: null,
    sceneId: null,
    rebuild: false,
    concurrency: 5,
    srt: null,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit' && args[i + 1]) { opts.limit = parseInt(args[++i], 10); continue; }
    if (a === '--scene' && args[i + 1]) { opts.sceneId = args[++i]; continue; }
    if (a === '--concurrency' && args[i + 1]) { opts.concurrency = parseInt(args[++i], 10); continue; }
    if (a === '--srt' && args[i + 1]) { opts.srt = args[++i]; continue; }
    if (a === '--rebuild') { opts.rebuild = true; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (!opts.videoId && !a.startsWith('--')) opts.videoId = a;
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/enrich_scenes_gemini.js <video_id> [options]

Options:
  --limit <N>           只跑前 N 个待补 scene（调试用）
  --scene <id>          只跑某一个 scene（如 s100）
  --rebuild             已有 plot.fact 也重跑
  --concurrency <N>     并发请求数（默认 5；Gemini Flash 付费 tier 1 RPM 1000，安全上限 ~15）
  --srt <path>          指定字幕文件（默认自动找 uploads/<video_id>.srt）
  --dry-run             只打印将要处理的 scene，不调 LLM
  -h, --help            显示帮助
`);
}

// ─── SRT helpers (从 annotate.js 抄过来) ──────────────────────────
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

function subsForScene(subs, startTime, endTime, padSec = 2) {
  return subs
    .filter(s => s.start < endTime + padSec && s.end > startTime - padSec)
    .map(s => s.text);
}

function imageToDataUrl(imgPath) {
  const data = fs.readFileSync(imgPath);
  const mime = /\.png$/i.test(imgPath) ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${data.toString('base64')}`;
}

// ─── KB / 角色 DB 工具 ─────────────────────────────────────────
function loadKB(videoId) {
  const kbPath = path.join(SERVER_DIR, 'kb', `${videoId}.json`);
  if (!fs.existsSync(kbPath)) {
    throw new Error(`KB 文件不存在: ${kbPath}\n先跑: node scripts/preprocess.js <video_path>`);
  }
  return { kbPath, kb: JSON.parse(fs.readFileSync(kbPath, 'utf8')) };
}

function loadCharacterDb(showId) {
  const p = path.join(SERVER_DIR, 'kb', 'characters', `${showId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 找到 scene 在哪一集（用 episode_map）。没匹配到就回落到 kb.episode。
function cursorForScene(kb, sceneId) {
  const map = kb.episode_map || [];
  for (const m of map) {
    if (sceneId >= m.from_scene && sceneId <= m.to_scene) return m.episode;
  }
  return kb.episode || null;
}

// 角色 state_timeline 在 cursor 时刻的活跃条目（spoiler-safe filter）
function activeStateAtCursor(character, cursor) {
  if (!cursor) return null;
  const tl = character.state_timeline || [];
  // 字典序比较：S01E05 < S01E06，零填充正确
  const matches = tl.filter(s => s.from <= cursor && (s.to == null || cursor <= s.to));
  return matches[matches.length - 1] || null; // 取最近的活跃条目
}

function compactCharContext(charDb, cursor, charsOnScreen) {
  if (!charDb || !charsOnScreen?.length) return null;
  const seen = new Set();
  const onScreenIds = charsOnScreen.map(c => c.character_id || c.id).filter(Boolean);
  const items = [];
  for (const id of onScreenIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const c = (charDb.characters || []).find(x => x.character_id === id);
    if (!c) continue;
    const state = activeStateAtCursor(c, cursor);
    items.push({
      id,
      name: c.display_name_zh,
      house: c.house || null,
      identity: c.short_identity_zh || null,
      title: state?.title_zh || null,
      role: state?.political_role_zh || null,
      summary: state?.safe_summary_zh || null,
    });
  }
  return items;
}

// 在该 scene 之前出现过、提供"前情"的角色摘要（最多 5 个，按 screen_time 估算重要性）
function priorContextChars(kb, sceneIdx, charDb, cursor) {
  const recentScenes = kb.scenes.slice(Math.max(0, sceneIdx - 8), sceneIdx);
  const counts = new Map();
  for (const s of recentScenes) {
    for (const c of (s.characters || [])) {
      counts.set(c.id, (counts.get(c.id) || 0) + (c.screen_time_s || 0));
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);
  return compactCharContext(charDb, cursor, top.map(id => ({ id })));
}

// ─── LLM 调用 ───────────────────────────────────────────────
const SYSTEM_PROMPT = `你是 HBO《龙之家族》(House of the Dragon) 第一季第五集的镜头标注员。

每次任务你只看一帧 + 上下文，给出**这一帧/这一幕**的客观标注。

字段约定：
- plot.fact：≤60 字。客观画面描述：谁在做什么 / 在什么场合。不掺解读，不掺情绪推理。
- plot.reading：≤90 字。叙事层解读：这一刻对人物动机/政治格局意味着什么。允许给出推测，但要扣住画面里的具体细节（神情/构图/在场人物）。
- shot.framing：3-8 个字。如"中近景"、"特写"、"过肩"、"广角空镜"、"反应镜头"。
- shot.intent：≤30 字。导演用这个景别/镜头想强调什么（如"压迫感"/"两人对峙"/"孤立"）。
- shot.emotion：3-6 个字的情绪标签，如"压抑"、"暗流"、"决绝"、"悲悯"。
- foreshadow.setup_hint：可空（null）。如果画面有值得留意的细节（道具、人物站位、未点明的小动作），写一句"注意…"——**不能解释未来如何回扣**，更不能提后面剧集。
- tags：3-5 个中文短标签（如"婚礼"/"绿党萌芽"/"密谈"）。

硬约束：
1. 你**只能**基于这一帧 + 提供的元数据写。不要编造画面里没有的台词或动作。
2. 不要剧透 cursor 之后的事件——你看到的角色 DB 已经按 cursor 过滤，请相信它。
3. 不要用古风词（"此刻"、"宿命"、"命运"、"步步惊心"、"心头"、"眼前"、"盘算"、"隐忧"）。
4. 用 HBO 政治剧的克制口吻，不是网文/乙游/古装剧。
5. 严格按 schema 输出 JSON，不要 Markdown。`;

const SCENE_SCHEMA = {
  type: 'object',
  required: ['plot', 'shot', 'foreshadow', 'tags'],
  properties: {
    plot: {
      type: 'object',
      required: ['fact', 'reading'],
      properties: {
        fact: { type: 'string' },
        reading: { type: 'string' },
      },
    },
    shot: {
      type: 'object',
      required: ['framing', 'intent', 'emotion'],
      properties: {
        framing: { type: 'string' },
        intent: { type: 'string' },
        emotion: { type: 'string' },
      },
    },
    foreshadow: {
      type: 'object',
      required: ['setup_hint'],
      properties: {
        setup_hint: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

const BANNED_PHRASES = [
  '此刻', '宿命', '命运', '步步惊心', '心头', '眼前', '盘算', '隐忧',
  '芸芸众生', '尘世', '红尘', '风起云涌', '腥风血雨',
];

function violatesStyle(text) {
  if (!text) return false;
  return BANNED_PHRASES.some(p => text.includes(p));
}

function isComplete(payload) {
  return !!(
    payload &&
    payload.plot && typeof payload.plot.fact === 'string' && payload.plot.fact.length > 0 &&
    typeof payload.plot.reading === 'string' && payload.plot.reading.length > 0 &&
    payload.shot && typeof payload.shot.framing === 'string' && payload.shot.framing.length > 0
  );
}

function findViolations(payload) {
  const all = [
    payload?.plot?.fact,
    payload?.plot?.reading,
    payload?.shot?.framing,
    payload?.shot?.intent,
    payload?.shot?.emotion,
    payload?.foreshadow?.setup_hint,
    ...(Array.isArray(payload?.tags) ? payload.tags : []),
  ].filter(Boolean).join(' ');
  const hits = new Set();
  for (const p of BANNED_PHRASES) if (all.includes(p)) hits.add(p);
  return [...hits];
}

function looksTemplated(payload) {
  return findViolations(payload).length > 0;
}

async function enrichOneScene({ scene, sceneIdx, kb, charDb, subs, branchPoints }) {
  const keyframeRel = (scene.keyframe || '').replace(/^\//, '');
  const keyframePath = keyframeRel ? path.join(SERVER_DIR, 'kb', keyframeRel) : null;
  if (!keyframePath || !fs.existsSync(keyframePath)) {
    return { ok: false, reason: 'missing_keyframe' };
  }

  const cursor = cursorForScene(kb, scene.scene_id);
  const onScreen = scene.characters || [];
  const onScreenContext = compactCharContext(charDb, cursor, onScreen);
  const priorContext = priorContextChars(kb, sceneIdx, charDb, cursor);

  // 字幕窗口（带 ±2s padding）
  const subLines = subs.length ? subsForScene(subs, scene.start_time, scene.end_time, 2) : [];

  // 邻近的 branch_point（决策点）—— 把当前 scene 放到剧情结构里
  const nearBranch = (branchPoints || []).find(bp =>
    Math.abs(bp.timestamp - (scene.start_time + scene.end_time) / 2) < 30
  );

  const meta = {
    scene_id: scene.scene_id,
    cursor,
    time: `${scene.start_time}s - ${scene.end_time}s`,
    on_screen: onScreenContext,
    recent_context: priorContext,
    near_branch_point: nearBranch ? { label: nearBranch.label, holder: nearBranch.decision_holder_display } : null,
  };

  const userText =
    `场景 ${scene.scene_id}（剧集游标 ${cursor || '未知'}）\n` +
    `时长：${meta.time}\n` +
    (subLines.length ? `字幕窗口（带 2s padding）：${subLines.join(' / ')}\n` : '无字幕（可能纯画面/无对白）。\n') +
    (meta.on_screen?.length
      ? `画面里的角色（已按 cursor 过滤剧透）：\n${JSON.stringify(meta.on_screen, null, 2)}\n`
      : '画面里没有识别到角色（可能是空镜或环境镜头）。\n') +
    (meta.recent_context?.length
      ? `前情提要（最近几个 scene 出场的人，仅作参考）：\n${JSON.stringify(meta.recent_context.map(c => ({ id: c.id, name: c.name, title: c.title })), null, 2)}\n`
      : '') +
    (meta.near_branch_point
      ? `**注意**：本 scene 接近一个剧情决策点 "${meta.near_branch_point.label}"（决策方：${meta.near_branch_point.holder}）——但你只能描述当前帧呈现的内容，不要预言决策结果。\n`
      : '') +
    `\n请按 schema 输出 JSON。`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', dataUrl: imageToDataUrl(keyframePath) },
      { type: 'text', text: userText },
    ],
  }];

  const t0 = Date.now();
  const first = await ai.generateStructured({
    task: 'vision',
    system: SYSTEM_PROMPT,
    messages,
    schema: SCENE_SCHEMA,
    temperature: 0.3,
  });
  const firstViolations = findViolations(first.data);
  const firstComplete = isComplete(first.data);

  if (firstComplete && firstViolations.length === 0) {
    return { ok: true, data: first.data, provider: first.provider, model: first.model, elapsed: Date.now() - t0 };
  }

  // 一次 retry：把上一次的输出和问题反馈回喂给 LLM
  const issues = [];
  if (firstViolations.length) issues.push(`包含违禁词：${firstViolations.map(w => `「${w}」`).join('、')}`);
  if (!firstComplete) issues.push('输出不完整：plot.fact / plot.reading / shot.framing 至少有一个缺失或为空');

  const retryMessages = [
    ...messages,
    { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(first.data) }] },
    {
      role: 'user',
      content: [{
        type: 'text',
        text:
          `上面那版输出有问题：${issues.join('；')}。\n` +
          `请重新输出 JSON：保持事实/构图/解读方向不变，但要完整填充所有必填字段，` +
          `也**完全不要**使用违禁词或同义古风词。改用 HBO 政治剧的克制写法。`,
      }],
    },
  ];

  const second = await ai.generateStructured({
    task: 'vision',
    system: SYSTEM_PROMPT,
    messages: retryMessages,
    schema: SCENE_SCHEMA,
    temperature: 0.2,
  });
  const elapsed = Date.now() - t0;

  if (looksTemplated(second.data)) {
    return {
      ok: false, reason: 'banned_phrase_after_retry',
      firstHits: firstViolations, secondHits: findViolations(second.data),
      data: second.data, provider: second.provider, model: second.model, elapsed,
    };
  }
  if (!isComplete(second.data)) {
    return {
      ok: false, reason: 'incomplete_after_retry',
      data: second.data, provider: second.provider, model: second.model, elapsed,
    };
  }

  return { ok: true, recovered: true, firstHits: firstViolations, data: second.data, provider: second.provider, model: second.model, elapsed };
}

// ─── 并发调度 ─────────────────────────────────────────────
async function runWithConcurrency(items, fn, n, onTick) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, n) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { ok: false, reason: 'exception', error: err.message || String(err) };
      }
      done++;
      onTick?.(done, items.length, items[i], results[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── main ─────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();
  if (!opts.videoId) {
    console.error('Error: <video_id> is required.\n');
    return printHelp();
  }
  if (!ai.isAvailable('vision')) {
    console.error('Error: vision task 没可用 provider。检查 GEMINI_API_KEY / OPENAI_API_KEY。');
    process.exit(1);
  }

  const { kbPath, kb } = loadKB(opts.videoId);
  const charDb = loadCharacterDb(kb.show_id || 'house-of-the-dragon');
  console.log(`KB: ${path.basename(kbPath)}  (${kb.scenes.length} scenes, episode ${kb.episode || '?'})`);
  console.log(`Char DB: ${charDb ? `${charDb.characters?.length || 0} characters` : 'NOT FOUND（脚本会继续，但少角色上下文）'}`);

  // 字幕：优先 --srt，其次 uploads/<video_id>.srt
  let subs = [];
  let srtPath = opts.srt;
  if (!srtPath) {
    const auto = path.join(SERVER_DIR, 'uploads', `${opts.videoId}.srt`);
    if (fs.existsSync(auto)) srtPath = auto;
  }
  if (srtPath && fs.existsSync(srtPath)) {
    subs = parseSrt(fs.readFileSync(srtPath, 'utf8'));
    console.log(`SRT: ${path.basename(srtPath)}  (${subs.length} lines)`);
  } else {
    console.log(`SRT: 未找到（跳过字幕注入；视觉 + 角色 DB 仍可用）`);
  }

  // 决定要跑哪些 scene
  const todoIdx = [];
  for (let i = 0; i < kb.scenes.length; i++) {
    const s = kb.scenes[i];
    if (opts.sceneId && s.scene_id !== opts.sceneId) continue;
    const hasFact = s.plot && typeof s.plot.fact === 'string' && s.plot.fact.length > 0;
    if (hasFact && !opts.rebuild) continue;
    todoIdx.push(i);
    if (opts.limit && todoIdx.length >= opts.limit) break;
  }

  if (todoIdx.length === 0) {
    console.log('\n没有 scene 需要处理（已全部填充；用 --rebuild 强制重跑）');
    return;
  }

  console.log(`\n待处理 scene 数: ${todoIdx.length} / ${kb.scenes.length}（concurrency=${opts.concurrency}）`);
  if (opts.dryRun) {
    console.log('--dry-run：只列举，不调 LLM。');
    todoIdx.slice(0, 10).forEach(i => {
      const s = kb.scenes[i];
      console.log(`  ${s.scene_id}  t=${s.start_time}-${s.end_time}  chars=${(s.characters || []).length}`);
    });
    if (todoIdx.length > 10) console.log(`  ... 还有 ${todoIdx.length - 10} 个`);
    return;
  }

  const branchPoints = kb.branch_points || [];
  const t0 = Date.now();
  let inputTokens = 0, outputTokens = 0;
  let okCount = 0, failCount = 0, bannedCount = 0, recoveredCount = 0;
  let lastSaveAt = Date.now();

  const items = todoIdx.map(i => ({ scene: kb.scenes[i], sceneIdx: i }));

  await runWithConcurrency(items, async ({ scene, sceneIdx }) => {
    const r = await enrichOneScene({ scene, sceneIdx, kb, charDb, subs, branchPoints });
    if (r.ok) {
      // 写回 KB —— 保留已有字段（如 spoiler_level / characters_on_screen）
      scene.plot = r.data.plot || scene.plot;
      scene.shot = r.data.shot || scene.shot;
      scene.foreshadow = {
        ...(scene.foreshadow || {}),
        is_setup_for: scene.foreshadow?.is_setup_for || [],
        is_payoff_of: scene.foreshadow?.is_payoff_of || [],
        setup_hint: r.data.foreshadow?.setup_hint ?? null,
      };
      if (Array.isArray(r.data.tags) && r.data.tags.length) {
        const existing = new Set(scene.tags || []);
        for (const t of r.data.tags) existing.add(t);
        scene.tags = [...existing];
      }
      okCount++;
      if (r.recovered) recoveredCount++;
    } else if (r.reason === 'banned_phrase' || r.reason === 'banned_phrase_after_retry' || r.reason === 'incomplete_after_retry') {
      bannedCount++;
    } else {
      failCount++;
    }
    return r;
  }, opts.concurrency, (done, total, item, result) => {
    const sceneId = item.scene.scene_id;
    const tag = result.ok ? 'OK' : `SKIP(${result.reason})`;
    if (done % 10 === 0 || done === total) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (done / Math.max(1, (Date.now() - t0) / 1000)).toFixed(2);
      const eta = ((total - done) / Math.max(0.01, parseFloat(rate))).toFixed(0);
      console.log(`  [${done}/${total}] ${sceneId} ${tag}  elapsed=${elapsed}s rate=${rate}/s eta=${eta}s`);
    }
    // 每 50 个写盘一次 checkpoint
    if (done % 50 === 0 && Date.now() - lastSaveAt > 5000) {
      fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2));
      lastSaveAt = Date.now();
      console.log(`     ↳ checkpoint saved (${done}/${total})`);
    }
  });

  // 最终写盘
  fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2));
  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Done ===`);
  console.log(`总耗时: ${totalElapsed}s`);
  console.log(`成功:   ${okCount}（其中 retry 救回: ${recoveredCount}）`);
  console.log(`违禁词: ${bannedCount}（retry 也没救回的，可改 ban 列表后再跑）`);
  console.log(`失败:   ${failCount}`);
  console.log(`KB 已保存: ${kbPath}`);
}

main().catch(err => {
  console.error('\nFATAL:', err.stack || err.message || err);
  process.exit(1);
});
