#!/usr/bin/env node
/**
 * 高价值 scene 的"符号 + 蒙太奇"读图（E5 专用）。
 *
 * 与 enrich_scenes_gemini.js 的区别：
 *   - 范围小（~35 scene），但每个 scene 喂的 context 厚得多
 *   - 注入符号词典（kb/symbols/house-of-the-dragon.json）
 *   - 注入大聪解说 E5 段（chunks 44-50 的 essence_points）作为分析参考
 *   - 注入用户的 10 条观察作为 few-shot
 *   - 输出新字段：scene.symbols / scene.directing / scene.plot.deep_reading
 *   - 不覆盖原 plot.fact / plot.reading（保留浅层读图作为 fallback）
 *
 * 用法：
 *   node scripts/enrich_high_value_e5.js                   # 跑预设的 35 个 scene
 *   node scripts/enrich_high_value_e5.js --beats A,D,E     # 只跑 beat A/D/E
 *   node scripts/enrich_high_value_e5.js --scenes s546,s590  # 自己指定
 *   node scripts/enrich_high_value_e5.js --rebuild         # 重跑已有 deep_reading 的
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');
const { saveKbSafely } = require('../lib/kb_io');

const SERVER_DIR = path.join(__dirname, '..');

// ─── 高价值 scene 清单（按 beat 分组） ──────────────────────────
const BEATS = {
  A: { label: '开场杀妻蒙太奇', scenes: ['s03','s04','s05','s06','s07','s08','s09','s10'] },
  B: { label: '新国王之手 Lyonel Strong 在船上 (5:20)', scenes: ['s77','s80','s82','s83'] },
  C: { label: '海蛇不出迎 (9:03 "Where is Lord Corlys?")', scenes: ['s115','s116','s117','s118','s119','s120','s121','s122','s123','s124','s125'] },
  C2: { label: '拉里斯说外来花 (10:16) — 弯腿说花/外族暗示', scenes: ['s133','s134','s135','s136','s137'] },
  D: { label: 'moon tea 对白 (11:30, 拉里斯→阿莉森特)', scenes: ['s140','s143','s146','s149','s152'] },
  D2: { label: 'Criston 求私奔 (24:40, 船上)', scenes: ['s269','s271','s273'] },
  E: { label: '阿莉森绿装入场 (42:09, s448)', scenes: ['s447','s448','s449','s450','s451','s453'] },
  E2: { label: '阿莉森绿装余波 (42:30+ Larys 暧昧微笑)', scenes: ['s454','s460','s470'] },
  F: { label: '戴蒙在宴上 (49:25 调情劳娜)', scenes: ['s544','s545','s547','s550'] },
  F2: { label: '戴蒙到场未邀 (bp 3240s 戴蒙致辞前后)', scenes: ['s615','s620','s625','s630','s640'] },
  G: { label: '婚礼混乱', scenes: ['s670','s680','s685','s690'] },
  H: { label: '婚礼后老鼠 / 血', scenes: ['s697','s698','s699','s705'] },
  I: { label: '奥托被解职骑马离京 (8:00)', scenes: ['s100','s101','s105','s106','s107','s109'] },
  J: { label: '雷妮拉与莱诺君子协定 (18:00, 海滩)', scenes: ['s225','s227','s230','s231'] },
  K: { label: '蕾妮丝冷眼旁观 (20:00)', scenes: ['s238','s241','s244'] },
  L: { label: '韦赛里斯病情恶化/伤口 (38:00)', scenes: ['s379','s381','s385'] },
  M: { label: '戴蒙婚宴低语 (46:00)', scenes: ['s509','s512','s515'] },
  N: { label: '克里斯顿打死乔弗里 / 血迹 (55:00)', scenes: ['s657','s661','s663'] },
};

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { beats: null, scenes: null, rebuild: false, dryRun: false, concurrency: 3 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--beats' && args[i+1]) { opts.beats = args[++i].split(','); continue; }
    if (a === '--scenes' && args[i+1]) { opts.scenes = args[++i].split(','); continue; }
    if (a === '--concurrency' && args[i+1]) { opts.concurrency = parseInt(args[++i],10); continue; }
    if (a === '--rebuild') { opts.rebuild = true; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
  }
  return opts;
}

function imageToDataUrl(imgPath) {
  const data = fs.readFileSync(imgPath);
  const mime = /\.png$/i.test(imgPath) ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${data.toString('base64')}`;
}

// ─── SRT helpers ──────────────────────────────────────────────
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
function subsForWindow(subs, fromT, toT, padSec = 4) {
  return subs
    .filter(s => s.start < toT + padSec && s.end > fromT - padSec)
    .map(s => `[${s.start.toFixed(1)}s] ${s.text}`);
}

// ─── 系统提示 ────────────────────────────────────────────
const SYSTEM_PROMPT = `你是 HBO《龙之家族》第一季第五集的"符号读图"分析员。

任务和普通读图不同：你不是描述画面里有什么（那一层我们已经有），你要回答两个更深的问题：
1. 画面里有哪些**剧情符号**触发？（参考给定的符号词典）
2. 这一帧体现了什么**导演手法**？（蒙太奇/平行剪辑/缺席暗示/座次错位…）

硬规则：
- 你看到的关键帧只是一帧，但你可以利用 scene 上下文（前后 scene 的 plot.fact、出场角色、台词、时间点）推断剪辑结构。
- **台词窗口**：如果窗口里出现了仪式性台词（"Ser X, of House Y"、"Lord/Lady …"、"my niece's wedding"、"She stood to inherit"），用来识别 kingsguard_no_announcement / hightower_as_outsider 这类听觉符号；如果**该报名的位置缺这种台词**，可触发 expected_but_missing。
- 找到符号必须给出**画面或台词中可识别的具体证据**（如"杯中淡黄色液体"、"台词 'After my niece's wedding' 显示这是戴蒙在谈他妻子的死后继承"），不能凭脑补。
- 没看出符号就 symbols=[]。**宁可空，也不要硬套词典里的条目。**
- expected_but_missing 字段：写出"按礼制本应出现而没出现的人/动作/物/台词"，例如"主家本人未亲迎"、"铁卫未报名"。无则空数组。
- editing_pattern 只在跨帧逻辑明显时填，没把握就写 null。可选值：montage / parallel_cut / cross_cut / tracking_shot / single_take / null。
- deep_reading：3-4 句的政治剧深读，必须基于已识别的符号或缺席。如果没识别出任何符号也没有缺席，deep_reading 留空字符串。
- 不剧透 cursor (S01E05) 之后的事件。
- 不要古风词（宿命/此刻/眼前/盘算/隐忧/红尘/命运），用 HBO 政治剧的克制口吻。
- 严格按 schema 输出 JSON。`;

const SCENE_SCHEMA = {
  type: 'object',
  required: ['symbols', 'directing', 'deep_reading'],
  properties: {
    symbols: {
      type: 'array',
      items: {
        type: 'object',
        required: ['symbol_id', 'evidence_in_frame', 'confidence'],
        properties: {
          symbol_id: { type: 'string' },
          evidence_in_frame: { type: 'string' },
          confidence: { type: 'string', enum: ['high','medium','low'] },
        },
      },
    },
    directing: {
      type: 'object',
      required: ['editing_pattern', 'expected_but_missing', 'intent_long'],
      properties: {
        editing_pattern: {
          anyOf: [
            { type: 'string', enum: ['montage','parallel_cut','cross_cut','tracking_shot','single_take'] },
            { type: 'null' },
          ],
        },
        expected_but_missing: { type: 'array', items: { type: 'string' } },
        intent_long: { type: 'string' },
      },
    },
    deep_reading: { type: 'string' },
  },
};

const BANNED_PHRASES = ['宿命','此刻','盘算','隐忧','眼前','红尘','尘世','命运'];
function violatesStyle(t) { return !!t && BANNED_PHRASES.some(p => t.includes(p)); }
function findViolations(payload) {
  const all = [
    payload?.deep_reading, payload?.directing?.intent_long,
    ...(payload?.symbols||[]).map(s=>s.evidence_in_frame),
    ...(payload?.directing?.expected_but_missing||[]),
  ].filter(Boolean).join(' ');
  return BANNED_PHRASES.filter(p => all.includes(p));
}

// ─── KB / 符号词典 / 解说 ────────────────────────────────────
function loadKB() {
  const p = path.join(SERVER_DIR, 'kb', 'house_of_dragon_05.json');
  return { kbPath: p, kb: JSON.parse(fs.readFileSync(p, 'utf8')) };
}
function loadSymbols() {
  const p = path.join(SERVER_DIR, 'kb', 'symbols', 'house-of-the-dragon.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function loadCharDb() {
  const p = path.join(SERVER_DIR, 'kb', 'characters', 'house-of-the-dragon.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function loadSrtForVideo(videoId) {
  const p = path.join(SERVER_DIR, 'uploads', `${videoId}.srt`);
  if (!fs.existsSync(p)) return null;
  return parseSrt(fs.readFileSync(p, 'utf8'));
}
function loadCommentaryE5() {
  // 大聪解说 chunks 44-50 = E5 婚礼段
  const p = path.join(SERVER_DIR, 'references', '【大聪看电影】—一口气看完《龙之家族》全季10集！剧情解说纯享版！—【2022-10-31】.chunks.json');
  if (!fs.existsSync(p)) return [];
  const f = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Object.values(f);
  const out = [];
  for (let i = 44; i <= 50 && i < arr.length; i++) {
    const c = arr[i];
    for (const ep of (c.essence_points || [])) {
      out.push({ type: ep.type, title: ep.title, point: ep.point, cue: ep.visual_or_audio_cue });
    }
  }
  return out;
}

function activeStateAtCursor(c, cursor) {
  if (!cursor) return null;
  const tl = c.state_timeline || [];
  const m = tl.filter(s => s.from <= cursor && (s.to == null || cursor <= s.to));
  return m[m.length-1] || null;
}

// ─── 单 scene 入口 ───────────────────────────────────────────
async function enrichOne({ scene, kb, symbolDict, charDb, commentaryE5, neighbors, subs }) {
  const keyframeRel = (scene.keyframe || '').replace(/^\//, '');
  const keyframePath = keyframeRel ? path.join(SERVER_DIR, 'kb', keyframeRel) : null;
  if (!keyframePath || !fs.existsSync(keyframePath)) {
    return { ok: false, reason: 'missing_keyframe' };
  }

  const cursor = 'S01E05';
  const onScreen = (scene.characters || []).map(c => {
    const cd = charDb.characters.find(x => x.character_id === c.id);
    if (!cd) return { id: c.id };
    const st = activeStateAtCursor(cd, cursor);
    return { id: c.id, name: cd.display_name_zh, title: st?.title_zh, role: st?.political_role_zh };
  });

  // 邻近 scene 的 plot.fact —— 让 LLM 推断蒙太奇/剪辑节奏
  const neighborSummary = neighbors.map(n => `${n.scene_id} t=${n.start_time.toFixed(0)}s: ${n.plot?.fact || '(空)'}`).join('\n');

  // 字幕窗口 —— 听觉信号驱动的符号（铁卫报名、外族暗示、台词矛盾）
  const subLines = subs ? subsForWindow(subs, scene.start_time, scene.end_time, 4) : [];
  const subtitleBlock = subLines.length
    ? `【该 scene 时间窗口的台词（英文，含 ±4s padding）】\n${subLines.join('\n')}\n`
    : '【该 scene 时间窗口的台词】无（可能是无对白的画面/转场）\n';

  // 把符号词典精简一下塞进 prompt（只留 visual_cue + meaning）
  const compactSymbols = symbolDict.symbols.map(s => ({
    id: s.symbol_id,
    cat: s.category,
    cue: s.visual_cue,
    means: s.meaning_zh,
  }));

  // 大聪 E5 段，只取与符号最相关的几条
  const compactCommentary = commentaryE5.slice(0, 18).map(c => `[${c.type}] ${c.title}: ${c.point}${c.cue ? ' (cue: '+c.cue+')' : ''}`).join('\n');

  const userText =
`【当前 scene】 ${scene.scene_id}  t=${scene.start_time.toFixed(1)}-${scene.end_time.toFixed(1)}s  cursor=${cursor}
【画面识别角色】${JSON.stringify(onScreen)}
【浅层读图（之前一轮已生成）】
  fact: ${scene.plot?.fact || '(空)'}
  reading: ${scene.plot?.reading || '(空)'}
  shot: ${JSON.stringify(scene.shot)}

【前后邻近 scene 的 plot.fact，用于推断剪辑结构】
${neighborSummary}

${subtitleBlock}
【符号词典（你要去画面里 / 台词里搜的清单）】
${JSON.stringify(compactSymbols, null, 2)}

【大聪解说 E5 婚礼段精华（仅作分析视角参考，不是事实来源）】
${compactCommentary}

【任务】
基于关键帧 + 上述 context，输出 JSON：
- symbols: 画面里命中的符号（每条要给画面证据 + 置信度 high/medium/low）
- directing.editing_pattern: 这一段是不是属于某种剪辑结构（montage/parallel_cut/cross_cut/tracking_shot/single_take/null）
- directing.expected_but_missing: 按礼制本该出现却没出现的人/动作/物（如"主家本人未亲迎"）
- directing.intent_long: 镜头深意，3-4 句
- deep_reading: 政治剧深读，扣紧识别到的符号 / 缺席。3-4 句。`;

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
  const violations = findViolations(first.data);
  if (violations.length === 0) {
    return { ok: true, data: first.data, elapsed: Date.now() - t0 };
  }

  // retry once
  const retryMessages = [
    ...messages,
    { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(first.data) }] },
    { role: 'user', content: [{ type: 'text', text: `上面那版含违禁词 ${violations.map(w=>`「${w}」`).join('、')}。请重出，保留事实但用 HBO 政治剧的克制写法，不要古风。` }] },
  ];
  const second = await ai.generateStructured({
    task: 'vision', system: SYSTEM_PROMPT, messages: retryMessages,
    schema: SCENE_SCHEMA, temperature: 0.2,
  });
  const elapsed = Date.now() - t0;
  if (findViolations(second.data).length > 0) {
    return { ok: false, reason: 'banned_after_retry', data: second.data, elapsed };
  }
  return { ok: true, data: second.data, recovered: true, elapsed };
}

// ─── 调度 ─────────────────────────────────────────────────
async function runConcurrent(items, fn, n, onTick) {
  const results = new Array(items.length);
  let cursor = 0, done = 0;
  await Promise.all(Array.from({length: Math.max(1,n)}, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (err) { results[i] = { ok: false, reason: 'exception', error: err.message }; }
      done++;
      onTick?.(done, items.length, items[i], results[i]);
    }
  }));
  return results;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!ai.isAvailable('vision')) { console.error('vision task 没可用 provider'); process.exit(1); }

  const { kbPath, kb } = loadKB();
  const symbolDict = loadSymbols();
  const charDb = loadCharDb();
  const commentaryE5 = loadCommentaryE5();
  const subs = loadSrtForVideo('house_of_dragon_05');
  console.log(`KB: ${kb.scenes.length} scenes | symbols: ${symbolDict.symbols.length} | commentary E5 essences: ${commentaryE5.length} | SRT: ${subs ? subs.length+' lines' : '不存在'}`);

  // 选定 scene 范围
  let targetIds;
  if (opts.scenes) {
    targetIds = opts.scenes;
  } else {
    const beatsToRun = opts.beats || Object.keys(BEATS);
    targetIds = beatsToRun.flatMap(b => BEATS[b]?.scenes || []);
  }
  targetIds = [...new Set(targetIds)];

  const items = [];
  for (const sid of targetIds) {
    const idx = kb.scenes.findIndex(s => s.scene_id === sid);
    if (idx < 0) { console.warn(`  scene ${sid} 不存在，跳过`); continue; }
    const s = kb.scenes[idx];
    if (!opts.rebuild && s.plot?.deep_reading) continue;
    const neighbors = [
      kb.scenes[idx-2], kb.scenes[idx-1], kb.scenes[idx+1], kb.scenes[idx+2],
    ].filter(Boolean).map(n => ({ scene_id: n.scene_id, start_time: n.start_time, plot: n.plot }));
    items.push({ scene: s, neighbors });
  }

  console.log(`\n待处理: ${items.length} scenes (concurrency=${opts.concurrency})\n`);
  if (opts.dryRun) {
    items.forEach(it => console.log(' ', it.scene.scene_id, 't='+it.scene.start_time.toFixed(0)+'s'));
    return;
  }
  if (items.length === 0) { console.log('没有 scene 需要处理（已有 deep_reading；用 --rebuild 强制）'); return; }

  const t0 = Date.now();
  let okCount = 0, recoveredCount = 0, failCount = 0;
  await runConcurrent(items, async ({ scene, neighbors }) => {
    const r = await enrichOne({ scene, kb, symbolDict, charDb, commentaryE5, neighbors, subs });
    if (r.ok) {
      scene.symbols = r.data.symbols || [];
      scene.directing = r.data.directing || null;
      scene.plot = scene.plot || {};
      scene.plot.deep_reading = r.data.deep_reading || '';
      okCount++;
      if (r.recovered) recoveredCount++;
    } else {
      failCount++;
    }
    return r;
  }, opts.concurrency, (done, total, item, r) => {
    const sym = (r.ok && r.data?.symbols?.length) ? `sym=${r.data.symbols.length}` : 'sym=0';
    const tag = r.ok ? `OK(${sym})` : `SKIP(${r.reason})`;
    console.log(`  [${done}/${total}] ${item.scene.scene_id} ${tag}`);
  });

  const { backup } = saveKbSafely(kb, kbPath);
  if (backup) console.log(`backup → ${backup}`);
  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Done ===`);
  console.log(`处理: ${items.length}  成功: ${okCount}（retry 救回 ${recoveredCount}）  失败: ${failCount}  耗时: ${totalElapsed}s`);
  console.log(`KB 已保存: ${kbPath}`);
}

main().catch(err => { console.error('FATAL:', err.stack || err); process.exit(1); });
