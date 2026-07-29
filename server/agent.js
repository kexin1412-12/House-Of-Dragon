const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const charactersLib = require('./lib/characters');
const locationsLib = require('./lib/locations');
const seasonLib = require('./lib/season');
const ai = require('./lib/ai');
const { retrieve: retrieveKnowledge } = require('./lib/retrieval');
const { buildAnswerSpec } = require('./prompts/answer-spec');
const { buildDialogueSystemPrompt } = require('./prompts/dialogue');
const { buildVisionSystemPrompt, buildVisionUserContent } = require('./prompts/vision');

const KB_DIR = path.join(__dirname, 'kb');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const VISION_SYSTEM_PROMPT = buildVisionSystemPrompt();

// 用 ffmpeg 抓视频里 [centerT - window/2, centerT + window/2] 区间的 N 张关键帧（并行 seek）
async function extractClipFrames(videoPath, centerT, windowS = 8, sampleCount = 3) {
  if (!fs.existsSync(videoPath)) return [];
  const start = Math.max(0, centerT - windowS / 2);
  const interval = sampleCount > 1 ? windowS / (sampleCount - 1) : 0;
  const ts = [];
  for (let i = 0; i < sampleCount; i++) ts.push(start + i * interval);

  const tasks = ts.map(t => extractSingleFrame(videoPath, t).then(buf => buf ? { t, buf } : null));
  const results = await Promise.all(tasks);
  return results.filter(Boolean).map(r => ({
    t: r.t,
    dataUrl: `data:image/jpeg;base64,${r.buf.toString('base64')}`,
  }));
}

function extractSingleFrame(videoPath, t) {
  return new Promise(resolve => {
    const args = [
      '-ss', String(t),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', 'scale=640:-1',
      '-f', 'image2',
      '-vcodec', 'mjpeg',
      '-q:v', '5',
      '-loglevel', 'error',
      '-',
    ];
    const p = spawn('ffmpeg', args);
    const chunks = [];
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', () => {});
    p.on('error', () => resolve(null));
    p.on('close', code => {
      if (code !== 0) return resolve(null);
      const buf = Buffer.concat(chunks);
      resolve(buf.length > 0 ? buf : null);
    });
  });
}

// 两个 bbox IoU > 0.5 视为同一张脸
function bboxOverlapHigh(a, b) {
  if (!a || !b || a.length !== 4 || b.length !== 4) return false;
  const [ax1, ay1, ax2, ay2] = a;
  const [bx1, by1, bx2, by2] = b;
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  if (ix2 <= ix1 || iy2 <= iy1) return false;
  const inter = (ix2 - ix1) * (iy2 - iy1);
  const areaA = (ax2 - ax1) * (ay2 - ay1);
  const areaB = (bx2 - bx1) * (by2 - by1);
  const union = areaA + areaB - inter;
  return union > 0 && inter / union > 0.5;
}

// 加载 references/wiki-*.knowledge.json 作为世界观 lore（一次性载入）
let WIKI_CACHE = null;
function loadWikiLore() {
  if (WIKI_CACHE !== null) return WIKI_CACHE;
  const dir = path.join(__dirname, 'references');
  const all = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('wiki-') || !f.endsWith('.knowledge.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const kp of (j.knowledge_points || [])) {
          all.push({
            title: kp.title,
            type: kp.type,
            summary: kp.summary,
            source_entity: kp.source_entity || null,
          });
        }
      } catch { /* skip bad files */ }
    }
  }
  WIKI_CACHE = all;
  return all;
}

// 视觉脸识别在角色躺着 / 闭眼 / 背身时常漏检（典型例：韦赛里斯躺床上 → 没标到）。
// 扫 plot.fact + plot.reading 看候选角色 given name 是否被点名，作为兜底"在场"信号。
function mentionedCharIdsInScene(scene, candidateIds, db) {
  if (!scene || !Array.isArray(candidateIds) || !candidateIds.length) return new Set();
  const txt = `${scene.plot?.fact || ''} ${scene.plot?.reading || ''}`;
  if (!txt.trim()) return new Set();
  const found = new Set();
  for (const id of candidateIds) {
    const card = db ? charactersLib.findCharacter(db, id) : null;
    const dn = card?.display_name_zh || '';
    if (!dn) continue;
    // "韦赛里斯一世·坦格利安" → "韦赛里斯"（去除·后段 + 一世/二世数字尾）
    const given = dn.split('·')[0].replace(/[一二三四五六七八九十]+世$/, '');
    if (given && txt.includes(given)) found.add(id);
  }
  return found;
}

const characterDbCache = new Map();
function getCharacterDb(showId) {
  if (!showId) return null;
  if (characterDbCache.has(showId)) return characterDbCache.get(showId);
  try {
    const db = charactersLib.loadCharacterDb(showId);
    characterDbCache.set(showId, db);
    return db;
  } catch {
    characterDbCache.set(showId, null);
    return null;
  }
}

function getLocationDb(showId) {
  if (!showId) return null;
  try {
    return locationsLib.loadLocationDb(showId);
  } catch {
    return null;
  }
}

function enrichCharacters(kb, sceneCharacters, cursorTime) {
  const ids = (sceneCharacters || []).map(c => c.id).filter(Boolean);
  if (ids.length === 0) return [];
  const db = getCharacterDb(kb.show_id);
  if (!db) return sceneCharacters;
  const cursor = charactersLib.cursorAtTime(kb, cursorTime);
  const cards = charactersLib.lookupOnScreen(db, ids, cursor);
  const cardById = new Map(cards.map(c => [c.character_id, c]));
  return (sceneCharacters || []).map(raw => {
    const card = cardById.get(raw.id);
    if (!card) return raw;
    return {
      id: raw.id,
      emotion: raw.emotion,
      motivation_shift: raw.motivation_shift,
      display_name: card.display_name,
      house: card.house,
      current_actor: card.current_actor,
      current_status: card.current,
      relationships: charactersLib.lookupRelationships(db, raw.id, cursor),
      cursor_used: cursor,
    };
  });
}

// LLM 调用全部走 lib/ai；这里只判断指定任务是否有任何可用 provider。
function isTaskReady(task) {
  return ai.isAvailable(task);
}

function loadKB(videoId) {
  if (!videoId || videoId.includes('..') || videoId.includes('/') || videoId.includes('\\')) return null;

  const file = path.join(KB_DIR, `${videoId}.json`);
  if (!fs.existsSync(file)) return null;

  try {
    const kb = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(kb.scenes)) return null;

    const sceneSymbolsFile = path.join(KB_DIR, 'scene_symbols', `${videoId}.json`);
    if (fs.existsSync(sceneSymbolsFile)) {
      const overlay = JSON.parse(fs.readFileSync(sceneSymbolsFile, 'utf8'));
      const symbolAnalysis = overlay.symbol_analysis || {};
      const symbolsByScene = new Map(
        (overlay.scenes || []).map(scene => [scene.scene_id, scene])
      );
      for (const scene of kb.scenes) {
        const overlayScene = symbolsByScene.get(scene.scene_id);
        if (!overlayScene) continue;
        const additions = (overlayScene.symbols || []).map(symbol => ({
          ...(symbolAnalysis[symbol.symbol_id] || {}),
          ...symbol,
        }));
        const removals = new Set(overlayScene.remove_symbol_ids || []);
        const merged = new Map(
          (scene.symbols || [])
            .filter(symbol => !removals.has(symbol.symbol_id))
            .map(symbol => [symbol.symbol_id, symbol])
        );
        for (const symbol of additions) merged.set(symbol.symbol_id, symbol);
        scene.symbols = Array.from(merged.values());
      }
    }

    return kb;
  } catch {
    return null;
  }
}

function normalizeTime(rawT) {
  const t = Number(rawT);
  if (!Number.isFinite(t) || t < 0) return 0;
  return t;
}

// ─── SRT 字幕加载 + 时间窗切片 ─────────────────────────────
// 用途：给"角色内心"prompt 里塞当下这一段真实的台词，让 LLM 看到此刻角色
// 实际怎么说话（whisper 输出，没有 speaker label，但腔调和断句信息还在）。
const _srtCache = new Map();
function loadSrtCues(videoId) {
  if (!videoId) return [];
  if (_srtCache.has(videoId)) return _srtCache.get(videoId);
  const p = path.join(UPLOADS_DIR, `${videoId}.srt`);
  if (!fs.existsSync(p)) {
    _srtCache.set(videoId, []);
    return [];
  }
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch { _srtCache.set(videoId, []); return []; }
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n\n+/);
  const toS = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const tline = lines[0].includes('-->') ? lines[0] : lines[1];
    const m = /(\d{1,2}):(\d{2}):(\d{2})[,\.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,\.](\d{1,3})/.exec(tline);
    if (!m) continue;
    const start = toS(m[1], m[2], m[3], m[4]);
    const end = toS(m[5], m[6], m[7], m[8]);
    const textLines = lines.slice(lines.indexOf(tline) + 1);
    const text = textLines.join(' ').trim();
    if (!text) continue;
    cues.push({ start, end, text });
  }
  _srtCache.set(videoId, cues);
  return cues;
}
// 取 [centerT - back, centerT + forward] 区间字幕。默认只回看 30s，不窥探未来（剧透红线）。
function srtWindow(videoId, centerT, backS = 30, forwardS = 0) {
  const cues = loadSrtCues(videoId);
  if (!cues.length) return [];
  const lo = centerT - backS;
  const hi = centerT + forwardS;
  return cues.filter(c => c.end >= lo && c.start <= hi);
}

// ─── 4 类内在声音 · 龙之家族版调色板 ───
// 对应极乐迪斯科 4 种 stat 颜色：
//   blue   理性 — 在分析局势、权衡利弊（亚莉森计算穿绿裙的政治后果）
//   purple 情感 — 情绪反应 / 记忆涌上来（亚莉森想起和雷妮拉从前的友谊）
//   red    本能 — 身体反应 / 恐惧 / 愤怒（克里斯顿打死乔弗里前的肾上腺素）
//   amber  直觉 — 说不清但隐约感知到的事（雷尼拉婚宴上"今晚会出事"）
const VOICE_CATEGORY = {
  blue:   { label: '理性', tagline: '权衡 · 计算 · 史鉴',  hint: '冷静、合乎逻辑、以家族 / 王朝利益为先' },
  purple: { label: '情感', tagline: '记忆 · 旧情 · 心结',  hint: '过去涌上来，带着柔软或带着怨' },
  red:    { label: '本能', tagline: '血脉 · 火 · 肉身',     hint: '身体反应、肾上腺素、直接到不顾后果' },
  amber:  { label: '直觉', tagline: '风声 · 不祥 · 隐约',  hint: '说不清的预感、风向、第六感的不安' },
};

// 每个角色 3 个具名声音，每个挂在 4 类中的一类。
// LLM 一次回答必须挑 2 个不同 cat 的声音，让"两种颜色的色块同时说话"。
const CHAR_VOICES = {
  rhaenyra_targaryen: [
    { name: '王座算计',     cat: 'blue',   hint: '继承人的计算、父王的教诲、铁王座的重量' },
    { name: '龙血',         cat: 'red',    hint: '坦格利安血脉里的火、对羞辱的本能反扑' },
    { name: '戴蒙留下的印', cat: 'purple', hint: '叔叔在她心里那一条没法说出口的线' },
  ],
  daemon_targaryen: [
    { name: '王座饥渴',  cat: 'blue',   hint: '哥哥与铁王座之间那道他从不肯承认的影子' },
    { name: '龙血',      cat: 'red',    hint: '挑衅、暴力、瓦雷利亚的火、不肯低头' },
    { name: '哥哥的脸',  cat: 'purple', hint: '韦赛里斯在他心里残留的那一点温情与怨' },
  ],
  alicent_hightower: [
    { name: '父亲的钉子',   cat: 'blue',   hint: '奥托·海塔尔从未停过的耳语，把利害敲进她脑子' },
    { name: '母兽',         cat: 'red',    hint: '为伊耿守住的那条血肉防线，被逼急时会咬人' },
    { name: '雷妮拉的旧脸', cat: 'purple', hint: '她们曾是朋友，那张脸还没从她记忆里走干净' },
  ],
  criston_cole: [
    { name: '誓言之锁',     cat: 'blue',   hint: '白斗篷与那句"无论将来如何"，铁卫的本分' },
    { name: '神木林之伤',   cat: 'purple', hint: '那一夜被拒的羞辱，她说他不过是工具' },
    { name: '白斗篷的重',   cat: 'red',    hint: '身体里压不下去的怒，迟早会找一个出口' },
  ],
  viserys_targaryen: [
    { name: '王者本分', cat: 'blue',   hint: '坦格利安第五任国王的责任，杰赫里斯的影子' },
    { name: '衰朽',     cat: 'red',    hint: '一年比一年坏的身体，伤口烂着不愈合' },
    { name: '父爱',     cat: 'purple', hint: '对雷尼拉真心的偏爱、对阿莉森特的歉疚' },
  ],
};
function voicesFor(characterId) {
  return CHAR_VOICES[characterId] || [
    { name: '权衡', cat: 'blue',   hint: '此刻的盘算' },
    { name: '旧账', cat: 'purple', hint: '过去涌上来的那部分' },
    { name: '不祥', cat: 'amber',  hint: '说不清的预感' },
  ];
}

// 立场调色板（player 跟问 / 起手问的 4 种角度）
const STANCE_PALETTE = ['王者', '血亲', '审慎', '火焰'];
const STANCE_HINT = {
  '王者': '强势 / 揭穿 / 戳到痛处',
  '血亲': '亲近 / 老朋友式 / 戳到柔软',
  '审慎': '冷静 / 政治算计 / 把话往结构上引',
  '火焰': '激起 / 挑衅 / 让 TA 失态',
};

// ─── 笔触：让 LLM 写出像《冰与火之歌》《血与火》屈畅译笔的散文 ───
// 给所有"角色内心"相关 prompt 复用。彻底改成第三人称过去时长句叙事，
// 不再写"短句金句感"的现代诗。
const STYLE_GUIDE_INNER = `═══ 笔触（极重要，写偏即报废） ═══

你写的是 HBO《龙之家族》一个维斯特洛 POV 章节那种**第三人称过去时全知叙事**，
模仿乔治·R·R·马丁《冰与火之歌》《血与火》中信版屈畅译笔。

不是现代诗。不是格言。不是抒情散文。
是马丁的笔——长句、缓慢堆叠、充满细节、自我说服与自我怀疑缠绕。

═══ 五条硬规则（每条都必须遵守）═══

1) 第三人称过去时
   用"她知道 / 他记得 / 她想起"，不要"我..."第一人称。这是叙事者在转述
   角色此刻的心声，像一段 POV 章节里的内心独白段落。深层意识可以切到
   第二人称反问（"如果那天晚上她没有骗你..."），让自我审问的距离更近。

2) 句子长度 — 长句缠绕，禁止短句排列
   每段至少 2-3 个复合长句，用逗号、破折号、分号衔接从句，模拟思维的
   缠绕。绝对不要连续三个以上的短句排比。"她知道 X。她不曾 Y。她已经 Z。"
   这种节奏一律视为废稿。

3) 细节锚定 — 每段至少一个具体感官细节
   丝绸的触感、烛光的颜色、雨夜的温度、檀木的气味、铁器的冷、酒杯里
   摇晃的影子。马丁的写法是用物理世界的细节来传递情绪，不是直接说
   "她很害怕"。没有感官锚点的段落 = 废稿。

4) 自我说服 vs 自我怀疑交替
   表层意识在给自己找理由（"这是为了伊耿、为了王朝、为了…"），
   深层意识在拆穿这些理由（"可是另一个声音一直在问她..."）。
   一段里要有犹豫、回到、再说服。绝不是直线。

5) 禁止现代口语和金句感
   不出现提炼过度的格言式短语：体面 · 恩宠 · 应尽之义 · 灵魂深处 ·
   刻在骨血里。马丁的角色不说格言，他们絮叨、犹豫、在脑子里跟自己吵架。

═══ 严禁用词（命中即视为废稿）═══

现代心理词：冲动 · 焦虑 · 压力 · 创伤 · 情绪 · 心理 · 压抑感 ·
  安全感 · 边界感 · 自我价值 · 自尊 · 抑郁 · 内耗 · 解离 · 共鸣
现代散文/网文味：刻在骨血里 · 灵魂深处 · 无法言说 · 难以名状 ·
  心房 · 心扉 · 心跳漏拍 · 涟漪 · 余温 · 滚烫 · 心动 · 应尽之义 ·
  恩宠 · 体面（作格言时）
现代口语：上头 · 翻车 · 拿捏 · 内卷 · 摆烂 · 破防
仙侠/玄幻：苍生 · 天道 · 轮回 · 红尘 · 众生
书房古风（过度）：执笔 · 卷宗 · 史书 · 史册 · 羊皮纸 · 鹅毛笔 · 学士
文言副词（过度）：汝 · 吾 · 由是 · 其一其二 · 岂 · 毋

═══ Gold-standard 段落（仅示意笔触，绝不照抄字句）═══

范例（一名穿绿礼服赴宴的王后，表层意识）：

「绿色的丝绸被举到烛光下时泛着一层冷冽的光泽，像是旧镇港口冬天早晨的海面。
她知道这不是一件裙子，或者说这从来就不只是一件裙子——当海塔尔灯塔点燃绿色
火焰的时候，从旧镇到蜜酒河沿岸的每一个领主都知道那意味着什么。她的父亲
在离开的那个雨夜把这些话像钉子一样敲进她脑子里，而她花了整整三天试图拔掉
它们，可是每拔一颗就流更多的血。现在她站在镜子前面，看着镜中那个穿绿裙
的女人，心想这个人什么时候变成了自己。」

（深层意识）：

「她反复告诉自己这是为了伊耿，为了赫拉伊娜，为了还在摇篮里的伊蒙德——如果
雷妮拉坐上铁王座的那一天真的来临，她的孩子们会面临什么？父亲说的是"他们
会被视为威胁"，但他真正的意思是"他们会死"，他只是不愿意把那个字说出来。
可是另一个声音一直在问她：如果那天晚上雷妮拉没有骗她，如果她看着她的
眼睛说出了真话，今天穿这件裙子的理由还是否成立？她不确定。她厌恶自己的
不确定。一个即将宣战的人不应该不确定。」

记住：长句缠绕、感官锚点、说服与怀疑交替、第三人称过去时——
这就是马丁笔下维斯特洛的灵魂。`;

// 后处理：检测是否命中现代心理词 / 散文味
const BANNED_MODERN_INNER = [
  '冲动', '焦虑', '压力', '创伤', '情绪化', '安全感', '边界感',
  '自我价值', '自尊', '抑郁', '心理', '内耗', '解离',
  '刻在骨血里', '灵魂深处', '心房', '心扉', '心跳', '涟漪', '余温',
  '上头', '翻车', '拿捏', '内卷', '摆烂', '破防',
  '应尽之义', '恩宠', // 这些"格言短语"也要拦
];
function hitsModernBanned(text) {
  if (!text) return [];
  const s = String(text);
  return BANNED_MODERN_INNER.filter(w => s.includes(w));
}
// 后处理：检测段落是不是被切碎成短句金句感（违反"句子长度"规则）
// 启发式：如果一段超过 60 字但 70% 以上的句子都很短（≤12 字），判定为"短句堆"
function feelsLikeShortChoppyMonologue(text) {
  if (!text) return false;
  const s = String(text).trim();
  if (s.length < 80) return false;
  const sents = s.split(/[。？！\n]+/).map(x => x.trim()).filter(Boolean);
  if (sents.length < 4) return false;
  const shortCount = sents.filter(x => x.length <= 12).length;
  return shortCount / sents.length >= 0.7;
}

// 角色对谈/平行视角等浮层 LLM 输出的负面词库 —— 命中即视为"又写成模板/古风/小说"。
// 我们要的是 HBO 译制风的冷峻政治语气，不是史书学士、不是仙侠、不是套话煽情。
const BANNED_HOTD_OVERLAY = [
  // 模板套话
  '此刻就在你面前', '就在你面前',
  '问问看', '问她一句', '问他一句', '问 TA 一句', '问问她', '问问他',
  '你后悔吗', '你到底想做什么', '你到底想要什么',
  '另一条路', '另一条路正在打开',
  '命运等待你的选择', '命运在你手中', '命运之门',
  '书页尚未落下', '书页', '篇章',
  // 古风书房意象
  '执笔', '卷宗', '另一卷', '史书', '史册', '羊皮纸', '鹅毛笔', '学士', '落墨',
  // 仙侠/玄幻
  '苍生', '天道', '轮回', '红尘', '众生',
  // 文言/古风副词
  '汝', '吾', '归途', '由是', '其一其二', '岂', '毋',
  // 大词/标题词
  '改写历史', '抉择',
  // perspective HUD 旧标签污染（眼前/盘算/隐忧）+ "此刻/命运/宿命" 这类宿命论修辞
  '眼前', '盘算', '隐忧', '此刻', '命运', '宿命',
  // 万金油对冲词 —— "TA 可能在影响 X 局势 / 可能影响 Y 稳定 / 仍然活跃"
  // 这种不写就丢饭碗的模板句式是典型违规。"可能"/"或许" 单独不拉黑（合
  // 法的"可能要求 X"/"或许会失去 Y"语义需要保留），但短语组合拉黑。
  '仍然活跃', '可能在影响', '或许会', '可能会被',
  '影响家族稳定', '影响王位继承', '影响 X', '影响家族',
  '暂未明朗', '尚未明朗', '尚不清楚', '不得而知',
];
function containsBannedOverlayPhrase(text) {
  if (!text) return false;
  const s = String(text);
  return BANNED_HOTD_OVERLAY.some(p => s.includes(p));
}

// 动态人物卡（机制 P0）的固定 4 张卡 label。
// 普通角色：当前身份 / 阵营 / 与主角关系 / 最近事件
// 主角自己：当前身份 / 阵营 / 立场 / 最近事件（"与主角关系"对主角无意义，换"立场"）
const CHARACTER_CARD_LABELS_DEFAULT = ['当前身份', '阵营', '与主角关系', '最近事件'];
const CHARACTER_CARD_LABELS_PROTAGONIST = ['当前身份', '阵营', '立场', '最近事件'];
const CHARACTER_CARD_LABEL_SAFELIST = ['当前身份', '阵营', '与主角关系', '立场', '最近事件'];

// 每个 show 的"主角"id —— 用来决定"与主角关系"那张卡指向谁。
// HotD S01 阶段以雷尼拉为单一主角；以后可挪到 character DB 顶层 protagonist_id 字段。
const SHOW_PROTAGONIST = {
  'house-of-the-dragon': 'rhaenyra_targaryen',
};

// 第一人称泄漏检测：LLM 容易把 profile 里写成第一人称的 knows 直接复制到卡片，
// 而 perspective 卡片必须是第三人称。
// "我" 字单独出现就视为泄漏；只放过 自我/无我/真我/大我 这种成词。
function containsFirstPerson(text) {
  if (!text) return false;
  return /(^|[^自无真大])我/.test(String(text));
}

// 解析"动态人物卡"的 LLM JSON。
// 4 张卡顺序固定（当前身份 / 阵营 / 与主角关系或立场 / 最近事件），label 必须命中安全表。
function parseCharacterCardJSON(raw, expectedLabels) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (!obj || !Array.isArray(obj.cards) || obj.cards.length < 1) return null;
    // 按 expectedLabels 顺序对齐：第 i 张卡的 label 必须是 expectedLabels[i]，否则强制覆盖。
    // text 截到 32 字（人物卡比 perspective 略长，因为是事实陈述）。
    obj.cards = expectedLabels.map((wantLabel, i) => {
      const incoming = obj.cards[i] || {};
      return {
        label: wantLabel,
        text: String(incoming.text || '').trim().slice(0, 32),
      };
    }).filter(c => c.text);
    if (obj.cards.length === 0) return null;
    if (obj.subtitle) obj.subtitle = String(obj.subtitle).trim().slice(0, 30);
    if (obj.pov_character) obj.pov_character = String(obj.pov_character).trim().slice(0, 24);
    return obj;
  } catch { return null; }
}

function defaultCharacterCardPayload(displayName, shortIdentity, house, isProtagonist) {
  const labels = isProtagonist ? CHARACTER_CARD_LABELS_PROTAGONIST : CHARACTER_CARD_LABELS_DEFAULT;
  const houseLabel = house || '未知家族';
  const thirdLabelText = isProtagonist
    ? '当前立场暂不明朗'
    : '与主角的关系尚未明朗';
  return {
    pov_character: displayName,
    subtitle: shortIdentity || '',
    cards: [
      { label: labels[0], text: shortIdentity || '身份信息暂不完整' },
      { label: labels[1], text: houseLabel },
      { label: labels[2], text: thirdLabelText },
      { label: labels[3], text: '近期没有可披露的事件' },
    ],
    actions: ['继续观看', '关闭'],
  };
}

// kb.episode 优先；否则从 kb.video_id 反推；最后 fall back null（roleplay 会要求边界匹配，没拿到 episode 就用第一条）
function resolveEpisode(kb) {
  if (!kb) return null;
  if (kb.episode) return kb.episode;
  const id = String(kb.video_id || '');
  let m = id.match(/s(\d{1,2})e(\d{1,2})/i);
  if (m) return `S${m[1].padStart(2, '0')}E${m[2].padStart(2, '0')}`;
  m = id.match(/[_-](\d{1,2})$/);
  if (m) return `S01E${m[1].padStart(2, '0')}`;
  return null;
}

function currentScene(kb, cursorTime) {
  return kb.scenes.find(s => s.start_time <= cursorTime && cursorTime < s.end_time) || null;
}

function currentVisualBeat(scene, cursorTime) {
  if (!scene || !Array.isArray(scene.visual_beats)) return null;
  return scene.visual_beats.find(beat =>
    beat.start_time <= cursorTime && cursorTime < beat.end_time
  ) || null;
}

function scenesUpTo(kb, cursorTime) {
  return kb.scenes.filter(s => s.start_time <= cursorTime);
}

function scenesBetween(kb, from, to) {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return kb.scenes.filter(s => s.start_time >= start && s.start_time <= end);
}

function sceneById(kb, id) {
  return kb.scenes.find(s => s.scene_id === id) || null;
}

function detectIntents(question = '') {
  const q = String(question || '');

  return {
    shot: /镜头|构图|景别|运镜|光线|画面|色调|剪辑|特写|远景|空镜|俯拍|仰拍|低角度|高角度/.test(q),
    plot: /发生了什么|剧情|没看懂|这段|前面|刚才|讲什么|什么意思/.test(q),
    character: /为什么|动机|沉默|表情|情绪|心情|想法|人物|角色|他|她/.test(q),
    location: /这是哪|这里是哪|在哪|哪里|地点|地理|地图|城堡|城市|海峡|岛上|区域/.test(q),
    foreshadow: /伏笔|细节|彩蛋|铺垫|暗示|留意|重要吗|有什么用/.test(q),
    emotion: /紧张|压抑|恐惧|悲伤|爽|震撼|节奏|高潮|反转/.test(q),
    navigation: /只看|跳到|整理|回顾|时间线|人物线|线索线|重排/.test(q)
  };
}

function inferPrimaryIntent(intents) {
  if (intents.shot) return 'shot';
  if (intents.foreshadow) return 'foreshadow';
  if (intents.location) return 'location';
  if (intents.character) return 'character';
  if (intents.navigation) return 'navigation';
  if (intents.emotion) return 'emotion';
  return 'plot';
}

function getShotAnalysis(kb, t) {
  return currentScene(kb, t)?.shot || null;
}

function getPlotContext(kb, t) {
  // 12 段≈30-90s 的剧情纵深，足够 LLM 看出"五分钟前刚发生了 X，所以这一刻 Y"。
  // 之前是 5，对 70 分钟 recap 太短，AI 解读容易飘成"百科介绍"。
  return scenesUpTo(kb, t).slice(-12).map(s => ({
    scene_id: s.scene_id,
    t: s.start_time,
    fact: s.plot?.fact,
    reading: s.plot?.reading,
    phase: s.narrative?.phase,
    importance: s.narrative?.importance
  }));
}

function getForeshadowContext(kb, t) {
  const scene = currentScene(kb, t);
  if (!scene?.foreshadow) return null;

  const payoffSetups = (scene.foreshadow.is_payoff_of || [])
    .map(id => sceneById(kb, id))
    .filter(s => s && s.start_time <= t)
    .map(s => ({
      scene_id: s.scene_id,
      t: s.start_time,
      fact: s.plot?.fact,
      hint: s.foreshadow?.setup_hint
    }));

  return {
    setup_hint: scene.foreshadow.setup_hint || null,
    safe_payoffs: payoffSetups
  };
}

function getCharacterState(kb, t) {
  const raw = currentScene(kb, t)?.characters || [];
  return enrichCharacters(kb, raw, t);
}

function getEmotionState(kb, t) {
  const scene = currentScene(kb, t);
  if (!scene) return null;

  return {
    phase: scene.narrative?.phase,
    tension: scene.narrative?.tension,
    emotion: scene.shot?.emotion,
    narrative_role: scene.shot?.narrative_role,
    plot_reading: scene.plot?.reading
  };
}

function getLocationState(kb, t) {
  const scene = currentScene(kb, t);
  if (!scene) return null;
  const db = getLocationDb(kb.show_id);
  if (!db) return { raw_label: scene.location || null, locations: [], match: null };
  return locationsLib.resolveSceneLocations(db, scene);
}

function getMentionedLocations(kb, question) {
  const db = getLocationDb(kb.show_id);
  if (!db) return [];
  return locationsLib.matchLocationsInText(db, question, { limit: 8 });
}

function getNavigationContext(kb, t, question) {
  const pastScenes = scenesUpTo(kb, t);

  if (/人物线|只看.*(他|她|男主|女主|角色)/.test(question)) {
    return pastScenes
      .filter(s => Array.isArray(s.characters) && s.characters.length)
      .map(s => ({
        scene_id: s.scene_id,
        t: s.start_time,
        fact: s.plot?.fact,
        characters: s.characters.map(c => c.id)
      }));
  }

  if (/线索|伏笔|暗示/.test(question)) {
    return pastScenes
      .filter(s => s.foreshadow?.setup_hint || s.foreshadow?.is_payoff_of?.length)
      .map(s => ({
        scene_id: s.scene_id,
        t: s.start_time,
        fact: s.plot?.fact,
        hint: s.foreshadow?.setup_hint
      }));
  }

  return pastScenes.map(s => ({
    scene_id: s.scene_id,
    t: s.start_time,
    fact: s.plot?.fact
  }));
}

function buildToolBundle(kb, t, question) {
  const intents = detectIntents(question);
  const mentionedLocations = getMentionedLocations(kb, question);
  if (mentionedLocations.length) intents.location = true;
  const primary = inferPrimaryIntent(intents);

  return {
    primary,
    intents,
    shot: intents.shot || primary === 'plot' ? getShotAnalysis(kb, t) : null,
    plot: getPlotContext(kb, t),
    foreshadow: intents.foreshadow ? getForeshadowContext(kb, t) : null,
    characters: intents.character ? getCharacterState(kb, t) : null,
    location: intents.location ? getLocationState(kb, t) : null,
    location_matches: intents.location ? mentionedLocations : [],
    emotion: intents.emotion || intents.shot ? getEmotionState(kb, t) : null,
    navigation: intents.navigation ? getNavigationContext(kb, t, question) : null
  };
}

function buildContext(kb, params) {
  const {
    cursorTime,
    question,
    mode = 'casual',
    session = {}
  } = params;

  const scene = currentScene(kb, cursorTime);
  const toolBundle = buildToolBundle(kb, cursorTime, question);

  return {
    video_title: kb.title,
    current_time: cursorTime,
    mode,
    current_scene: scene ? {
      scene_id: scene.scene_id,
      time_range: [scene.start_time, scene.end_time],
      timed_visual_beat: currentVisualBeat(scene, cursorTime),
      plot_fact: scene.plot?.fact,
      plot_reading: scene.plot?.reading,
      narrative: scene.narrative || null,
      shot: scene.shot || null,
      characters: enrichCharacters(kb, scene.characters, cursorTime),
      location: getLocationState(kb, cursorTime),
      foreshadow_setup_hint: scene.foreshadow?.setup_hint || null,
      tags: scene.tags || []
    } : null,
    recent_plot: getPlotContext(kb, cursorTime),
    tool_bundle: toolBundle,
    conversation_memory: {
      last_questions: session.last_questions || [],
      last_topics: session.last_topics || []
    }
  };
}

function shouldShowPassiveCard(scene, mode = 'casual') {
  if (!scene) return false;
  if (mode === 'immersive') return false;

  const importance = scene.narrative?.importance || 0;
  const shouldHint = !!scene.narrative?.should_hint;
  const shotImportance = scene.shot?.importance || 0;
  const hasForeshadow = !!scene.foreshadow?.setup_hint;

  return shouldHint || importance >= 0.72 || shotImportance >= 0.72 || hasForeshadow;
}

function passiveCards(kb, cursorTime, options = {}) {
  const { mode = 'casual', lastCardSceneId = null } = options;
  const scene = currentScene(kb, cursorTime);

  if (!shouldShowPassiveCard(scene, mode)) return [];
  if (lastCardSceneId && scene.scene_id === lastCardSceneId) return [];

  const cards = [];

  if (scene.shot?.intent && (scene.shot.importance || 0) >= 0.65) {
    cards.push({
      type: 'shot',
      priority: scene.shot.importance || 0.7,
      title: '镜头语言',
      body: scene.shot.intent,
      meta: [scene.shot.framing, scene.shot.camera, scene.shot.light].filter(Boolean).join(' · '),
      scene_id: scene.scene_id
    });
  }

  if (scene.foreshadow?.setup_hint) {
    cards.push({
      type: 'foreshadow-setup',
      priority: 0.85,
      title: '留意这个细节',
      body: scene.foreshadow.setup_hint,
      scene_id: scene.scene_id
    });
  }

  if (scene.narrative?.role || scene.narrative?.phase) {
    cards.push({
      type: 'narrative',
      priority: scene.narrative?.importance || 0.6,
      title: '叙事节奏',
      body: `这一段处在"${scene.narrative.role || scene.narrative.phase}"阶段，情绪张力正在变化。`,
      scene_id: scene.scene_id
    });
  }

  if (scene.foreshadow?.is_payoff_of?.length) {
    const setups = scene.foreshadow.is_payoff_of
      .map(id => sceneById(kb, id))
      .filter(s => s && s.start_time <= cursorTime);

    if (setups.length) {
      cards.push({
        type: 'foreshadow-payoff',
        priority: 0.95,
        title: '前后回扣',
        body: `${setups.map(s => s.plot?.fact).filter(Boolean).join('；')} —— 这里形成了回扣。`,
        scene_id: scene.scene_id
      });
    }
  }

  return cards.sort((a, b) => b.priority - a.priority).slice(0, mode === 'study' ? 3 : 1);
}

const SYSTEM_PROMPT = buildDialogueSystemPrompt();

async function generateWithLLM(context, question) {
  if (!ai.isAvailable('chat')) return null;

  const userMessage = `Context:
\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

用户问题：${question || '请解释当前画面。'}`;

  try {
    const result = await ai.chat({
      task: 'chat',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens: 420,
      temperature: 0.4,
    });
    return result.text || null;
  } catch (err) {
    console.error('[agent] chat error:', err.message);
    return null;
  }
}

function generateTemplate(context, question) {
  const scene = context.current_scene;
  const primary = context.tool_bundle?.primary;

  if (!scene) return '这段暂时还看不出来，可能需要等画面信息更明确一点。';

  if (scene.timed_visual_beat) {
    const beat = scene.timed_visual_beat;
    const people = Array.isArray(beat.identified_people)
      ? beat.identified_people.join('、')
      : '';
    return [people, beat.event, beat.meaning].filter(Boolean).join('。');
  }

  if (primary === 'shot' && scene.shot?.intent) {
    return `这个镜头主要在表达${scene.shot.emotion || '情绪变化'}。${scene.shot.intent}`;
  }

  if (primary === 'foreshadow' && scene.foreshadow_setup_hint) {
    return `${scene.foreshadow_setup_hint} 这里先留意就好，暂时不展开。`;
  }

  if (primary === 'location') {
    const location = context.tool_bundle?.location_matches?.[0] || scene.location?.locations?.[0];
    if (!location) return '这段只能看出室内或野外环境，具体地理位置暂时还无法可靠确定。';
    const sourceNote = location.official_map_entry ? '这是 HBO 官方地图收录的地点。' : '这是按当前单集场景补充绑定的地点。';
    return `${location.display_name}${location.region ? `，位于${location.region}` : ''}。${location.summary || ''}${sourceNote}`;
  }

  if (primary === 'character' && scene.characters?.length) {
    const c = scene.characters[0];
    return `${c.id}现在的状态是${c.emotion || '情绪压住了'}，${c.motivation_shift || '这个反应更像是在隐藏真实意图'}。`;
  }

  if (scene.plot_reading) return scene.plot_reading;
  if (scene.plot_fact) return scene.plot_fact;

  return '这段更像是叙事过渡，目前没有特别明确的隐藏信息。';
}

function prepareRequest(kb, bodyOrQuery = {}) {
  const cursorTime = normalizeTime(bodyOrQuery.t);
  const question = String(bodyOrQuery.question || '').trim();
  const mode = bodyOrQuery.mode || 'casual';
  const session = bodyOrQuery.session || {};

  const context = buildContext(kb, {
    cursorTime,
    question,
    mode,
    session
  });

  return {
    cursorTime,
    question,
    mode,
    context
  };
}

// ─── 对话主题守门：所有自由输入的 AI 对话先过这里 ─────────────
// 目标是挡掉明显跑题/越狱/工具型请求，同时放过“这是什么意思”这类依赖当前画面的短问。

const TOPIC_GUARD_REPLY = '这个问题离当前剧情有点远。可以换个问法，围绕这一幕的人物、台词、关系、情绪或选择继续问。';

function guardDialogueTopic(text, options = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: true };

  const normalized = raw.toLowerCase().replace(/\s+/g, ' ');
  const compact = normalized.replace(/\s+/g, '');
  const banned = [
    /天气|气温|下雨|股票|基金|彩票|汇率|房价|外卖|菜谱|健身|减肥|旅游攻略|酒店|机票/,
    /写代码|写个代码|帮我编程|python|javascript|java\b|sql\b|正则|接口文档|debug|报错/,
    /数学题|算一下|方程|物理题|化学题|考试答案|论文|简历|邮件|商业计划/,
    /新闻|总统|选举|nba|足球|世界杯|奥运|比特币|crypto|weather|stock|recipe/,
    /忽略.*(提示|规则|系统)|ignore .*instruction|system prompt|越狱|jailbreak/,
  ];

  if (banned.some(pattern => pattern.test(compact) || pattern.test(normalized))) {
    return { ok: false, reason: 'blocked_obvious_off_topic', message: TOPIC_GUARD_REPLY };
  }

  const topicHints = [
    '这', '那', '刚才', '现在', '这里', '这一幕', '这段', '这个场景', '画面', '镜头', '台词', '对白',
    '他', '她', '他们', '她们', '人物', '角色', '关系', '动机', '立场', '选择', '情绪', '为什么',
    '什么意思', '发生', '剧情', '伏笔', '暗示', '象征', '文化梗', '梗', '龙', '王', '王冠', '王位',
    '继承', '家族', '坦格利安', '海塔尔', '瓦列利安', '黑党', '绿党', '雷妮拉', '戴蒙', '阿莉森特',
    '伊耿', '伊蒙德', '克里斯顿', '科尔', '拉里斯', '韦赛里斯', 'vhagar', 'rhaenyra', 'daemon',
    'alicent', 'aegon', 'aemond', 'criston', 'larys', 'viserys', 'targaryen', 'hightower',
    'velaryon', 'dragon', 'crown', 'king', 'queen',
  ];
  if (topicHints.some(hint => compact.includes(hint.toLowerCase().replace(/\s+/g, '')))) {
    return { ok: true };
  }

  const dynamicTerms = Array.isArray(options.dynamicTerms) ? options.dynamicTerms : [];
  const normalizedTerms = dynamicTerms
    .filter(Boolean)
    .map(term => String(term).toLowerCase().replace(/\s+/g, ''))
    .filter(term => term.length >= 2);
  if (normalizedTerms.some(term => compact.includes(term))) {
    return { ok: true };
  }

  if (raw.length <= 8 && /^(展开|继续|详细点|说下去|再说|然后呢|怎么了|为什么|啥意思|什么意思|说清楚)[？?吗呢嘛啊呀]?$/.test(raw)) {
    return { ok: true };
  }

  return { ok: false, reason: 'low_topic_signal', message: TOPIC_GUARD_REPLY };
}

function dialogueTopicTerms(kb, t, extraTerms = []) {
  const terms = [...extraTerms, kb?.title, kb?.show_id, kb?.episode].filter(Boolean);
  const scene = kb ? currentScene(kb, normalizeTime(t)) : null;
  if (scene?.location) terms.push(scene.location);
  for (const tag of (scene?.tags || [])) terms.push(tag);
  const showId = kb?.show_id || 'house-of-the-dragon';
  const db = getCharacterDb(showId);
  for (const c of (db?.characters || [])) {
    terms.push(c.character_id, c.display_name_zh, c.canonical_name, c.house, c.short_identity_zh);
    if (Array.isArray(c.aliases)) terms.push(...c.aliases);
  }
  return terms;
}

// ─── 人物识别：face_service 优先 + 智能跳过 LLM ─────────────
function collectSceneCharacterIds(scene) {
  if (!scene) return [];
  const ids = [];
  for (const item of (scene.characters_on_screen || [])) {
    const id = item?.character_id || item?.id;
    if (id) ids.push(id);
  }
  for (const item of (scene.characters || [])) {
    const id = item?.character_id || item?.id;
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

function generateVisualFallback(context, question) {
  const scene = context?.current_scene;
  if (scene?.timed_visual_beat?.identity_lock) {
    return generateTemplate(context, question);
  }
  return '视觉识别服务暂时不可用。场景摘要不能证明当前前景人物的身份，所以这里不猜；请稍后重试这个镜头。';
}

function explicitCharactersOnScreenAt(scene, cursorTime) {
  if (!scene || !Array.isArray(scene.characters_on_screen)) return [];
  return scene.characters_on_screen.filter(item => {
    const start = Number(item?.start_time);
    const end = Number(item?.end_time);
    const afterStart = !Number.isFinite(start) || cursorTime >= start;
    const beforeEnd = !Number.isFinite(end) || cursorTime <= end;
    return afterStart && beforeEnd;
  });
}

function buildRecognitionContext(kb, cursorTime, videoId) {
  if (!kb) return null;
  const scene = currentScene(kb, cursorTime);
  if (!scene) return null;

  const currentIds = collectSceneCharacterIds(scene);
  const candidateSet = new Set(currentIds);

  // 如果当前切片缺人物标注，就借前后短窗口兜底；有当前切片时不扩大，避免把候选池稀释回全库。
  const NEAR_S = 45;
  const nearbyScenes = currentIds.length
    ? []
    : (kb.scenes || []).filter(s =>
        s.scene_id !== scene.scene_id &&
        s.end_time >= cursorTime - NEAR_S &&
        s.start_time <= cursorTime + NEAR_S
      );
  for (const s of nearbyScenes) {
    for (const id of collectSceneCharacterIds(s)) candidateSet.add(id);
  }

  const candidate_character_ids = [...candidateSet];
  const subtitle_window = videoId
    ? srtWindow(videoId, cursorTime, 20, 0)
        .slice(-5)
        .map(c => ({ t: c.start, text: c.text }))
    : [];
  return {
    scene_id: scene.scene_id,
    time_range: [scene.start_time, scene.end_time],
    scene_label: scene.label_zh || scene.label || null,
    location: scene.location || scene.location_label || null,
    plot_fact: scene.plot?.fact || scene.plot_fact || null,
    plot_reading: scene.plot?.reading || null,
    subtitle_window,
    source: currentIds.length ? 'current_scene_slice' : 'nearby_scene_slices',
    candidate_character_ids,
  };
}

async function recognizeViaFaceService({ image, db, cursor, recognitionContext }) {
  const url = process.env.FACE_SERVICE_URL;
  if (!url) return null;
  const fr = await fetch(`${url}/recognize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image,
      candidate_character_ids: recognitionContext?.candidate_character_ids || [],
    }),
    // 服务起着 < 500ms；没起会立刻 ECONNREFUSED。3s 给冷启动留 buffer。
    signal: AbortSignal.timeout(3000),
  });
  if (!fr.ok) throw new Error(`face_service HTTP ${fr.status}`);
  const fdata = await fr.json();
  const allFaces = fdata.faces || [];
  const raw = allFaces
    .filter(f => f.match && f.match.character_id)
    .map(f => {
      const card = charactersLib.lookupCharacter(db, f.match.character_id, cursor);
      return {
        character_id: f.match.character_id,
        display_name: card?.display_name || f.match.character_id,
        short_identity: card?.short_identity || card?.current?.title || null,
        confidence: f.match.similarity,
        spoiler_safety: cursor ? 'cursor_filtered' : 'baseline_only',
        bbox: f.bbox,
        source: 'insightface',
      };
    });
  // 同一 character_id 取 similarity 最高（RetinaFace 群像偶尔重复检出）
  const byChar = new Map();
  for (const c of raw) {
    const cur = byChar.get(c.character_id);
    if (!cur || c.confidence > cur.confidence) byChar.set(c.character_id, c);
  }
  const matched = Array.from(byChar.values());
  // 跳过 LLM 的判定要的是「总检出脸数 vs 匹配脸数」，不是去重后的角色数
  // —— 多张脸都对到同一个角色（双胞胎特写、镜像）算"全部识出"。
  const totalDetected = allFaces.length;
  const rawMatchedCount = raw.length;
  return {
    matched,
    totalDetected,
    rawMatchedCount,
    contextFilterApplied: !!fdata.context_filter_applied,
    gallerySearchSize: fdata.gallery_search_size ?? null,
  };
}

async function recognizeViaLLM({ image, db, cursor, recognitionContext }) {
  if (!ai.isAvailable('vision')) return null;

  const contextIds = new Set(recognitionContext?.candidate_character_ids || []);
  const knownChars = db ? (db.characters || []).map(c => ({
    character_id: c.character_id,
    display_name_zh: c.display_name_zh,
    short_identity_zh: c.short_identity_zh,
    house: c.house,
  })) : [];

  const SYSTEM = `你是影视人物识别 Agent。看到一帧画面后识别画面里清晰可见的主要人物。
这是 HBO 剧集《House of the Dragon》（龙之家族）/《Game of Thrones》（权力的游戏）的画面。

**铁律**（违反就是 bug）：
1. 一张脸只能对应一个角色 —— 绝对不要给同一张脸返回两个候选。
2. 只识别能 100% 确定的角色。脸不清/侧脸/遮挡/光线差 → 跳过，不要返回。
3. confidence < 0.75 一律不要返回。宁可整张图返回空 characters[]，不要乱猜。
4. 一帧画面里通常只有 1-3 张清晰主要人物。返回 4+ 个几乎一定是过度推断。

字段规则：
5. display_name_zh 用中文角色名（如"科利斯·瓦列利安"），不是演员名。
6. short_identity_zh 写最具识别度的一种身份/称号，例如 "海蛇"、"七大王国之王"、"龙骑士"，≤20 字。
7. 命中 known character database 里的角色时把 character_id 填入；否则留空。
8. **face_bbox**：必须给出脸部包围盒 [x1, y1, x2, y2]，0..1 相对坐标。位置不确定就跳过这个角色（别返回）。

只输出严格 JSON。`;

  const RESPONSE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['characters'],
    properties: {
      characters: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['display_name_zh', 'short_identity_zh', 'character_id', 'confidence', 'face_bbox'],
          properties: {
            display_name_zh: { type: 'string' },
            short_identity_zh: { type: 'string' },
            character_id: { type: 'string' },
            confidence: { type: 'number' },
            face_bbox: { type: 'array', items: { type: 'number' } },
          },
        },
      },
    },
  };

  const contextualKnownChars = contextIds.size
    ? knownChars.filter(c => contextIds.has(c.character_id))
    : knownChars;
  const contextNote = recognitionContext
    ? `\n\n当前视频切片上下文：${JSON.stringify(recognitionContext, null, 2)}\n优先在 candidate_character_ids 里识别；只有画面特征非常确定时，才返回候选之外的角色。`
    : '';

  const userText = contextualKnownChars.length
    ? `Known character database（优先候选；识别到这些角色时，请把对应 character_id 填入返回结果；DB 之外的人物 character_id 留空）：\n${JSON.stringify(contextualKnownChars, null, 2)}${contextNote}\n\n识别下面这一帧画面里的人物：`
    : '识别下面这一帧画面里 HBO《龙之家族》《权力的游戏》中的主要人物：';

  const { data } = await ai.generateStructured({
    task: 'vision',
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', dataUrl: image, detail: 'low' },
        { type: 'text', text: userText },
      ],
    }],
    schema: RESPONSE_SCHEMA,
    schemaName: 'face_recognize',
    temperature: 0.1,
  });

  const out = (data.characters || []).map(c => {
    let display_name = c.display_name_zh;
    let short_identity = c.short_identity_zh;
    let spoiler_safety = 'open_set';
    let charId = c.character_id || null;

    if (db) {
      let dbEntry = null;
      if (charId) dbEntry = (db.characters || []).find(x => x.character_id === charId);
      if (!dbEntry && c.display_name_zh) {
        const target = String(c.display_name_zh).replace(/\s/g, '');
        dbEntry = (db.characters || []).find(x => {
          const names = [x.display_name_zh, x.canonical_name, ...(x.aliases || [])]
            .filter(Boolean)
            .map(name => String(name).replace(/\s/g, '').toLowerCase());
          return names.includes(target.toLowerCase());
        });
      }
      if (dbEntry) {
        charId = dbEntry.character_id;
        const card = charactersLib.lookupCharacter(db, charId, cursor);
        if (card) {
          display_name = card.display_name;
          short_identity = card.short_identity || card.current?.title || short_identity;
          spoiler_safety = cursor ? 'cursor_filtered' : 'baseline_only';
        }
      }
    }
    const bbox = Array.isArray(c.face_bbox) && c.face_bbox.length === 4
      ? c.face_bbox.map(Number).filter(n => Number.isFinite(n) && n >= 0 && n <= 1)
      : null;
    return {
      character_id: charId,
      display_name,
      short_identity,
      confidence: c.confidence || 0,
      spoiler_safety,
      bbox: (bbox && bbox.length === 4) ? bbox : null,
      source: 'llm',
    };
  }).filter(c => c.confidence >= 0.7);

  // LLM 内部去重（防止它给同一张脸返两个候选）
  const dedup = [];
  for (const c of out) {
    const dupIdx = dedup.findIndex(x =>
      (c.character_id && x.character_id === c.character_id) ||
      (x.display_name === c.display_name) ||
      bboxOverlapHigh(x.bbox, c.bbox)
    );
    if (dupIdx === -1) dedup.push(c);
    else if (c.confidence > dedup[dupIdx].confidence) dedup[dupIdx] = c;
  }
  return dedup;
}

// 合并两路结果：face_service 优先（余弦相似度比 LLM 自报 confidence 可信），
// LLM 仅补 face_service 漏掉的人物（开集客串 / 半遮挡 / 未入库）。
function mergeRecognitions(faceChars, llmChars) {
  const merged = faceChars.slice();
  for (const lc of llmChars) {
    const dupIdx = merged.findIndex(x =>
      (lc.character_id && x.character_id === lc.character_id) ||
      (x.display_name && lc.display_name && x.display_name === lc.display_name) ||
      bboxOverlapHigh(x.bbox, lc.bbox)
    );
    if (dupIdx === -1) merged.push(lc);
    // 否则 face_service 版本胜出，不替换
  }
  return merged;
}

function register(app) {
  app.get('/api/agent/locations', (req, res) => {
    const showId = String(req.query.showId || 'house-of-the-dragon');
    const db = getLocationDb(showId);
    if (!db) return res.status(404).json({ show_id: showId, count: 0, locations: [] });
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
    const locations = locationsLib.searchLocations(db, req.query.q || '', {
      officialOnly: String(req.query.officialOnly || '').toLowerCase() === 'true',
      parentId: req.query.parentId || null,
      limit,
    });
    res.json({
      show_id: showId,
      source: db.source || null,
      official_location_count: db.official_location_count || 0,
      supplemental_location_count: db.supplemental_location_count || 0,
      count: locations.length,
      locations,
    });
  });

  app.get('/api/agent/location/current', (req, res) => {
    const kb = loadKB(req.query.videoId);
    if (!kb) return res.status(404).json({ has_kb: false, location: null });
    const cursorTime = normalizeTime(req.query.t);
    const scene = currentScene(kb, cursorTime);
    const db = getLocationDb(kb.show_id);
    const location = db && scene ? locationsLib.resolveSceneLocations(db, scene) : null;
    res.json({
      has_kb: true,
      scene_id: scene?.scene_id || null,
      cursor_time: cursorTime,
      location,
    });
  });

  app.get('/api/agent/characters/on-screen', (req, res) => {
    const { videoId, t } = req.query;
    const kb = loadKB(videoId);
    if (!kb) return res.json({ characters: [], has_kb: false });

    const cursorTime = normalizeTime(t);
    const scene = currentScene(kb, cursorTime);
    if (!scene) return res.json({ characters: [], has_kb: true, scene_id: null });

    const cursor = charactersLib.cursorAtTime(kb, cursorTime);
    const db = getCharacterDb(kb.show_id);

    // 优先用 scene.characters_on_screen (含 bbox)；否则退化成 scene.characters (无 bbox)
    const explicitOnScreen = explicitCharactersOnScreenAt(scene, cursorTime);
    const onScreen = explicitOnScreen.length
      ? explicitOnScreen
      : (scene.characters || []).map(c => ({ character_id: c.id }));

    const out = onScreen.map(item => {
      const id = item.character_id || item.id;
      if (!db) return { character_id: id, display_name: id, short_identity: null, bbox: item.bbox || null };
      const card = charactersLib.lookupCharacter(db, id, cursor);
      if (!card) return { character_id: id, display_name: id, short_identity: null, bbox: item.bbox || null };
      const identity = card.short_identity || card.current?.title || card.house || null;
      return {
        character_id: id,
        display_name: card.display_name,
        short_identity: identity,
        bbox: item.bbox || null,
        confidence: item.confidence ?? null,
      };
    });

    res.json({
      characters: out,
      has_kb: true,
      scene_id: scene.scene_id,
      cursor_used: cursor,
    });
  });

  app.post('/api/agent/characters/recognize', async (req, res) => {
    const { videoId, t, image } = req.body || {};
    if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
      return res.status(400).json({ error: 'image (data URL) required', characters: [] });
    }

    const kb = videoId ? loadKB(videoId) : null;
    const cursorTime = normalizeTime(t);
    const cursor = kb ? charactersLib.cursorAtTime(kb, cursorTime) : null;
    // 没 KB 时也加载默认 show DB
    const db = kb ? getCharacterDb(kb.show_id) : getCharacterDb('house-of-the-dragon');
    const recognitionContext = kb ? buildRecognitionContext(kb, cursorTime, videoId) : null;

    // face_service 先跑，识到 ≥1 张就跳过 LLM；没起 / 没检出脸时才调 LLM 兜底。
    // 见 recognizeViaFaceService 上方注释里的设计说明。
    const t0 = Date.now();
    let faceResult = null;
    try {
      faceResult = await recognizeViaFaceService({ image, db, cursor, recognitionContext });
    } catch (e) {
      console.warn('[recognize] face_service:', e?.message || e);
    }
    const tFace = Date.now() - t0;

    const faceChars = faceResult?.matched || [];
    const totalDetected = faceResult?.totalDetected ?? 0;
    const rawMatchedCount = faceResult?.rawMatchedCount ?? 0;

    // 跳 LLM 的条件：face_service 起着 + 至少识到一张脸。
    // 之前要求"检出全部都匹配上"，但半匹配场景（一张主角 + 一个开集背景人物）
    // 也要等 ~2-5s 的 LLM 才能返回，体感很差。放宽到「识到 ≥1」：偶尔漏掉
    // 开集 / 客串人物，但常见路径从 ~3s 降到 ~200ms。要补开集人物的话由用户
    // 二次点击触发。
    const fastReturn = faceResult !== null && rawMatchedCount >= 1;

    if (fastReturn) {
      console.log(`[recognize] fast: face=${tFace}ms matched=${rawMatchedCount}/${totalDetected}`);
      return res.json({
        characters: faceChars,
        cursor_used: cursor,
        has_kb: !!kb,
        llm_ready: ai.isAvailable('vision'),
        recognition_context: recognitionContext,
        sources: {
          insightface: faceChars.length,
          llm: 0,
          faces_detected: totalDetected,
          context_filter_applied: !!faceResult?.contextFilterApplied,
          gallery_search_size: faceResult?.gallerySearchSize ?? null,
        },
        skipped: rawMatchedCount === totalDetected
          ? 'llm_unneeded_face_service_full_match'
          : 'llm_unneeded_face_service_partial_match',
        elapsed_ms: Date.now() - t0,
      });
    }

    // 否则 LLM 兜底（face_service 没起 / 没检出脸 / 一张都没匹配上）。
    // 8s 硬超时：之前 LLM 卡住会让前端等满 axios 30s 才看到失败。
    let llmChars = [];
    const tLlm0 = Date.now();
    try {
      const llmPromise = recognizeViaLLM({ image, db, cursor, recognitionContext });
      const result = await Promise.race([
        llmPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('llm_timeout_8s')), 8000),
        ),
      ]);
      llmChars = result || [];
    } catch (e) {
      console.error('[recognize] llm:', e?.message || e);
    }
    const tLlm = Date.now() - tLlm0;

    const characters = mergeRecognitions(faceChars, llmChars);

    console.log(`[recognize] slow: face=${tFace}ms llm=${tLlm}ms detected=${totalDetected} face_matched=${faceChars.length} llm_added=${llmChars.length}`);
    res.json({
      characters,
      cursor_used: cursor,
      has_kb: !!kb,
      llm_ready: ai.isAvailable('vision'),
      recognition_context: recognitionContext,
      sources: {
        insightface: faceChars.length,
        llm: llmChars.length,
        faces_detected: totalDetected,
        context_filter_applied: !!faceResult?.contextFilterApplied,
        gallery_search_size: faceResult?.gallerySearchSize ?? null,
      },
      elapsed_ms: Date.now() - t0,
    });
  });

  app.get('/api/agent/characters/detail', (req, res) => {
    const { videoId, characterId, t } = req.query;
    const kb = loadKB(videoId);
    if (!kb) return res.json({ has_kb: false });
    const db = getCharacterDb(kb.show_id);
    if (!db || !characterId) return res.json({ has_kb: true, has_character_db: !!db, character: null });

    const cursorTime = normalizeTime(t);
    const cursor = charactersLib.cursorAtTime(kb, cursorTime);
    const card = charactersLib.lookupCharacter(db, characterId, cursor);
    if (!card) return res.json({ has_kb: true, has_character_db: true, character: null });

    const relationships = charactersLib.lookupRelationships(db, characterId, cursor);
    const relWithNames = relationships.map(r => {
      const other = charactersLib.findCharacter(db, r.with);
      return {
        ...r,
        with_display_name: other?.display_name_zh || other?.canonical_name || r.with,
        with_short_identity: other?.short_identity_zh || null,
      };
    });

    res.json({
      has_kb: true,
      has_character_db: true,
      cursor_used: cursor,
      character: { ...card, relationships: relWithNames },
    });
  });

  // 关系图：返回 hero 一阶关系 + 各方肖像 URL（spoiler-safe，按 cursor 过滤）
  // GET /api/agent/characters/relationship-graph?videoId=&characterId=&t=
  app.get('/api/agent/characters/relationship-graph', (req, res) => {
    const { videoId, characterId, t } = req.query;
    const kb = videoId ? loadKB(videoId) : null;
    const showId = kb ? kb.show_id : 'house-of-the-dragon';
    const db = getCharacterDb(showId);
    if (!db) return res.json({ has_kb: !!kb, has_character_db: false, hero: null, edges: [] });

    const cursorTime = normalizeTime(t);
    const cursor = kb ? charactersLib.cursorAtTime(kb, cursorTime) : null;

    // 没有指定 hero 时，挑一个 main 角色当默认（rhaenyra > 第一个 main）
    let heroId = characterId;
    if (!heroId) {
      const mains = (db.characters || []).filter(c => Array.isArray(c.tags) && c.tags.includes('main'));
      heroId = (mains.find(c => c.character_id === 'rhaenyra_targaryen') || mains[0] || db.characters[0]).character_id;
    }

    const heroCard = charactersLib.lookupCharacter(db, heroId, cursor);
    if (!heroCard) {
      return res.json({ has_kb: !!kb, has_character_db: true, cursor_used: cursor, hero: null, edges: [] });
    }
    const heroVersion = heroCard.current_actor?.version || null;
    const heroPortrait = charactersLib.pickPortraitUrl(heroId, heroVersion);

    const rels = charactersLib.lookupRelationships(db, heroId, cursor);
    const edges = rels
      // 龙不再是关系图的"边"。改成节点的 companion 属性，下面单独挂。
      .filter(r => !charactersLib.characterHasTag(db, r.with, 'dragon'))
      .map(r => {
        const otherCard = charactersLib.lookupCharacter(db, r.with, cursor);
        const version = otherCard?.current_actor?.version || null;
        const portrait = charactersLib.pickPortraitUrl(r.with, version);
        return {
          with: r.with,
          display_name: otherCard?.display_name || r.with,
          short_identity: otherCard?.short_identity || null,
          house: otherCard?.house || null,
          relation: r.relation,            // 中文关系类型，如 "父女"、"关系疏离"、"政治对立"
          relation_en: r.relation_en || null,
          relation_kind: r.relation_kind || null,        // 6 大视觉类：blood/marriage/ally/friend/enemy/secret
          summary: r.summary || null,
          portrait_url: portrait,
          actor_version: version,
          alive: otherCard?.current?.alive !== false,   // false = 已在当前时间节点死亡
          companion: charactersLib.findCompanionByTag(db, r.with, cursor, 'dragon'),
        };
      });

    res.json({
      has_kb: !!kb,
      has_character_db: true,
      cursor_used: cursor,
      hero: {
        character_id: heroCard.character_id,
        display_name: heroCard.display_name,
        short_identity: heroCard.short_identity,
        house: heroCard.house,
        actor_version: heroVersion,
        portrait_url: heroPortrait,
        current_title: heroCard.current?.title || null,
        alive: heroCard.current?.alive !== false,
        companion: charactersLib.findCompanionByTag(db, heroId, cursor, 'dragon'),
      },
      edges,
    });
  });

  // ─── 季级时间轴 rollup ────────────────────────────────────
  // 输入：showId（默认 house-of-the-dragon）+ season（默认 1）+ cursor（S01E0N）
  //       或 videoId + t（自动从 KB 的 episode_map 解析出 cursor）
  // 输出：episodes[]（按 cursor 屏蔽未来集）+ causal_links[]（屏蔽未到的）+ factions_def + 每集 faction state
  app.get('/api/agent/timeline/season', (req, res) => {
    const showId = req.query.showId || 'house-of-the-dragon';
    const season = Number(req.query.season || 1);

    // 决定 cursor：显式传 cursor 优先；否则用 videoId+t 解析
    let cursor = null;
    if (typeof req.query.cursor === 'string' && /^S\d{2}E\d{2}$/.test(req.query.cursor)) {
      cursor = req.query.cursor;
    } else if (req.query.videoId) {
      const kb = loadKB(req.query.videoId);
      if (kb) {
        const cursorTime = normalizeTime(req.query.t);
        cursor = charactersLib.cursorAtTime(kb, cursorTime);
        if (!cursor) {
          cursor = kb.episode || kb.episode_map?.[0]?.episode || null;
        }
      }
    }

    const data = seasonLib.getSeasonTimeline(showId, season, cursor);
    if (!data) {
      return res.status(404).json({ error: `season metadata not found for ${showId} season ${season}` });
    }
    res.json(data);
  });

  app.get('/api/agent/cards', (req, res) => {
    const { videoId, t, mode, lastCardSceneId } = req.query;
    const kb = loadKB(videoId);

    if (!kb) {
      return res.json({ cards: [], has_kb: false });
    }

    const cursorTime = normalizeTime(t);
    const scene = currentScene(kb, cursorTime);

    res.json({
      cards: passiveCards(kb, cursorTime, {
        mode: mode || 'casual',
        lastCardSceneId: lastCardSceneId || null
      }),
      has_kb: true,
      scene_id: scene?.scene_id || null,
      narrative: scene?.narrative || null
    });
  });

  app.post('/api/agent/chat', async (req, res) => {
    const { videoId } = req.body || {};
    const kb = loadKB(videoId);

    if (!kb) {
      return res.json({
        answer: '这个视频还没有预处理知识库，无法解读。',
        has_kb: false
      });
    }

    const prepared = prepareRequest(kb, req.body);
    const topicGuard = guardDialogueTopic(prepared.question, {
      dynamicTerms: dialogueTopicTerms(kb, prepared.cursorTime),
    });
    if (!topicGuard.ok) {
      return res.json({
        answer: topicGuard.message,
        has_kb: true,
        source: 'topic_guard',
        cursor_time: prepared.cursorTime,
        mode: prepared.mode,
        primary_intent: null,
        intents: {},
        guard_reason: topicGuard.reason,
      });
    }

    let answer = await generateWithLLM(prepared.context, prepared.question);
    const source = answer ? 'llm' : 'template';

    if (!answer) {
      answer = generateTemplate(prepared.context, prepared.question);
    }

    res.json({
      answer,
      has_kb: true,
      source,
      cursor_time: prepared.cursorTime,
      mode: prepared.mode,
      primary_intent: prepared.context.tool_bundle.primary,
      intents: prepared.context.tool_bundle.intents
    });
  });

  app.post('/api/agent/chat/stream', async (req, res) => {
    const { videoId } = req.body || {};

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const kb = loadKB(videoId);
    const hasImageEarly = !!(req.body?.image && typeof req.body.image === 'string' && req.body.image.startsWith('data:image/'));
    const vf = req.body?.videoFile;
    const hasVideoFileEarly = !!(vf && typeof vf === 'string' && /^[a-zA-Z0-9._\-]+$/.test(vf) && !vf.includes('..') && fs.existsSync(path.join(UPLOADS_DIR, vf)));

    // 无 KB 又无图也无视频文件 → 拒答；有视频文件可以走 server-side ffmpeg
    if (!kb && !hasImageEarly && !hasVideoFileEarly) {
      send('meta', { has_kb: false });
      send('text', { delta: '没有 KB、画面截图或视频源，无法回答。' });
      send('done', { source: 'error' });
      return res.end();
    }

    // prepared 在无 KB 时构造一个最小壳，让后续代码不崩
    const prepared = kb ? prepareRequest(kb, req.body) : {
      cursorTime: normalizeTime(req.body?.t),
      question: String(req.body?.question || '').trim(),
      mode: req.body?.mode || 'casual',
      context: { current_scene: null, tool_bundle: { primary: null, intents: {} } },
    };

    send('meta', {
      has_kb: !!kb,
      cursor_time: prepared.cursorTime,
      mode: prepared.mode,
      primary_intent: prepared.context.tool_bundle?.primary || null,
      intents: prepared.context.tool_bundle?.intents || {},
      mode_used: (hasImageEarly ? 'vision' : 'kb'),
    });

    const topicGuard = guardDialogueTopic(prepared.question, {
      dynamicTerms: dialogueTopicTerms(kb, prepared.cursorTime),
    });
    if (!topicGuard.ok) {
      send('text', { delta: topicGuard.message });
      send('done', { source: 'topic_guard', reason: topicGuard.reason });
      return res.end();
    }

    // 任务类型在拿到 image/clipFrames 之后再决定（visualMode 才走 vision_chat）
    const controller = new AbortController();

    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const image = req.body?.image;
    const hasImage = image && typeof image === 'string' && image.startsWith('data:image/');

    // Server-side clip extraction: ffmpeg 在 cursor 附近抓 3 张帧。
    // 这一步会给前端的"思考中…"加 1.5-3s 串行延迟，对 oneline / brief 档
    // 收益不大（前端已经送了一张当前帧），所以默认关掉，只在用户明确选
    // 「深挖（deep）」档时才打开。前端也可以用 ?clipFrames=true /
    // body.clipFrames=true 强制开启。
    const requestedDepth = ['oneline', 'brief', 'deep'].includes(req.body?.depth)
      ? req.body.depth : 'brief';
    const wantClipFrames = requestedDepth === 'deep' || req.body?.clipFrames === true;
    const videoFile = req.body?.videoFile;
    let clipFrames = [];
    if (wantClipFrames && videoFile && typeof videoFile === 'string'
        && /^[a-zA-Z0-9._\-]+$/.test(videoFile) && !videoFile.includes('..')) {
      const vp = path.join(UPLOADS_DIR, videoFile);
      try {
        clipFrames = await extractClipFrames(vp, prepared.cursorTime, 8, 3);
      } catch (e) {
        console.error('[chat] clip extract failed:', e.message);
      }
    }
    const hasClip = clipFrames.length > 0;
    const visualMode = hasImage || hasClip;

    let userContent;
    if (visualMode) {
      // 视觉模式：服务端 ffmpeg 抽 N 帧 + 前端单帧 + KB 字典 + wiki lore + 历史对话 + 分析方法
      const db = kb ? getCharacterDb(kb.show_id) : null;
      const cursor = kb ? charactersLib.cursorAtTime(kb, prepared.cursorTime) : null;
      let seasonMeta = null;
      if (kb?.show_id) {
        try {
          seasonMeta = seasonLib.loadSeason(kb.show_id, kb.season || 1);
        } catch { /* season metadata is an optional recovery source */ }
      }
      const allCharacterDictionary = db ? (db.characters || []).map(c => {
        const card = charactersLib.lookupCharacter(db, c.character_id, cursor);
        return {
          character_id: c.character_id,
          display_name: c.display_name_zh,
          canonical_name: c.canonical_name,
          short_identity: c.short_identity_zh,
          house: c.house,
          actor_name: c.actor_versions?.[0]?.actor_name || null,
          aliases: Array.isArray(c.aliases) ? c.aliases : [],
          gender_zh: c.gender_zh || null,
          pronoun_zh: c.pronoun_zh || null,
          current_title: card?.current?.title || null,
        };
      }) : [];

      const exchanges = Array.isArray(req.body?.session?.last_exchanges) ? req.body.session.last_exchanges.slice(-6) : [];
      const previousFromAgent = exchanges
        .filter(e => e.role === 'agent' && e.text)
        .slice(-4)
        .map(e => ({ t: typeof e.t === 'number' ? Math.floor(e.t) : null, observed: String(e.text).slice(0, 280) }));
      const previousFromKb = kb && Array.isArray(kb.scenes)
        ? kb.scenes
            .filter(s => s.end_time <= prepared.cursorTime && s.plot?.fact)
            .slice(-12)   // 6 → 12：30-90s 的剧情纵深，避免回答漂成"百科介绍"
            .map(s => ({ t: s.start_time, scene_id: s.scene_id, summary: s.plot.fact, reading: s.plot?.reading || null }))
        : [];
      const conversation = exchanges.map(e => ({
        role: e.role === 'user' ? 'user' : 'agent',
        t: typeof e.t === 'number' ? Math.floor(e.t) : null,
        text: String(e.text || '').slice(0, 280),
      }));

      // ─── 检索：根据当前场景在场角色 + 用户问题，从 wiki + 解说库 拉相关知识 ─────
      // 当前 scene 的 characters_on_screen 是最强的「在场」信号；其次取最近 3 个 scene 的角色
      const scene = currentScene(kb, prepared.cursorTime);
      const sceneCharIds = new Set();
      for (const r of (scene?.characters_on_screen || [])) {
        if (r.character_id) sceneCharIds.add(r.character_id);
      }
      for (const c of (scene?.characters || [])) {
        if (c.id) sceneCharIds.add(c.id);
      }

      // 不把全剧角色表交给视觉模型。候选池仅覆盖当前场景和前后 45 秒，
      // 既容忍切镜边界误差，也避免高知名度角色凭先验概率“抢答”。
      const nearbyCharIds = new Set(sceneCharIds);
      for (const nearbyScene of (kb?.scenes || [])) {
        if (nearbyScene.end_time < prepared.cursorTime - 45) continue;
        if (nearbyScene.start_time > prepared.cursorTime + 45) continue;
        for (const item of (nearbyScene.characters_on_screen || [])) {
          if (item.character_id) nearbyCharIds.add(item.character_id);
        }
        for (const item of (nearbyScene.characters || [])) {
          if (item.id) nearbyCharIds.add(item.id);
        }
      }
      const subtitleWindow = (scene?.subtitles || [])
        .filter(subtitle => subtitle.end >= prepared.cursorTime - 8 && subtitle.start <= prepared.cursorTime + 8)
        .map(subtitle => ({ start: subtitle.start, end: subtitle.end, text: subtitle.text }));
      const subtitleEvidenceText = subtitleWindow.map(subtitle => subtitle.text).join(' ').toLowerCase().replace(/\s+/g, '');
      for (const character of allCharacterDictionary) {
        const identityTerms = [character.display_name, character.canonical_name, character.character_id, ...(character.aliases || [])]
          .filter(Boolean)
          .map(term => String(term).toLowerCase().replace(/\s+/g, ''))
          .filter(term => term.length >= 2);
        if (identityTerms.some(term => subtitleEvidenceText.includes(term))) {
          nearbyCharIds.add(character.character_id);
        }
      }
      const characterDictionary = allCharacterDictionary
        .filter(character => nearbyCharIds.has(character.character_id))
        .slice(0, 12);
      const episodeCharacterIds = new Set(Object.keys(seasonMeta?.faction_membership || {}));
      const identityRecoveryDictionary = allCharacterDictionary
        .filter(character => episodeCharacterIds.has(character.character_id))
        .filter(character => !nearbyCharIds.has(character.character_id))
        .map(character => ({
          character_id: character.character_id,
          display_name: character.display_name,
          canonical_name: character.canonical_name,
          short_identity: character.short_identity,
          actor_name: character.actor_name,
          aliases: character.aliases,
          gender_zh: character.gender_zh,
          pronoun_zh: character.pronoun_zh,
        }));
      // 把 character_id 翻译成中文名 + 别名，给检索打分用
      const charNames = [];
      const charAliases = [];
      for (const cid of sceneCharIds) {
        const entry = (db?.characters || []).find(c => c.character_id === cid);
        if (!entry) continue;
        if (entry.display_name_zh) charNames.push(entry.display_name_zh);
        if (entry.canonical_name) charAliases.push(entry.canonical_name);
        if (Array.isArray(entry.aliases)) charAliases.push(...entry.aliases);
        if (entry.house) charAliases.push(entry.house);
        if (entry.short_identity_zh) charAliases.push(entry.short_identity_zh);
      }
      const retrievedKnowledge = await retrieveKnowledge({
        query: prepared.question || '',
        characterNames: charNames,
        characterAliases: charAliases,
        k: 8,
        cursor: {
          show_id: kb.show_id,
          video_id: kb.video_id,
          season: kb.season,
          episode: charactersLib.cursorAtTime(kb, prepared.cursorTime),
          cursorTime: prepared.cursorTime,
          allowedSpoilerLevel: 0,
        },
        currentScene: scene,
        characterIds: (scene && scene.characters) || [],
      });

      const clipDescription = hasClip
        ? `${clipFrames.length} 张连续画面：` + clipFrames.map((f, i) => {
            const tag = i === 0 ? '稍早' : (i === clipFrames.length - 1 ? '稍后' : '中间≈提问时刻');
            return `第${i + 1}张 (t=${f.t.toFixed(1)}s, ${tag})`;
          }).join('、')
        : null;

      // 当前 scene 的"政治切片"：plot/shot/tags/foreshadow + 在场角色之间的
      // cursor-filtered 关系（夫妻/父子/政敌/暧昧 等）。让 LLM 回答"这俩人
      // 什么关系"或"她为什么生气"时有具体的人事可以引用，不再是百科。
      const currentSceneSlice = scene ? {
        scene_id: scene.scene_id,
        time_range: [scene.start_time, scene.end_time],
        subtitle_window: subtitleWindow,
        timed_visual_beat: currentVisualBeat(scene, prepared.cursorTime),
        identity_metadata_quality: {
          level: currentVisualBeat(scene, prepared.cursorTime)?.identity_lock
            ? 'frame_verified'
            : (explicitCharactersOnScreenAt(scene, prepared.cursorTime).length ? 'timed_annotation' : 'scene_summary_only'),
          scene_character_lists_are_exhaustive: false,
          instruction: 'scene_summary_only 表示人物名单可能漏人；必须以当前图像重新清点前景主体。',
        },
        identity_policy: currentVisualBeat(scene, prepared.cursorTime)?.identity_lock ? {
          mode: 'closed',
          locked_character_id: currentVisualBeat(scene, prepared.cursorTime).identity_lock,
          instruction: '当前秒数身份已经逐帧核验；不得改认成其他角色。',
        } : {
          mode: 'evidence_required',
          instruction: '点名人物前至少需要两类独立证据；证据不足时不要猜。',
        },
        tapestry_meta_reading: scene.tapestry_meta_reading || null,
        location: kb ? getLocationState(kb, prepared.cursorTime) : null,
        plot_fact: scene.plot?.fact || null,
        plot_reading: scene.plot?.reading || null,
        narrative: scene.narrative || null,
        shot_intent: scene.shot?.intent || null,
        shot_emotion: scene.shot?.emotion || null,
        shot_framing: scene.shot?.framing || null,
        tags: scene.tags || [],
        foreshadow_setup_hint: scene.foreshadow?.setup_hint || null,
        characters_on_screen: [...sceneCharIds].map(cid => {
          const e = (db?.characters || []).find(c => c.character_id === cid);
          return {
            character_id: cid,
            display_name: e?.display_name_zh || cid,
            short_identity: e?.short_identity_zh || null,
            house: e?.house || null,
          };
        }),
      } : null;

      // 在场角色两两之间的关系（cursor-filtered，去重）
      const onScreenList = [...sceneCharIds];
      const onScreenRelations = [];
      if (db && onScreenList.length >= 2) {
        const seen = new Set();
        for (const aId of onScreenList) {
          const aRels = charactersLib.lookupRelationships(db, aId, cursor);
          for (const r of aRels) {
            if (!sceneCharIds.has(r.with)) continue;
            const pairKey = [aId, r.with].sort().join('|');
            if (seen.has(pairKey)) continue;
            seen.add(pairKey);
            const aName = ((db.characters || []).find(c => c.character_id === aId))?.display_name_zh || aId;
            const bName = ((db.characters || []).find(c => c.character_id === r.with))?.display_name_zh || r.with;
            onScreenRelations.push({
              between: [aName, bName],
              relation: r.relation || r.relation_kind || '关系',
              kind: r.relation_kind || null,
              summary: r.summary || null,
            });
          }
        }
      }

      // 当前 cursor 在哪个 arc / 集 —— 提供叙事坐标
      let episodeArc = null;
      if (kb?.show_id && cursor) {
        try {
          const epNum = parseInt(String(cursor).match(/^S\d{2}E(\d{2})$/)?.[1] || '0', 10);
          if (seasonMeta?.arcs && epNum) {
            const arc = seasonMeta.arcs.find(a => epNum >= a.ep_range[0] && epNum <= a.ep_range[1]);
            if (arc) {
              episodeArc = {
                episode: cursor,
                arc_label: arc.label_zh,
                arc_subtitle: arc.subtitle_zh,
                arc_id: arc.id,
              };
            }
          }
        } catch { /* season meta missing — non-fatal */ }
      }

      const agentInput = {
        current_time_s: Math.floor(prepared.cursorTime),
        user_mode: prepared.mode || 'casual',
        clip_window: clipDescription,
        episode_arc: episodeArc,
        current_scene: currentSceneSlice,
        on_screen_relations: onScreenRelations,
        previous_context: {
          reliability: 'prior_agent_observations_are_unverified_and_must_not_be_used_as_identity_evidence',
          from_prior_agent_observations: previousFromAgent,
          from_kb_scenes_before_now: previousFromKb,
        },
        conversation,
        character_dictionary: characterDictionary,
        identity_recovery_dictionary: identityRecoveryDictionary,
        mentioned_locations: prepared.context.tool_bundle?.location_matches || [],
        // 用打分检索后的相关知识替换无脑 slice(0,12)
        retrieved_knowledge: retrievedKnowledge,
      };

      // 图像顺序：clipFrames（按时间从早到晚）→ 前端 capture（如果还有的话作为"当前精确时刻"）
      const images = [];
      for (const f of clipFrames) {
        images.push({ type: 'image', dataUrl: f.dataUrl, detail: 'high' });
      }
      if (hasImage) {
        images.push({ type: 'image', dataUrl: image, detail: 'high' });
      }

      userContent = buildVisionUserContent({
        images,
        runtimeContext: agentInput,
        question: prepared.question,
      });
    } else {
      userContent = [{
        type: 'text',
        text: `Context:
\`\`\`json
${JSON.stringify(prepared.context, null, 2)}
\`\`\`

用户问题：${prepared.question || '请解释当前画面。'}`,
      }];
    }

    const depth = requestedDepth;
    const task = visualMode
      ? (depth === 'deep' ? 'vision_chat_deep' : 'vision_chat')
      : 'chat';
    if (!ai.isAvailable(task)) {
      send('text', { delta: visualMode
        ? generateVisualFallback(prepared.context, prepared.question)
        : generateTemplate(prepared.context, prepared.question) });
      send('done', { source: 'template' });
      return res.end();
    }

    // 三档输出（一句 / 简明 / 深挖）+ 三层标注（事实 / 解读 / 推测）
    // depth 在前面 wantClipFrames 那段已经规整过 → 这里直接复用 requestedDepth
    const baseSystem = visualMode ? VISION_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const systemWithSpec = baseSystem + buildAnswerSpec(depth);

    // 两档都以信息密度为先：brief 足够讲清证据与意义，deep 限制篇幅避免重复注水。
    const maxTokens = depth === 'deep' ? 1800 : (depth === 'oneline' ? 60 : 700);

    let usage = null;
    let providerInfo = null;
    let emittedText = false;

    const runStream = async taskName => {
      usage = null;
      providerInfo = null;
      const stream = ai.chatStream({
        task: taskName,
        system: systemWithSpec,
        messages: [{ role: 'user', content: userContent }],
        maxTokens,
        temperature: visualMode ? 0.7 : 0.4,
        signal: controller.signal,
      });

      for await (const chunk of stream) {
        if (chunk.type === 'meta') {
          providerInfo = { provider: chunk.provider, model: chunk.model };
          continue;
        }
        if (chunk.type === 'text' && chunk.delta) {
          emittedText = true;
          send('text', { delta: chunk.delta });
        }
        if (chunk.type === 'done') usage = chunk.usage;
      }
    };

    try {
      await runStream(task);

      send('done', {
        source: 'llm',
        provider: providerInfo?.provider || null,
        model: providerInfo?.model || null,
        usage,
      });

      res.end();
    } catch (err) {
      if (controller.signal.aborted) return res.end();

      console.error('[agent] stream error:', err.message);
      if (task === 'vision_chat_deep' && !emittedText && ai.isAvailable('vision_chat')) {
        try {
          console.warn('[agent] retrying deep visual request with vision_chat fallback');
          await runStream('vision_chat');
          send('done', {
            source: 'llm',
            provider: providerInfo?.provider || null,
            model: providerInfo?.model || null,
            usage,
            fallback_from: 'vision_chat_deep',
          });
          return res.end();
        } catch (fallbackErr) {
          console.error('[agent] vision_chat fallback error:', fallbackErr.message);
        }
      }

      if (!emittedText) {
        send('text', { delta: visualMode
          ? generateVisualFallback(prepared.context, prepared.question)
          : generateTemplate(prepared.context, prepared.question) });
        send('done', { source: 'template' });
      } else {
        send('done', {
          source: 'llm_partial_error',
          provider: providerInfo?.provider || null,
          model: providerInfo?.model || null,
          usage,
        });
      }
      res.end();
    }
  });

  // ─── 共谋者 · 机制 C：平行视角 · HUD 卡片版 ────────────────
  // 不写小说。让 LLM 从安全表 [看到/判断/风险/立场/关系/代价] 里挑 3 个 label，
  // 每张卡片正文写当前场景里 TA 的具体认知。语气是 HBO 译制风的冷峻政治叙事，
  // 不是史书学士那一套。
  app.post('/api/agent/character/card', async (req, res) => {
    const { videoId, t, characterId } = req.body || {};
    const kb = videoId ? loadKB(videoId) : null;
    if (!kb || !characterId) {
      return res.status(400).json({ error: 'videoId + characterId required' });
    }
    const cursorTime = normalizeTime(t);
    const showId = kb.show_id || 'house-of-the-dragon';
    const cursor = charactersLib.cursorAtTime(kb, cursorTime);
    const db = getCharacterDb(showId);
    if (!db) return res.status(503).json({ error: 'character db missing' });

    const protagonistId = SHOW_PROTAGONIST[showId] || null;
    const isProtagonist = !!protagonistId && characterId === protagonistId;
    const expectedLabels = isProtagonist
      ? CHARACTER_CARD_LABELS_PROTAGONIST
      : CHARACTER_CARD_LABELS_DEFAULT;

    const safeCard = charactersLib.lookupCharacter(db, characterId, cursor);
    if (!safeCard) {
      return res.status(404).json({ error: 'character not in db', character_id: characterId });
    }
    const displayName = safeCard.display_name;
    const shortIdentity = safeCard.short_identity || '';
    const house = safeCard.house || '';
    const current = safeCard.current || null;

    // 关系：取所有有效关系，重点找「与主角」那条（仅当 char 不是主角时）
    const allRels = charactersLib.lookupRelationships(db, characterId, cursor);
    const relWithNames = allRels.map(r => {
      const other = charactersLib.findCharacter(db, r.with);
      return {
        ...r,
        with_display_name: other?.display_name_zh || other?.canonical_name || r.with,
      };
    });
    const protagonistRel = !isProtagonist && protagonistId
      ? relWithNames.find(r => r.with === protagonistId) || null
      : null;
    const protagonistName = protagonistId
      ? (charactersLib.findCharacter(db, protagonistId)?.display_name_zh || protagonistId)
      : null;

    // 当前 scene 的事实（如果 KB 有 plot.fact 就拿来给 LLM 当"最近事件"线索）
    const scene = currentScene(kb, cursorTime);
    const recentFact = scene?.plot?.fact || null;

    if (!ai.isAvailable('chat')) {
      // LLM 不可用时，直接用结构化数据兜出一张能看的人物卡
      return res.json({
        ...defaultCharacterCardPayload(displayName, shortIdentity, house, isProtagonist),
        cursor_used: cursor,
        character_id: characterId,
        is_protagonist: isProtagonist,
        source: 'fallback_no_llm',
      });
    }

    const labelExplain = isProtagonist
      ? `["${expectedLabels[0]}", "${expectedLabels[1]}", "${expectedLabels[2]}", "${expectedLabels[3]}"]
其中第 3 张「立场」写 TA 此时的立场/态度（继承人/反抗者/调和者…），不要写"我"`
      : `["${expectedLabels[0]}", "${expectedLabels[1]}", "${expectedLabels[2]}", "${expectedLabels[3]}"]
其中第 3 张「与主角关系」写 TA 与${protagonistName}的关系（截至当前进度），用第三人称`;

    const system = `你是 HBO 《龙之家族》风格的"动态人物卡" Agent。任务：把已结构化的角色数据润成 4 张影视 HUD 风格的极短卡片。

═══ 你看到的是"事实材料"，不是创作素材 ═══
我会把角色 DB 里截至当前剧集的安全数据（身份、家族、关系、近况）原文给你。
你的工作是：**把它压缩成 4 张精炼卡片**，不要编造材料里没有的事。
如果某项材料缺失，写"暂未明朗"或类似克制表达，不要补全。

═══ 风格目标 ═══
- 冷峻、克制、政治化 —— 像宫廷档案，不是诗化旁白
- 抓身份、家族、继承、盟友、敌人、风险、代价
- 现代中文，HBO 译制语气
- 不要"文学感"、不要抒情、不要玄学

═══ 绝对禁止 ═══
- 古风/书房意象：执笔、卷宗、史书、史册、羊皮纸、鹅毛笔、学士、落墨、另一卷、书页、篇章
- 文言/古风副词：汝、吾、岂、毋、由是、其一其二、归途
- 仙侠：苍生、天道、轮回、红尘、众生
- 宿命论修辞：命运、宿命、命运之门、改写历史、抉择
- 旧版 HUD 标签：眼前、盘算、隐忧
- 套话："此刻就在你面前""问问看""问她一句""你后悔吗""你到底想做什么""另一条路"
- "此刻"作为副词也不要用 —— 用"现在""目前""当前"或者干脆不写

═══ 输出严格 JSON ═══
{
  "pov_character": "${displayName}",
  "subtitle": "（≤20 字，TA 当前身份/家族标签，例如「王后｜海塔尔家族」）",
  "cards": [
    {"label": "${expectedLabels[0]}", "text": "（≤32 字）"},
    {"label": "${expectedLabels[1]}", "text": "（≤32 字）"},
    {"label": "${expectedLabels[2]}", "text": "（≤32 字）"},
    {"label": "${expectedLabels[3]}", "text": "（≤32 字）"}
  ]
}

═══ 4 张卡的语义（label 顺序固定） ═══
${labelExplain}

═══ text 硬规则 ═══
1. 每张正文 ≤ 32 中文字符
2. 只能用下面"事实材料"里的内容，不能编造没给你的事
3. 第三人称（"她"/"他"），不写"我"
4. 不引用原剧台词，不暗示未来
5. 写具体、有信息量；不写"她有自己的难处"这种空话

═══ 优秀范例（仅供把握质地，禁止照抄字面） ═══
范例 A（普通角色 · 阿丽森特·海塔尔，主角是雷尼拉）：
{
  "pov_character": "阿丽森特·海塔尔",
  "subtitle": "王后｜海塔尔家族",
  "cards": [
    {"label": "当前身份", "text": "维斯特洛王后，韦赛里斯一世的续弦"},
    {"label": "阵营", "text": "海塔尔家族在朝中的政治支点"},
    {"label": "与主角关系", "text": "与雷尼拉童年挚友，现已疏离对立"},
    {"label": "最近事件", "text": "在雷尼拉婚礼上穿海塔尔家的绿礼服"}
  ]
}
范例 B（主角自己 · 雷尼拉）：
{
  "pov_character": "雷尼拉·坦格利安",
  "subtitle": "龙石岛公主｜王位继承人",
  "cards": [
    {"label": "当前身份", "text": "龙石岛公主，铁王座继承人"},
    {"label": "阵营", "text": "坦格利安家族正统继承一脉"},
    {"label": "立场", "text": "承受家族期待与传统男权双重压力"},
    {"label": "最近事件", "text": "拒绝了克里斯顿·科尔的私奔提议"}
  ]
}

不要任何前后说明、不要 markdown、不要 \`\`\`。直接输出 JSON。`;

    const factMaterial = [
      `【姓名】${displayName}`,
      shortIdentity ? `【简称身份】${shortIdentity}` : null,
      house ? `【家族】${house}` : null,
      current?.title ? `【当前头衔】${current.title}` : null,
      current?.political_role ? `【政治角色】${current.political_role}` : null,
      current?.summary ? `【当前处境（来自 DB）】${current.summary}` : null,
      protagonistRel
        ? `【与主角(${protagonistName})的关系】关系类型：${protagonistRel.relation || '未知'}；摘要：${protagonistRel.summary || '（无）'}`
        : (isProtagonist ? '【主角本人】' : `【与主角(${protagonistName || '未知'})的关系】数据缺失`),
      relWithNames.length
        ? `【其他活跃关系】${relWithNames.filter(r => r.with !== protagonistId).map(r => `${r.with_display_name}：${r.relation}${r.summary ? '（' + r.summary + '）' : ''}`).join('；') || '（无）'}`
        : '【其他活跃关系】（暂无）',
      recentFact ? `【当前画面正在发生】${recentFact}` : null,
    ].filter(Boolean).join('\n');

    const user = `【当前剧集】${cursor || '未知'}
【时间点】${Math.floor(cursorTime / 60)}:${String(Math.floor(cursorTime % 60)).padStart(2, '0')}
${isProtagonist ? '【角色身份】这是当前剧的主角，第 3 张卡用「立场」' : `【角色身份】非主角，第 3 张卡写"与${protagonistName}的关系"`}

【事实材料（来自角色 DB，截至当前剧集）】
${factMaterial}

请把以上事实材料压成 4 张极短卡片。label 顺序固定为 ${JSON.stringify(expectedLabels)}。直接输出 JSON。`;

    try {
      const result = await ai.chat({
        task: 'chat',
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 600,
        temperature: 0.6,
      });
      const txt = String(result?.text || '').trim();
      const parsed = parseCharacterCardJSON(txt, expectedLabels);
      if (!parsed) {
        return res.status(500).json({
          error: 'llm returned non-JSON',
          raw: txt.slice(0, 300),
          fallback: {
            ...defaultCharacterCardPayload(displayName, shortIdentity, house, isProtagonist),
            cursor_used: cursor,
            character_id: characterId,
            is_protagonist: isProtagonist,
            source: 'fallback_parse_fail',
          },
        });
      }
      // 古风/套话/第一人称污染检测
      const bannedHit = parsed.cards.some(c => containsBannedOverlayPhrase(c.text)) ||
        (parsed.subtitle && containsBannedOverlayPhrase(parsed.subtitle));
      const firstPersonHit = parsed.cards.some(c => containsFirstPerson(c.text));
      if (bannedHit || firstPersonHit) {
        return res.status(422).json({
          error: bannedHit ? 'banned phrase in output' : 'first-person leak',
          raw_payload: parsed,
          fallback: {
            ...defaultCharacterCardPayload(displayName, shortIdentity, house, isProtagonist),
            cursor_used: cursor,
            character_id: characterId,
            is_protagonist: isProtagonist,
            source: 'fallback_violation',
          },
        });
      }
      // 强制 actions
      parsed.actions = ['继续观看', '关闭'];
      // subtitle 兜底
      if (!parsed.subtitle && shortIdentity) {
        parsed.subtitle = house ? `${shortIdentity}｜${house}` : shortIdentity;
      }
      if (!parsed.pov_character) parsed.pov_character = displayName;

      res.json({
        ...parsed,
        cursor_used: cursor,
        character_id: characterId,
        is_protagonist: isProtagonist,
        source: 'llm',
      });
    } catch (err) {
      console.error('[character/card] error:', err.message);
      return res.status(500).json({
        error: err.message,
        fallback: {
          ...defaultCharacterCardPayload(displayName, shortIdentity, house, isProtagonist),
          cursor_used: cursor,
          character_id: characterId,
          is_protagonist: isProtagonist,
          source: 'fallback_error',
        },
      });
    }
  });

  // ─── 关系图侧栏 · 详细人物档案（spoiler-safe，多源融合） ─────────
  // 前端关系图点头像后，在右侧浮出。比 character/card 更"长读"——
  // 取角色 DB（cursor-filtered）+ 当前 scene 事实 + 历史 state_timeline +
  // 已有关系数据 + wiki lore（仅家族级，不剧透角色个人），让 LLM 写一篇
  // 短解读：1 句定位 + 2-3 段分析 + 3-5 条剧情节点。严格不剧透 cursor 之后。
  app.post('/api/agent/character/profile', async (req, res) => {
    const { videoId, t, characterId } = req.body || {};
    const kb = videoId ? loadKB(videoId) : null;
    if (!kb || !characterId) {
      return res.status(400).json({ error: 'videoId + characterId required' });
    }
    const cursorTime = normalizeTime(t);
    const showId = kb.show_id || 'house-of-the-dragon';
    const cursor = charactersLib.cursorAtTime(kb, cursorTime);
    const db = getCharacterDb(showId);
    if (!db) return res.status(503).json({ error: 'character db missing' });

    const safeCard = charactersLib.lookupCharacter(db, characterId, cursor);
    if (!safeCard) {
      return res.status(404).json({ error: 'character not in db', character_id: characterId });
    }

    // 历史 state_timeline（cursor 之前的所有状态，用作"角色弧"原料）
    const ch = (db.characters || []).find(c => c.character_id === characterId);
    const pastStates = (ch?.state_timeline || []).filter(s => !s.from || s.from <= cursor);
    const arcRaw = pastStates.map(s => ({
      from: s.from,
      to: s.to,
      title: s.title_zh || s.title_en || null,
      role: s.political_role_zh || null,
      summary: s.safe_summary_zh || null,
    }));

    // 关系（cursor-filtered）：取 top 3 张力最强的（按 intensity_delta 绝对值或显示意义）
    const allRels = charactersLib.lookupRelationships(db, characterId, cursor);
    const relsWithNames = allRels.map(r => {
      const other = charactersLib.findCharacter(db, r.with);
      return {
        ...r,
        with_name: other?.display_name_zh || other?.canonical_name || r.with,
      };
    }).sort((a, b) => Math.abs(b.intensity_delta || 0) - Math.abs(a.intensity_delta || 0));
    const topRels = relsWithNames.slice(0, 4);

    // 当前场景事实（如果 KB 有）
    const scene = currentScene(kb, cursorTime);
    const recentFact = scene?.plot?.fact || null;
    const recentEpisode = scene?.episode_marker || null;

    // wiki lore（家族级，非角色级，不剧透）
    let houseLore = null;
    try {
      const wikiPath = path.join(__dirname, 'references', 'wiki-gameofthrones.knowledge.json');
      if (fs.existsSync(wikiPath)) {
        const wiki = JSON.parse(fs.readFileSync(wikiPath, 'utf8'));
        const houseLabel = `House ${safeCard.house}`;
        const points = (wiki.knowledge_points || []).filter(p =>
          p.title?.includes(safeCard.house) || p.source_entity === houseLabel
        );
        if (points.length) {
          houseLore = points.slice(0, 2).map(p => p.summary).filter(Boolean).join(' ');
        }
      }
    } catch (e) { /* wiki 缺失不阻断主流程 */ }

    // ─── LLM 不可用时的 fallback：直接拼结构化数据 ───────────
    if (!ai.isAvailable('character_profile')) {
      return res.json({
        character_id: characterId,
        display_name: safeCard.display_name,
        headline: safeCard.current?.title
          ? `${safeCard.short_identity || safeCard.current.title}`
          : (safeCard.short_identity || ''),
        analysis: safeCard.current?.summary || '',
        arc_so_far: arcRaw.map(a => a.summary).filter(Boolean),
        book_note: null,
        cursor_used: cursor,
        source: 'fallback_no_llm',
      });
    }

    // ─── LLM 调用 ─────────────────────────────────────────────
    const system = `你是 HBO 政治剧《龙之家族》的"人物档案"写作 agent。任务：把已经按 cursor 过滤好的角色数据写成一段史官式克制的人物解读，配合关系图侧栏展示。

═══ 数据是事实，不是创作素材 ═══
我会给你这个角色截至「${cursor}」（含）为止的安全数据：身份、家族、past states、关系、近期事件、家族 lore。
你的工作是**重新组织+解读**，不要编造材料里没有的事。
材料缺失时写"暂未明朗"或类似克制表达，绝不补全。

═══ 绝对不剧透 ═══
**禁止**：cursor「${cursor}」之后才发生的剧情、未来死亡、未来阵营、未来婚事、龙舞、绿党/黑党正式分裂、阿莉森特/雷尼拉决裂等只在后续集才公开的事件。
**允许**：cursor 当前及之前已经发生的事，包括人物预告（铺垫、动机、矛盾）。
如果你怀疑某条信息是剧透，宁可不写。

═══ 风格 ═══
- 史官式克制（贴合 *Fire & Blood* 历史档案口吻），不是诗化旁白
- 抓政治、家族、继承、矛盾、代价
- 第三人称（"她"/"他"），不写"我"也不写"你"
- 现代汉语，HBO 政治剧译制语气

═══ 绝对禁止用词 ═══
- 古风：执笔、卷宗、史册、羊皮纸、汝、吾、岂、毋、由是
- 仙侠：苍生、天道、轮回、红尘、众生、宿命
- 抒情套话：此刻、命运、改写历史、抉择、宿命、命运之门
- "另一卷"、"书页"、"篇章" 这种自指式书面语

═══ 输出严格 JSON ═══
{
  "headline": "（≤30 字，TA 当前的政治定位 / 家族角色 / 关键张力，一句点睛）",
  "analysis": "（120-200 字，2-3 段，详细解读：身份、家族、动机、当前矛盾。可以引用 past states 显出"角色弧"。不剧透。）",
  "arc_so_far": ["（≤25 字 · 关键节点 1）", "（≤25 字 · 节点 2）", "（≤25 字 · 节点 3）", "..."],
  "book_note": "（≤40 字，可空。如果家族 lore 与 TA 直接相关，写一句"在《血与火》里 House X 是…"的背景注。无关时返回 null）"
}

arc_so_far：3-5 条，按时间顺序，每条是 cursor 之前一个真实发生过的剧情节点（来自 past states / recent_fact）。`;

    const userPayload = {
      cursor_used: cursor,
      character: {
        display_name: safeCard.display_name,
        canonical_name: safeCard.canonical_name,
        short_identity: safeCard.short_identity,
        house: safeCard.house,
        tags: safeCard.tags,
        current: safeCard.current,
      },
      past_states: arcRaw,
      relationships_top: topRels.map(r => ({
        with: r.with_name,
        relation: r.relation,
        kind: r.relation_kind,
        summary: r.summary,
      })),
      recent_event: recentFact ? {
        episode: recentEpisode,
        fact: recentFact,
      } : null,
      house_lore: houseLore,
    };

    try {
      const result = await ai.chat({
        task: 'character_profile',
        system,
        messages: [{
          role: 'user',
          content: '以下是该角色的安全数据（cursor-filtered），请写档案：\n\n' +
            JSON.stringify(userPayload, null, 2),
        }],
        maxTokens: 900,
        temperature: 0.55,
      });
      const txt = String(result?.text || '').trim();
      // 抠 JSON
      let parsed = null;
      try {
        const m = txt.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : null;
      } catch (_) { parsed = null; }
      if (!parsed || typeof parsed !== 'object') {
        return res.status(500).json({
          error: 'llm returned non-JSON',
          raw: txt.slice(0, 300),
          fallback: {
            character_id: characterId,
            display_name: safeCard.display_name,
            headline: safeCard.short_identity || '',
            analysis: safeCard.current?.summary || '',
            arc_so_far: arcRaw.map(a => a.summary).filter(Boolean),
            book_note: null,
            cursor_used: cursor,
            source: 'fallback_parse_fail',
          },
        });
      }
      res.json({
        character_id: characterId,
        display_name: safeCard.display_name,
        headline: parsed.headline || safeCard.short_identity || '',
        analysis: parsed.analysis || (safeCard.current?.summary || ''),
        arc_so_far: Array.isArray(parsed.arc_so_far) ? parsed.arc_so_far.slice(0, 5) : [],
        book_note: parsed.book_note || null,
        cursor_used: cursor,
        source: 'llm',
      });
    } catch (err) {
      console.error('[character/profile] error:', err.message);
      return res.status(500).json({
        error: err.message,
        fallback: {
          character_id: characterId,
          display_name: safeCard.display_name,
          headline: safeCard.short_identity || '',
          analysis: safeCard.current?.summary || '',
          arc_so_far: arcRaw.map(a => a.summary).filter(Boolean),
          book_note: null,
          cursor_used: cursor,
          source: 'fallback_error',
        },
      });
    }
  });

  // ─── 角色内心 · 在 AI 解析面板里"钻进角色脑子里" ──────────────
  // GET /api/agent/character/inner/list?videoId=&t=
  // 返回当前场景里有 roleplay profile 的角色（用于 chooser）
  app.get('/api/agent/character/inner/list', (req, res) => {
    const { videoId, t } = req.query;
    const kb = videoId ? loadKB(videoId) : null;
    if (!kb) return res.json({ has_kb: false, characters: [] });

    const cursorTime = normalizeTime(t);
    const episode = resolveEpisode(kb);
    const showId = kb.show_id || 'house-of-the-dragon';
    const all = charactersLib.loadRoleplayProfiles(showId);
    const profiles = (all && all.profiles) || {};
    const db = getCharacterDb(showId);
    const cursor = charactersLib.cursorAtTime(kb, cursorTime);

    // HotD KB 里 scene 切得极细（多数 2-3s）。挑"当前叙事节拍"用两层窗口：
    //  · 严格当前场景（who's on this exact frame）—— 优先权重高
    //  · ±20s 邻近场景的并集 —— 覆盖一段持续对白 / 一个房间内的人
    const NEAR_S = 20;
    const nearbyScenes = kb.scenes.filter(s =>
      s.end_time >= cursorTime - NEAR_S && s.start_time <= cursorTime + NEAR_S
    );
    const idsNear = Array.from(new Set(
      nearbyScenes.flatMap(s =>
        Array.isArray(s.characters_on_screen) && s.characters_on_screen.length
          ? s.characters_on_screen.map(c => c.character_id || c.id).filter(Boolean)
          : (s.characters || []).map(c => c.id).filter(Boolean)
      )
    ));
    const scene = currentScene(kb, cursorTime);
    const idsExact = scene
      ? (Array.isArray(scene.characters_on_screen) && scene.characters_on_screen.length
          ? scene.characters_on_screen.map(c => c.character_id || c.id).filter(Boolean)
          : (scene.characters || []).map(c => c.id).filter(Boolean))
      : [];
    const exactSet = new Set(idsExact);

    // 脸识别有时会漏掉躺着 / 闭眼 / 背身的人（典型例：韦赛里斯躺在床上 → 视觉模型只识到 daemon+otto）。
    // 兜底：扫 plot.fact + plot.reading，把出现的角色名也算"在场"，否则 chooser 会和 scene_beat 自相矛盾。
    const givenNameOf = (id) => {
      const card = db ? charactersLib.findCharacter(db, id) : null;
      const dn = card?.display_name_zh || '';
      if (!dn) return null;
      // "韦赛里斯一世·坦格利安" → 取 "·" 前；再去掉 "一世/二世" 等数字后缀
      return dn.split('·')[0].replace(/[一二三四五六七八九十]+世$/, '') || null;
    };
    const profileIds = Object.keys(profiles);
    const mentionedNear = new Set();
    const mentionedExact = new Set();
    for (const s of nearbyScenes) {
      const txt = `${s.plot?.fact || ''} ${s.plot?.reading || ''}`;
      if (!txt.trim()) continue;
      for (const id of profileIds) {
        const name = givenNameOf(id);
        if (name && txt.includes(name)) mentionedNear.add(id);
      }
    }
    if (scene) {
      const txt = `${scene.plot?.fact || ''} ${scene.plot?.reading || ''}`;
      for (const id of profileIds) {
        const name = givenNameOf(id);
        if (name && txt.includes(name)) mentionedExact.add(id);
      }
    }

    const idsAll = Array.from(new Set([...idsNear, ...mentionedNear]));

    const out = [];
    for (const id of idsAll) {
      const profile = profiles[id];
      if (!profile) continue;
      // 当前 episode 必须有 boundary，否则放走会剧透
      if (!profile.info_boundary_per_episode || !profile.info_boundary_per_episode[episode]) continue;
      const card = db ? charactersLib.lookupCharacter(db, id, cursor) : null;
      out.push({
        character_id: id,
        display_name: card?.display_name || id,
        short_identity: card?.short_identity || null,
        core_traits: profile.core_traits_zh || [],
        in_frame: exactSet.has(id) || mentionedExact.has(id),
      });
    }
    // 此刻就在画面里的角色排前面
    out.sort((a, b) => Number(b.in_frame) - Number(a.in_frame));

    // scene_beat：让前端看到"当前钻进的是哪个节拍"，确认实时跟着剧走
    // 现在两层：fact（画面里发生了什么）+ reading（这一刻的潜台词）
    const sceneBeat = scene ? {
      scene_id: scene.scene_id,
      start_time: scene.start_time,
      end_time: scene.end_time,
      fact: scene.plot?.fact || null,
      reading: scene.plot?.reading || null,
    } : null;

    res.json({
      has_kb: true,
      episode,
      scene_id: scene?.scene_id || null,
      scene_beat: sceneBeat,
      characters: out,
    });
  });

  // POST /api/agent/character/inner/starter
  // body: { videoId, characterId, t }
  // 进入角色那一刻：先一段 4-6 行的第一人称内心独白把情绪铺出来，再给 3 个
  // 立场化的开场问题。返回 { monologue, questions }，前端按 DE "[内心独白] +
  // 3 个 > 选项" 的样式呈现。缓存键 = characterId|scene_id|episode。
  const _starterCache = new Map();
  app.post('/api/agent/character/inner/starter', async (req, res) => {
    // SSE 流式：表层 / 深层一边出一边写出来（打字机感），选项在 done 事件
    // 一次性给前端，不打字。
    const FALLBACK_QS = [
      { text: '你此刻在想什么？', stance: '血亲' },
      { text: '为什么不直说？',     stance: '王者' },
      { text: '你怕的是什么？',     stance: '审慎' },
    ];

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const parseMonologue = (raw) => {
      const surfaceMatch = raw.match(/\[表层\]\s*([\s\S]*?)(?=\n\s*\[深层\]|\n\s*1[\.、]|$)/);
      const depthMatch = raw.match(/\[深层\]\s*([\s\S]*?)(?=\n\s*1[\.、]|$)/);
      return {
        surface: surfaceMatch ? surfaceMatch[1].trim() : '',
        depth: depthMatch ? depthMatch[1].trim() : '',
      };
    };
    const parseQuestions = (raw) => {
      const stanceRe = new RegExp(`\\[(${STANCE_PALETTE.join('|')})\\]`);
      const qLines = raw.split('\n').filter(l => /^\s*[1-3][\.、]/.test(l));
      return qLines.map(line => {
        const stripped = line.replace(/^\s*[1-3][\.、:：\s]+/, '').trim();
        const m = stripped.match(stanceRe);
        const stance = m ? m[1] : null;
        const text = stripped.replace(stanceRe, '').replace(/^[\s\-:：]+/, '').trim();
        return text ? { text, stance } : null;
      }).filter(Boolean).slice(0, 3);
    };

    try {
      const { videoId, characterId } = req.body || {};
      const kb = videoId ? loadKB(videoId) : null;
      if (!kb) {
        send('done', { surface: '', depth: '', questions: [] });
        return res.end();
      }
      const showId = kb.show_id || 'house-of-the-dragon';
      const episode = resolveEpisode(kb);
      const profile = charactersLib.lookupRoleplayProfile(showId, characterId, episode);
      if (!profile) {
        send('done', { surface: '', depth: '', questions: [] });
        return res.end();
      }

      const cursorTime = normalizeTime(req.body?.t);
      const scene = currentScene(kb, cursorTime);
      // v5: 同框人加上文本兜底（脸识别漏检的躺床/闭眼角色也算在场）
      const cacheKey = `${characterId}|${scene?.scene_id || 'no-scene'}|${episode}|v5`;

      // 缓存命中：把缓存的 raw 一次性 emit + done。前端依然能跑打字机。
      if (_starterCache.has(cacheKey)) {
        const cached = _starterCache.get(cacheKey);
        const fakeRaw = `[表层]\n${cached.surface}\n\n[深层]\n${cached.depth}\n\n` +
          (cached.questions || []).map((q, i) => `${i+1}. [${q.stance || ''}] ${q.text}`).join('\n');
        send('text', { delta: fakeRaw });
        send('done', { ...cached, cached: true });
        return res.end();
      }

      if (!ai.isAvailable('dialogue')) {
        send('done', { surface: '', depth: '', questions: FALLBACK_QS, fallback: true });
        return res.end();
      }

      // 上下文：当前画面发生 + 同框人 + 最近 30s SRT
      const fmtTs = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
      const currentFact = scene?.plot?.fact || '（画面里没有特别明显的事。）';
      const currentReading = scene?.plot?.reading || '';
      const onScreen = scene
        ? (Array.isArray(scene.characters_on_screen) && scene.characters_on_screen.length
            ? scene.characters_on_screen.map(c => c.character_id || c.id)
            : (scene.characters || []).map(c => c.id))
        : [];
      // 文本兜底：脸识别漏的角色（躺床 / 闭眼 / 背身）也算在场
      const allProfileIds = Object.keys((charactersLib.loadRoleplayProfiles(showId) || {}).profiles || {});
      const dbForMentions = getCharacterDb(showId);
      const mentionedIds = mentionedCharIdsInScene(scene, allProfileIds, dbForMentions);
      const onScreenAll = Array.from(new Set([...onScreen, ...mentionedIds])).filter(Boolean);
      const onScreenStr = onScreenAll.join('、') || '（独自一人）';
      const cues = srtWindow(videoId, cursorTime, 30, 0);
      const subtitleBlock = cues.length
        ? cues.slice(-6).map(c => `${fmtTs(c.start)} | ${c.text}`).join('\n')
        : '（这段画面没有明显对白。）';

      const boundary = profile._episode_boundary || {};
      const knowsLast = (boundary.knows || []).slice(-4).join('；');
      const doesNotKnow = (boundary.does_not_know || []).join('；');
      const traits = (profile.core_traits_zh || []).slice(0, 4).join('、');
      const speech = profile.speech_pattern_zh || '';
      const samples = (profile.sample_quotes_zh || []).slice(0, 3).map(q => `「${q}」`).join(' ');

      const system = `你正在为 HBO《龙之家族》观众生成"角色内心入口"。
观众即将"钻进"一个角色的脑子和 TA 对话。在他们开口之前，你要做两件事：

${STYLE_GUIDE_INNER}

═══ 第一件事：写两段第三人称过去时的内心独白 ═══

按 POV 章节的写法生成两段，但要**简洁**——这是片头节奏，不是长章。

[表层] 100-150 字（中文计），第三人称过去时。
角色此刻看到 / 听到 / 触摸到的具体感官细节做开头（丝绸、烛光、雨、铁器、酒…）。
角色在给自己找理由 / 自我说服。两到三个复合长句，用破折号 / 分号衔接从句。
必须是马丁笔触，参考上面 STYLE_GUIDE_INNER 的范例。**绝不短句排比**。

[深层] 100-150 字（中文计），第三人称过去时，可切到第二人称反问。
角色不愿正视的那部分浮上来，把表层的理由拆穿。
"可是另一个声音一直在问她……"、"如果……今天的理由还能成立吗"——
两到三个复合长句，篇幅和表层相当。

两段加起来必须：
- 围绕此刻这一段戏（画面正在发生 / 刚听到的台词）
- 至少 2 个具体感官锚点
- 表层 vs 深层有真正的张力
- 不剧透（只能用 TA 已知的）
- 命中"严禁用词"或"短句堆砌"= 整段报废

═══ 第二件事：3 个观众最可能问 TA 的问题（立场化）═══

立场词典（每个问题选一个，三个立场必须不同）：
${STANCE_PALETTE.map(s => `· [${s}] = ${STANCE_HINT[s]}`).join('\n')}

每个问题中文，不超过 14 字。顺着深层往痛处扎。

═══ 输出格式（极严）═══

[表层]
（一段 100-150 字长句叙事）

[深层]
（一段 100-150 字长句叙事）

1. [立场] 问题
2. [立场] 问题
3. [立场] 问题

立场只能用 ${STANCE_PALETTE.join(' / ')}。不要解释。不要 markdown。不要前后缀。`;

      const user = `角色：${profile.voice_zh ? profile.voice_zh.split('。')[0] : characterId}
气质：${traits}
说话方式：${speech}
TA 平时说话的腔调（参考节奏）：${samples}

═══ 此刻画面 ═══
${currentFact}
${currentReading ? '潜台词：' + currentReading : ''}

═══ 同框的人 ═══
${onScreenStr}

═══ 最近 30 秒画面里的台词原话 ═══
${subtitleBlock}

═══ TA 此刻已知（截至本时间点）═══
${knowsLast || '（无）'}

═══ TA 还不知道的事（绝对不能在独白里提到）═══
${doesNotKnow || '（无）'}

请按格式输出 [表层] + [深层] + 3 个立场化问题。`;

      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });

      const stream = ai.chatStream({
        task: 'dialogue',
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 700, // 两段 ~120 字 + 3 个问题
        temperature: 0.85,
        signal: controller.signal,
      });

      let raw = '';
      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.delta) {
          raw += chunk.delta;
          send('text', { delta: chunk.delta });
        }
      }

      const mono = parseMonologue(raw);
      const questions = parseQuestions(raw);
      const finalPayload = {
        surface: mono.surface || '',
        depth: mono.depth || '',
        questions: questions.length === 3 ? questions : FALLBACK_QS,
      };
      _starterCache.set(cacheKey, finalPayload);
      send('done', finalPayload);
      res.end();
    } catch (err) {
      console.error('[character/inner/starter] error:', err.message);
      try {
        send('done', {
          surface: '',
          depth: '',
          questions: FALLBACK_QS,
          fallback: true,
          error: err.message,
        });
      } catch { /* response already closed */ }
      try { res.end(); } catch {}
    }
  });

  // POST /api/agent/character/inner/stream
  // body: { videoId, characterId, t, message, history: [{role, text}, ...] }
  // 输出 SSE：text 增量 + done。LLM 严格按下面格式产出，前端解析。
  app.post('/api/agent/character/inner/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const { videoId, characterId, message, history } = req.body || {};
    const kb = videoId ? loadKB(videoId) : null;
    if (!kb) {
      send('text', { delta: '当前视频还没有载入剧情数据。' });
      send('done', { source: 'error' });
      return res.end();
    }
    const showId = kb.show_id || 'house-of-the-dragon';
    const episode = resolveEpisode(kb);
    const profile = charactersLib.lookupRoleplayProfile(showId, characterId, episode);
    if (!profile) {
      send('text', { delta: '这个角色暂时还没有可进入的内心档案。' });
      send('done', { source: 'error' });
      return res.end();
    }
    const userMsg = String(message || '').trim().slice(0, 600);
    if (!userMsg) {
      send('text', { delta: '需要先问点什么。' });
      send('done', { source: 'error' });
      return res.end();
    }
    const topicGuard = guardDialogueTopic(userMsg, {
      dynamicTerms: dialogueTopicTerms(kb, req.body?.t, [
        characterId,
        profile.display_name,
        profile.display_name_zh,
        profile.canonical_name,
      ]),
    });
    if (!topicGuard.ok) {
      send('text', { delta: topicGuard.message });
      send('done', { source: 'topic_guard', reason: topicGuard.reason });
      return res.end();
    }
    if (!ai.isAvailable('dialogue')) {
      send('text', { delta: '当前没有可用的对谈 LLM provider。' });
      send('done', { source: 'error' });
      return res.end();
    }

    const cursorTime = normalizeTime(req.body?.t);
    const scene = currentScene(kb, cursorTime);

    // ─── 实时场景上下文：当前节拍 + 前 3 场 + ~30s 字幕 ───
    const fmtTs = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const priorScenes = kb.scenes
      .filter(s => s.start_time <= cursorTime && s.scene_id !== scene?.scene_id)
      .slice(-3);
    const priorBeats = priorScenes
      .map(s => `· ${fmtTs(s.start_time)} ${s.plot?.fact || s.label_zh || s.label || '（场景）'}`)
      .join('\n');
    const currentFact = scene?.plot?.fact || null;
    const currentReading = scene?.plot?.reading || null;
    const onScreen = scene
      ? (Array.isArray(scene.characters_on_screen) && scene.characters_on_screen.length
          ? scene.characters_on_screen.map(c => c.character_id || c.id)
          : (scene.characters || []).map(c => c.id))
      : [];
    // 文本兜底：脸识别漏的角色（躺床 / 闭眼 / 背身）也算在场
    const allProfileIds = Object.keys((charactersLib.loadRoleplayProfiles(showId) || {}).profiles || {});
    const dbForMentions = getCharacterDb(showId);
    const mentionedIds = mentionedCharIdsInScene(scene, allProfileIds, dbForMentions);
    const onScreenList = Array.from(new Set([...onScreen, ...mentionedIds])).filter(Boolean);
    // 当前 character 在场景里 KB 标注的情绪 / 动机变化（如果有）
    const meInScene = (scene?.characters || []).find(c => c.id === characterId) || null;
    const myEmotion = meInScene?.emotion || null;
    const myMotShift = meInScene?.motivation_shift || null;

    // 字幕窗：只取 [t-30, t] 区间，避免暴露后续台词
    const cues = srtWindow(videoId, cursorTime, 30, 0);
    const subtitleBlock = cues.length
      ? cues.map(c => `${fmtTs(c.start)} | ${c.text}`).join('\n')
      : '（这一段画面没有可见对白。）';

    // 角色 vs 当前在场其他角色的关系切片（KB 里 key_relationships_zh 只列已知，过滤一下）
    const relsAll = profile.key_relationships_zh || {};
    const relsHere = onScreenList
      .filter(id => id !== characterId && relsAll[id])
      .map(id => `· ${id}：${relsAll[id]}`)
      .join('\n');

    const boundary = profile._episode_boundary || {};
    const knows = (boundary.knows || []).map(s => `· ${s}`).join('\n');
    const doesNotKnow = (boundary.does_not_know || []).map(s => `· ${s}`).join('\n');
    const traits = (profile.core_traits_zh || []).join('、');
    const speech = profile.speech_pattern_zh || '';
    const voice = profile.voice_zh || '';
    const samples = (profile.sample_quotes_zh || []).map(q => `「${q}」`).join('\n');
    const relsAllStr = Object.entries(relsAll)
      .map(([k, v]) => `· ${k}：${v}`)
      .join('\n');

    // 龙之家族 4 类内在声音 + 立场调色板
    const voiceList = voicesFor(characterId);
    const voiceListStr = voiceList.map(v =>
      `· [${v.name}] · ${VOICE_CATEGORY[v.cat].label}（${VOICE_CATEGORY[v.cat].tagline}）—— ${v.hint}`
    ).join('\n');
    const voiceNames = voiceList.map(v => v.name).join(' / ');
    const stanceListStr = STANCE_PALETTE.map(s => `· [${s}] = ${STANCE_HINT[s]}`).join('\n');
    // 把 categories 都列出来给 LLM 看
    const catLegend = Object.entries(VOICE_CATEGORY)
      .map(([_, c]) => `· ${c.label}（${c.tagline}）`).join('\n');

    const system = `${voice}

你不是 AI 旁观者，你就是这个角色本人。用第一人称回答和你说话的那个人，像在对一个只有你能看见的同伴吐露心事。

═══ 你这个人（人物画像，不会变）═══
气质：${traits}
说话方式：${speech}

你与身边人的关系（你心里的版本）：
${relsAllStr || '（没有特别要紧的人。）'}

你常说话的腔调（参考节奏，不要照搬这些原句）：
${samples || '（无）'}

═══ 此刻你正在经历的（画面正在播放）═══
${currentFact ? `画面里正在发生：${currentFact}` : '（KB 没标注此刻的具体动作，按下面字幕和你之前的处境推断。）'}
${currentReading ? `这一刻的潜台词：${currentReading}` : ''}
${onScreenList.length ? `此刻和你同框的人：${onScreenList.join('、')}` : ''}
${myEmotion ? `你此刻的情绪（KB 标注）：${myEmotion}` : ''}
${myMotShift ? `你此刻的动机变化：${myMotShift}` : ''}
${relsHere ? `你和此刻同框的人，关系是：\n${relsHere}` : ''}

═══ 你刚听到 / 说过的台词（最近 30 秒，按时间顺序，原始口语）═══
${subtitleBlock}

⚠ 上面这段是真实在画面里发生的对白。你的回答要和这个氛围相称 ——
如果你刚刚被某句话刺到，你的回答里不能没有那一刺；如果场上正一片沉默，
你的回答也要带那种压抑感。绝不能像是在另一个房间里凭空发言。

═══ 在这之前发生的事（最近 3 个节拍）═══
${priorBeats || '（这一集才刚开始。）'}

═══ 当前你只知道这些（截至本集本时间点）═══
${knows || '（没有特别记忆。）'}

═══ 这些事你还不知道（绝对不能提到，提了即剧透）═══
${doesNotKnow || '（无明显信息黑区。）'}

剧透红线：以上"还不知道"里的任何事都视作未发生。被问到未来时，你只能说"我不知道"、"我不敢想"、"还没到那一步"，或者把话题拉回当下你正在面对的事。

═══ 语气一致性（重要）═══
- 你说话必须像剧里这个人会说的样子，不像另一个人借你的嘴。
- 用上面"说话方式"和"常说话的腔调"里的句式 / 节奏 / 文白程度。
- 不要解释自己的身份。不要总结自己。一句顶一句地说。

${STYLE_GUIDE_INNER}

═══ 你这个人脑子里的几个声音 ═══

你不是一个声音，你是好几个声音在吵架。每个声音都属于下面 4 个色系之一：

${catLegend}

你这个角色身上 3 个具名声音：
${voiceListStr}

═══ 关键规则：声音必须吵架 ═══

每次回答，必须开**两个不同色系**的声音。（不能两个都是蓝色 / 两个都是红色。）
两个声音在同一段对话里直接对立——蓝色在权衡时紫色就在搅动，红色在
冲动时蓝色就在拉缰。两种颜色的色块同时说话，让用户在它们之间选择立场。

每个声音说出来的话也要按 STYLE_GUIDE_INNER 的笔触：第三人称过去时、
长句缠绕、有感官锚点。声音不是吐金句，声音是在脑子里絮叨、犹豫、
跟自己吵。

═══ 输出格式（极严，按下面顺序，每块独占一行）═══

[说] 角色真正会对对方说出口的话。第一人称，可带引号。一两句，必须和此刻
   场景的情绪相称。

[VOICE_A] 第一个内心声音。一段长句叙事（60-150 字），第三人称过去时，
   絮叨里带感官锚点。从上面 3 个具名声音里选一个。

[VOICE_B] 第二个内心声音，必须和 VOICE_A 不同色系。一段长句叙事
   （60-150 字），跟 VOICE_A 形成真正的张力（拆穿、反对、补一刀）。

[潜] 可选。一句长一点的话点出 VOICE_A 和 VOICE_B 共同回避的那个根源。
   没有可挖的时候省略整行。

接下来 3 个对方可能跟问的问题：

立场词典：
${stanceListStr}

格式：
1. [立场] 问题（不超过 14 字）
2. [立场] 问题（不同立场）
3. [立场] 问题（再不同立场）

═══ 绝对不要写 ═══
- 任何 markdown / 代码框 / 解释自己在做什么
- "作为 XX 我会说"、"我是一个虚构角色"、"陛下" 这种把对方当宫里人的措辞 —— 对方是观众
- 内心声音用了 ${voiceNames} 之外的名字
- 两个声音都用了同一个色系
- 立场用了 ${STANCE_PALETTE.join(' / ')} 之外的词
- 检定标签 [困难:成功] —— 已废弃，绝不要写
- 任何标签之外的多余前后缀
- 短句金句感（参考 STYLE_GUIDE_INNER 范例长句结构）

═══ 例（仅示意结构，不要照抄字句）═══
[说] "这话我现在不能答你。"

[${voiceList[0].name}] 她抓住了诺言的边——那是父亲临走前在烛光下用半句话
钉在她心里的最后一颗钉子，她一直告诉自己这就是她今天还能站住的全部，
不是因为她相信，而是因为她不敢去想"如果不是的话"会怎样。

[${voiceList[1].name}] 可是她记得很清楚，她不是天生就会装哑的人，那一年
在神木林里她还会笑出声，还会信誓言，还会以为风也是好的——那个版本的她
是什么时候让位给了这个站在镜子前的女人？

[潜] 她从来没被允许只为她自己活过——这话她从未对任何人说出口，连对自己也没有。

1. [王者] 你怕的是谁？
2. [血亲] 那如果没有他们呢？
3. [审慎] 你愿意把这命换出去吗？`;

    const messages = [];
    for (const turn of (Array.isArray(history) ? history : []).slice(-8)) {
      if (!turn || typeof turn.text !== 'string' || !turn.text.trim()) continue;
      const role = turn.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: turn.text.slice(0, 800) });
    }
    messages.push({ role: 'user', content: userMsg });

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      let providerInfo = null;
      const stream = ai.chatStream({
        task: 'dialogue',
        system,
        messages,
        maxTokens: 1100, // 两段长句 voice + 跟问，给足
        temperature: 0.85,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'meta') { providerInfo = { provider: chunk.provider, model: chunk.model }; continue; }
        if (chunk.type === 'text' && chunk.delta) send('text', { delta: chunk.delta });
      }
      send('done', {
        source: 'llm',
        episode,
        character_id: characterId,
        provider: providerInfo?.provider || null,
        model: providerInfo?.model || null,
      });
      res.end();
    } catch (err) {
      if (controller.signal.aborted) return res.end();
      console.error('[character/inner] error:', err.message);
      send('text', { delta: '回应失败：' + err.message });
      send('done', { source: 'error' });
      res.end();
    }
  });

  // 列出当前 KB 在当前 episode 下，哪些角色支持 roleplay 对谈。
  // 前端用它在 bbox 热点上加「💬 可对谈」标识。
  // 传 t（秒）时还会标注 in_scene：当前光标 ±30s 窗口内出场过的角色。
  app.get('/api/agent/scene/symbols', (req, res) => {
    const { videoId, t } = req.query;
    const kb = loadKB(videoId);
    if (!kb) return res.json({ has_kb: false });

    const cursorTime = normalizeTime(t);
    const scene = currentScene(kb, cursorTime);
    if (!scene) return res.json({ has_kb: true, scene_id: null, symbols: [] });

    // 加载符号词典（meaning_zh / viewer_takeaway / category）
    const showId = kb.show_id || 'house-of-the-dragon';
    const symPath = path.join(KB_DIR, 'symbols', `${showId}.json`);
    let symMap = {};
    if (fs.existsSync(symPath)) {
      try {
        const d = JSON.parse(fs.readFileSync(symPath, 'utf8'));
        for (const s of (d.symbols || [])) symMap[s.symbol_id] = s;
      } catch (e) { /* ignore */ }
    }

    // 优先用 scene-level 字段（agent 写入的、贴当前 scene 的解读），回落到词典
    const enriched = (scene.symbols || []).map(sym => {
      const dict = symMap[sym.symbol_id] || {};
      return {
        symbol_id: sym.symbol_id,
        bbox: sym.bbox === undefined ? null : sym.bbox,
        confidence: sym.confidence,
        evidence_in_frame: sym.evidence_in_frame,
        category: sym.category || dict.category || null,
        meaning_zh: sym.meaning_zh || dict.meaning_zh || null,
        viewer_takeaway: sym.viewer_takeaway || dict.viewer_takeaway || null,
        selection_basis: sym.selection_basis || null,
        expressive_function: sym.expressive_function || null,
        // 单符号自带的 deep_reading（agent 生成的）；前端会优先用它，回落到 scene.plot.deep_reading
        deep_reading: sym.deep_reading || null,
        source: sym.source || null,
        // CTA：跨栏跳转/回看的引导（迁移自旧 SceneHotspots）
        cta: sym.cta || null,
      };
    });

    res.json({
      has_kb: true,
      scene_id: scene.scene_id,
      scene_start: scene.start_time,
      scene_end: scene.end_time,
      symbols: enriched,
      deep_reading: scene.plot?.deep_reading || null,
      directing: scene.directing || null,
    });
  });

  // 列出整集所有 symbol 出现位置——给"本集符号"汇总 tab 用。
  // 每个 (scene, symbol) pair 返回一行，按 scene_start 升序。
  app.get('/api/agent/episode/symbols', (req, res) => {
    const { videoId } = req.query;
    const kb = loadKB(videoId);
    if (!kb) return res.json({ has_kb: false });

    const showId = kb.show_id || 'house-of-the-dragon';
    const symPath = path.join(KB_DIR, 'symbols', `${showId}.json`);
    let symMap = {};
    if (fs.existsSync(symPath)) {
      try {
        const d = JSON.parse(fs.readFileSync(symPath, 'utf8'));
        for (const s of (d.symbols || [])) symMap[s.symbol_id] = s;
      } catch (e) { /* ignore */ }
    }

    // 按 symbol_id 去重：同一符号会在连续 scene 里反复被标（如 laenor_agreement
    // 在潮汐堡谈判那段 17:59/18:17/18:54 三处都挂了），列表里展示成 3 条
    // 一模一样文字+不同时间戳没有信息量。只保留首次出现的时刻，附带 occurrences
    // 计数让前端可以选择性显示"× N 处"。SymbolHotspots overlay 不走这个端点，
    // 视频上的角标依然每个 scene 各显示一次，没有影响。
    const byId = new Map();
    for (const scene of (kb.scenes || [])) {
      for (const sym of (scene.symbols || [])) {
        const existing = byId.get(sym.symbol_id);
        if (existing) {
          existing.occurrences += 1;
          existing.last_scene_start = scene.start_time;
          continue;
        }
        const dict = symMap[sym.symbol_id] || {};
        byId.set(sym.symbol_id, {
          symbol_id: sym.symbol_id,
          scene_id: scene.scene_id,
          scene_start: scene.start_time,
          scene_end: scene.end_time,
          last_scene_start: scene.start_time,
          occurrences: 1,
          keyframe: scene.keyframe || null,
          category: sym.category || dict.category || null,
          meaning_zh: sym.meaning_zh || dict.meaning_zh || null,
          viewer_takeaway: sym.viewer_takeaway || dict.viewer_takeaway || null,
          selection_basis: sym.selection_basis || null,
          expressive_function: sym.expressive_function || null,
          deep_reading: sym.deep_reading || null,
          evidence_in_frame: sym.evidence_in_frame || null,
          confidence: sym.confidence || null,
          cta: sym.cta || null,
        });
      }
    }
    const items = Array.from(byId.values()).sort((a, b) => a.scene_start - b.scene_start);
    res.json({ has_kb: true, items });
  });

  // ─── Hotspot generation (scene-analyst agent) ─────────────────────
  // 用户在前端给某 scene 加一个剧情符号热点：可以从词典挑 symbol_id，或只给一句模糊
  // 描述（hint），agent 会用 ToolBox 查证后写出完整的 symbol entry（evidence/meaning/...）。
  //
  // POST /api/agent/scene/hotspot/generate
  //   body: { videoId, t (秒), symbol_id?, hint?, bbox?, cursor? }
  //   resp: { ok, hotspot, scene_id, tool_call_log, usage } —— 仅预览，不写盘
  //
  // POST /api/agent/scene/hotspot/save
  //   body: { videoId, scene_id, hotspot:{symbol_id,evidence_in_frame,meaning_zh,...}, bbox? }
  //   resp: { ok, scene_id, written, total_symbols }
  //   逻辑：
  //     - 若 scene.symbols[] 已含 symbol_id → 替换该条
  //     - 否则追加，含 source:'user_agent' 与 generated_at
  app.post('/api/agent/scene/hotspot/generate', async (req, res) => {
    try {
      const { videoId, t, symbol_id, hint, bbox, cursor } = req.body || {};
      if (!videoId) return res.status(400).json({ ok: false, error: 'videoId required' });
      if (!ai.isAvailable('agent_analysis')) {
        return res.status(503).json({ ok: false, error: 'agent_analysis 不可用（缺 OPENAI_API_KEY？）' });
      }
      const kb = loadKB(videoId);
      if (!kb) return res.status(404).json({ ok: false, error: 'KB not found' });
      const cursorTime = normalizeTime(t);
      const scene = currentScene(kb, cursorTime);
      if (!scene) return res.status(404).json({ ok: false, error: 'no scene at given time' });

      // 推断 episode cursor —— 用 KB 自带 episode_map 优先；否则回落 kb.episode；再否则 'S01E05'
      const episodeCursor = cursor || charactersLib.cursorAtTime(kb, cursorTime) || kb.episode || 'S01E05';

      const { ToolBox } = require('./lib/scene_analyst/tools');
      const { generateHotspot } = require('./lib/scene_analyst/hotspot_agent');
      const { box: toolBox } = ToolBox.fromVideo({ videoId, episodeCursor });

      const result = await generateHotspot({
        scene, kb, charDb: toolBox.charDb, toolBox, cursor: episodeCursor,
        userInput: { symbol_id: symbol_id || null, hint: hint || null, bbox: bbox || null },
      });

      if (!result.ok) {
        return res.status(500).json({
          ok: false, error: result.error,
          tool_call_log: (result.toolCalls || []).map(tc => `${tc.name}(${tc.ok ? 'ok' : 'err'})`),
        });
      }

      // 携带词典里的 category 一起返回——前端的 corner badge 选 icon 要用
      let category = null;
      const symPath = path.join(KB_DIR, 'symbols', `${kb.show_id || 'house-of-the-dragon'}.json`);
      if (fs.existsSync(symPath)) {
        try {
          const dict = JSON.parse(fs.readFileSync(symPath, 'utf8'));
          const hit = (dict.symbols || []).find(s => s.symbol_id === result.hotspot.symbol_id);
          if (hit) category = hit.category;
        } catch { /* swallow */ }
      }

      res.json({
        ok: true,
        scene_id: scene.scene_id,
        hotspot: { ...result.hotspot, category, bbox: bbox || null },
        tool_call_log: result.toolCalls.map(tc => `${tc.name}(${tc.ok ? 'ok' : 'err'})`),
        usage: result.usage,
        cursor: episodeCursor,
      });
    } catch (err) {
      console.error('[hotspot/generate]', err);
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post('/api/agent/scene/hotspot/save', (req, res) => {
    try {
      const { videoId, scene_id, hotspot, bbox } = req.body || {};
      if (!videoId || !scene_id || !hotspot?.symbol_id) {
        return res.status(400).json({ ok: false, error: 'videoId, scene_id, hotspot.symbol_id required' });
      }
      const kbPath = path.join(KB_DIR, `${videoId}.json`);
      if (!fs.existsSync(kbPath)) return res.status(404).json({ ok: false, error: 'KB not found' });
      const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
      const scene = (kb.scenes || []).find(s => s.scene_id === scene_id);
      if (!scene) return res.status(404).json({ ok: false, error: 'scene not found' });

      const entry = {
        symbol_id: hotspot.symbol_id,
        evidence_in_frame: hotspot.evidence_in_frame || null,
        confidence: hotspot.confidence || 'medium',
        bbox: bbox || hotspot.bbox || null,
        source: 'user_agent',
        generated_at: new Date().toISOString(),
      };
      // 单 scene 的 deep_reading 字段是 plot.deep_reading，不放在 symbol 里——
      // 但用户在前端可能希望专属于该 hotspot 的 meaning_zh / viewer_takeaway，所以也存
      if (hotspot.meaning_zh) entry.meaning_zh = hotspot.meaning_zh;
      if (hotspot.viewer_takeaway) entry.viewer_takeaway = hotspot.viewer_takeaway;
      if (hotspot.deep_reading) entry.deep_reading = hotspot.deep_reading;
      if (hotspot.selection_basis) entry.selection_basis = hotspot.selection_basis;
      if (hotspot.expressive_function) entry.expressive_function = hotspot.expressive_function;

      scene.symbols = scene.symbols || [];
      const existingIdx = scene.symbols.findIndex(s => s.symbol_id === entry.symbol_id);
      let action;
      if (existingIdx >= 0) {
        scene.symbols[existingIdx] = { ...scene.symbols[existingIdx], ...entry };
        action = 'replaced';
      } else {
        scene.symbols.push(entry);
        action = 'appended';
      }

      fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2));
      res.json({ ok: true, scene_id, action, total_symbols: scene.symbols.length, written: entry });
    } catch (err) {
      console.error('[hotspot/save]', err);
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get('/api/agent/kb', (req, res) => {
    const videos = fs.existsSync(KB_DIR)
      ? fs.readdirSync(KB_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
      : [];

    res.json({
      videos,
      llm_ready: ai.isAvailable('chat') || ai.isAvailable('vision_chat'),
      providers: ai.describe(),
    });
  });

  // ─── 立场推演 / Stance Speculation ─────────────────────────────────
  // POST /api/agent/stance/speculate
  // body: { videoId, triggerId, optionId }
  // 流式输出 3-5 段"如果走这条路"的剧本式推演，最后一段是 1-2 个开放式
  // 问句把球抛回给观众 —— 不替观众下结论，让他们自己往下想。
  // convergence_hint 当作张力暗流用，让问题踩在那个张力上而不是宣判它。
  app.post('/api/agent/stance/speculate', async (req, res) => {
    const { videoId, triggerId, optionId } = req.body || {};
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    if (!videoId || !triggerId || !optionId) {
      send('text', { delta: '缺少 videoId / triggerId / optionId。' });
      send('done', { source: 'error' });
      return res.end();
    }

    // 读 stance trigger 配置
    const stancePath = path.join(__dirname, 'kb', 'stance', `${videoId}.json`);
    let stanceCfg;
    try {
      stanceCfg = JSON.parse(fs.readFileSync(stancePath, 'utf8'));
    } catch (_) {
      send('text', { delta: '当前视频还没有立场触发点配置。' });
      send('done', { source: 'error' });
      return res.end();
    }

    const trigger = (stanceCfg.triggers || []).find(t => t.trigger_id === triggerId);
    if (!trigger) {
      send('text', { delta: '未找到该立场触发点。' });
      send('done', { source: 'error' });
      return res.end();
    }
    const option = (trigger.options || []).find(o => o.id === optionId);
    if (!option) {
      send('text', { delta: '未找到该选项。' });
      send('done', { source: 'error' });
      return res.end();
    }
    // 推演只对"与剧情不一样的选项"有效。canonical 选项（剧情在发生的）
    // 没必要展开 —— by_option 里没有它的 hint 就直接拦掉。
    if (!trigger.speculation?.by_option?.[optionId]) {
      send('text', { delta: '这个选项就是剧情在发生的事 —— 没有平行世界线可以推演。' });
      send('done', { source: 'canonical' });
      return res.end();
    }

    if (!ai.isAvailable('chat')) {
      send('text', { delta: '当前没有可用的 LLM provider，立场推演只能在配置后运行。' });
      send('done', { source: 'error' });
      return res.end();
    }

    const kb = loadKB(videoId);
    const showName = kb?.show_id === 'house-of-the-dragon' ? '《龙之家族》' : `《${kb?.title || videoId}》`;
    const episode = (kb && resolveEpisode(kb)) || '';
    const ts = trigger.timestamp;
    const tsLabel = `${Math.floor(ts / 60)}:${String(Math.floor(ts % 60)).padStart(2, '0')}`;

    const optionHint = trigger.speculation?.by_option?.[optionId] || '';
    const convergence = trigger.speculation?.convergence_hint || '';

    const system = `你是 HBO ${showName} 编剧组的成员。你的任务是为观众生成一段"立场推演" —— 假设观众替剧中人做了某个不同的选择，你写出"那个世界线"会怎么走，但不替观众讲完。

═══ 硬性原则 ═══
1. 严格遵循马丁的世界观、维斯特洛的政治逻辑、家族纹章与阵营、坦格利安王朝的内部矛盾。
2. 角色行为必须符合人格：戴蒙不会突然温柔、阿丽森不会突然真诚、克里斯顿压抑后会爆发。
3. **不下结论、不收束。**不要总结"为什么原剧没走这条路"、不要说"最终也会走到同一个结局"。让张力悬在那儿。
4. **结尾是开放的。**最后一段不是叙述，是 1-2 个开放式问句，直接抛给观众，让他们自己往下想。问句要扎在角色心理的真实矛盾上，最好踩在 convergence 暗示的张力上 —— 但是用"问"，不是用"答"。
5. 不要写"作为编剧"、不要做免责声明、不要解释自己在做什么。直接进入第一段场景。
6. 不剧透原剧后续真实剧情。
7. 用第二人称"你"指向观众做选择的那个剧中人（"你回到房间……"），让观众在场。

═══ 输出格式（极严，按 [标签] 分段，模仿《极乐迪斯科》多声部叙事）═══

把推演拆成 5-7 个**短**段落。每段独占一行，**段首必须带方括号标签**，段之间用空行分隔。
四种标签必须穿插（不要连续 3 段同一种）：

[事实] —— 这条世界线里这一刻发生了什么。客观叙事，第二人称"你..."。50-90 字。
[解读] —— 角色此刻心里在想什么 / 决定背后的逻辑。50-90 字。
[推测] —— 这个选择会引向什么 / 后续连锁反应（未来几集 / 几年）。50-90 字。
[问]   —— **全文最多 2 段、最多 2 个问句**。每段只放一个开放式问句（30-60 字），扎在角色心理矛盾上。**只**这一种段允许直接以问号收尾。一段里堆 3-5 个问号即报废。

排布建议（参考，不强制）：
[事实] → [解读] → [事实] → [推测] → [问] → [问]
或：
[事实] → [推测] → [解读] → [推测] → [问]

═══ 严禁 ═══
- 任何 emoji 或符号前缀（💭 ⚠️ 🔀 ✦ ➜ → ← 等都不行）
- 段首没有 [标签]
- 段与段之间不空行
- 把"事实"、"解读"这种词写在段落正文里（这些词只许出现在 [方括号] 标签里）
- 一段超过 90 字 / 全文超过 380 字（中文计）
- **超过 2 个 [问] 段 / 全文超过 2 个问号** —— 这是硬上限，写第 3 个问号即报废`;

    const user = `【原剧位置】${episode} · ${tsLabel}
【场景】${trigger.scene_label}
【原剧情境】${(trigger.prompt_lines || []).join(' / ')}

【观众选了】${option.label}
【观众的内心理由】${option.inner_voice || ''}

${optionHint ? `【这条路的方向提示（编剧组内部参考，不要直抄）】${optionHint}` : ''}
${convergence ? `【这条路上的张力暗流（最后那 1-2 个问句要踩在这股力上，但是用"问"不是"答" —— 不要替观众讲出这个结论）】${convergence}` : ''}

请写"如果你的选择真的发生了"那个世界线。前面 4-5 段用 [事实]/[解读]/[推测] 穿插推演，结尾**最多** 2 段 [问]、**全文最多 2 个问号**。`;

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      let providerInfo = null;
      const stream = ai.chatStream({
        task: 'chat',
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 700,
        temperature: 0.8,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'meta') { providerInfo = { provider: chunk.provider, model: chunk.model }; continue; }
        if (chunk.type === 'text' && chunk.delta) send('text', { delta: chunk.delta });
      }
      send('done', {
        source: 'llm',
        trigger_id: triggerId,
        option_id: optionId,
        episode,
        provider: providerInfo?.provider || null,
        model: providerInfo?.model || null,
      });
      res.end();
    } catch (err) {
      if (controller.signal.aborted) return res.end();
      console.error('[stance/speculate] LLM error:', err?.message || err);
      send('text', { delta: `\n\n（推演中断：${err?.message || '未知错误'}）` });
      send('done', { source: 'error' });
      res.end();
    }
  });

  // ─── 立场推演 · 续推（用户对开放问句继续问下去）──────────────────
  // POST /api/agent/stance/speculate/continue
  // body: { videoId, triggerId, optionId, history: [{role, content}], question }
  // 已经跑过一轮 speculate，开放问句把球抛回观众；观众点了某个问句
  // 或自己写了一句，调这个端点继续延展同一条假设世界线。
  // 系统约束跟 /speculate 一致：留在 alt-world，不剧透原剧后续，第二人称对观众。
  // 输出：流式 2-3 段续写，结尾再抛 1-2 个新的开放问句把对话往下推。
  app.post('/api/agent/stance/speculate/continue', async (req, res) => {
    const { videoId, triggerId, optionId, history, question } = req.body || {};
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const userQ = String(question || '').trim().slice(0, 600);
    if (!videoId || !triggerId || !optionId || !userQ) {
      send('text', { delta: '缺少必要字段。' });
      send('done', { source: 'error' });
      return res.end();
    }

    const stancePath = path.join(__dirname, 'kb', 'stance', `${videoId}.json`);
    let stanceCfg;
    try { stanceCfg = JSON.parse(fs.readFileSync(stancePath, 'utf8')); }
    catch (_) {
      send('text', { delta: '当前视频没有立场配置。' });
      send('done', { source: 'error' });
      return res.end();
    }
    const trigger = (stanceCfg.triggers || []).find(t => t.trigger_id === triggerId);
    const option = trigger ? (trigger.options || []).find(o => o.id === optionId) : null;
    if (!trigger || !option) {
      send('text', { delta: '立场触发点 / 选项找不到。' });
      send('done', { source: 'error' });
      return res.end();
    }
    if (!ai.isAvailable('chat')) {
      send('text', { delta: '当前没有可用的 LLM provider。' });
      send('done', { source: 'error' });
      return res.end();
    }

    const kb = loadKB(videoId);
    const showName = kb?.show_id === 'house-of-the-dragon' ? '《龙之家族》' : `《${kb?.title || videoId}》`;
    const episode = (kb && resolveEpisode(kb)) || '';

    const optionHint = trigger.speculation?.by_option?.[optionId] || '';
    const convergence = trigger.speculation?.convergence_hint || '';
    const topicGuard = guardDialogueTopic(userQ, {
      dynamicTerms: dialogueTopicTerms(kb, trigger.timestamp, [
        trigger.scene_label,
        option.label,
        option.inner_voice,
        ...(trigger.prompt_lines || []),
        optionHint,
        convergence,
      ]),
    });
    if (!topicGuard.ok) {
      send('text', { delta: topicGuard.message });
      send('done', { source: 'topic_guard', reason: topicGuard.reason });
      return res.end();
    }

    const system = `你是 HBO ${showName} 编剧组的成员，正在和观众一起把一条"假设世界线"往下推。
观众已经替剧中人做了一个不同于原剧的选择，前面已经有过几段推演，现在观众有了新的追问。
你要做的是：**留在那条假设世界线里**，把它再往前推一小段，回答观众的问题，然后把球再抛回去。

═══ 硬性原则 ═══
1. 严格遵循马丁的世界观、维斯特洛的政治逻辑、家族纹章、坦格利安王朝的内部矛盾。
2. 角色行为必须符合人格：戴蒙不会突然温柔、阿丽森不会突然真诚、克里斯顿压抑后会爆发。
3. **不下结论、不收束、不替观众讲完。**留在假设世界线里继续往下推，不要切回原剧。
4. **不剧透原剧后续真实剧情。**你写的是"如果，那么"。
5. 用第二人称"你"指向观众做选择的那个剧中人（"你回到房间……"）。
6. 不要写"作为编剧"、不要做免责声明、不要解释自己在做什么。直接进入续写。

═══ 输出格式（严格） ═══
全文 2-3 段。
前面 1-2 段是叙事性的场景 + 心理描写，每段 50-90 字，平静克制语气，不堆华丽辞藻。
最后一段必须**另起一行**单独成段，是 1-2 个新的开放式问句（每问 25-50 字），扎在观众这次问的张力上，往下一层推。问句之间也用空行分隔。
**全文严禁出现任何 emoji 或符号前缀**（不要 💭 ⚠️ 🔀 ⏵ ✦ ➜ → ←）。
段与段之间统一用一个空行分隔。
全文严格控制在 280 字以内（中文计）。`;

    const initialUser = `【原剧位置】${episode}
【场景】${trigger.scene_label}
【观众选了】${option.label}（${option.inner_voice || ''}）
${optionHint ? `【这条路的方向（编剧组内部参考，不直抄）】${optionHint}` : ''}
${convergence ? `【这条路的张力暗流】${convergence}` : ''}

下面是和观众的对话历史。请按风格继续。`;

    // 把 history 截成最近 8 轮（避免 prompt 过长 / 还能保留主题感）
    const safeHist = Array.isArray(history) ? history.slice(-8) : [];
    const messages = [
      { role: 'user', content: initialUser },
      ...safeHist.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 1200),
      })),
      { role: 'user', content: userQ },
    ];

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      let providerInfo = null;
      const stream = ai.chatStream({
        task: 'chat',
        system,
        messages,
        maxTokens: 600,
        temperature: 0.85,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'meta') { providerInfo = { provider: chunk.provider, model: chunk.model }; continue; }
        if (chunk.type === 'text' && chunk.delta) send('text', { delta: chunk.delta });
      }
      send('done', {
        source: 'llm',
        trigger_id: triggerId,
        option_id: optionId,
        episode,
        provider: providerInfo?.provider || null,
        model: providerInfo?.model || null,
      });
      res.end();
    } catch (err) {
      if (controller.signal.aborted) return res.end();
      console.error('[stance/speculate/continue] LLM error:', err?.message || err);
      send('text', { delta: `\n\n（续推中断：${err?.message || '未知错误'}）` });
      send('done', { source: 'error' });
      res.end();
    }
  });

  // GET /api/agent/stance/speculate/eligibility?videoId=xxx
  // 返回这个视频里所有可推演的 trigger 及其 per-option 可推演 ID 列表。
  // 形如：{ video_id, eligibility: { trigger_id: [option_id, option_id], ... } }
  // 前端用来判断"用户投了 X 选项"之后是否要弹"展开推演"CTA。
  app.get('/api/agent/stance/speculate/eligibility', (req, res) => {
    const videoId = req.query.videoId;
    if (!videoId) return res.status(400).json({ error: 'videoId required' });
    const stancePath = path.join(__dirname, 'kb', 'stance', `${videoId}.json`);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(stancePath, 'utf8')); }
    catch { return res.json({ video_id: videoId, eligibility: {} }); }
    const eligibility = {};
    for (const t of (cfg.triggers || [])) {
      const byOpt = t.speculation?.by_option || {};
      const ids = Object.keys(byOpt);
      if (ids.length > 0) eligibility[t.trigger_id] = ids;
    }
    res.json({ video_id: videoId, eligibility });
  });

  // ─── 立场总结 / Stance Summary ────────────────────────────────────────
  // POST /api/agent/stance/summary
  // body: { videoId, choices:[{trigger_id, option_id, option_label, option_inner_voice,
  //                            scene_label, type, recorded_at}] }
  //
  // 流式输出一段"读你的立场轨迹"的第二人称叙述。
  //
  // **绝对红线（写进 prompt）**：不归类、不打 persona 标签、不说"你站 X 党 / 你是 X 类型"、
  // 不打分、不写阵营 banner。只写 issue-by-issue 你表达过什么位置 + 把每个断言挂回到具体场景。
  app.post('/api/agent/stance/summary', async (req, res) => {
    const { videoId, choices } = req.body || {};
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    if (!Array.isArray(choices) || choices.length === 0) {
      send('text', { delta: '还没有立场记录。' });
      send('done', { source: 'empty' });
      return res.end();
    }
    if (!videoId) {
      send('text', { delta: '缺少 videoId。' });
      send('done', { source: 'error' });
      return res.end();
    }
    if (!ai.isAvailable('chat')) {
      send('text', { delta: '当前没有可用的 LLM provider。' });
      send('done', { source: 'error' });
      return res.end();
    }

    // 读 stance 配置 → 给每条 choice 补 prompt_lines / convergence_hint / 其他选项的 inner_voice
    // 让 LLM 看到"你当时面对的张力是什么"，而不是只看到一行 label。
    const stancePath = path.join(__dirname, 'kb', 'stance', `${videoId}.json`);
    let stanceCfg = null;
    try { stanceCfg = JSON.parse(fs.readFileSync(stancePath, 'utf8')); } catch {}
    const triggerById = {};
    for (const t of (stanceCfg?.triggers || [])) triggerById[t.trigger_id] = t;

    const kb = loadKB(videoId);
    const showName = kb?.show_id === 'house-of-the-dragon' ? '《龙之家族》' : `《${kb?.title || videoId}》`;
    const episode = (kb && resolveEpisode(kb)) || '';

    // sort by trigger timestamp（如果有），否则按 recorded_at
    const enriched = choices
      .map(c => {
        const tg = triggerById[c.trigger_id] || null;
        return {
          choice: c,
          trigger: tg,
          ts: tg?.timestamp ?? Date.parse(c.recorded_at || 0) / 1000 ?? 0,
        };
      })
      .sort((a, b) => a.ts - b.ts);

    const fmtTs = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const blocks = enriched.map(({ choice, trigger, ts }, i) => {
      const others = (trigger?.options || [])
        .filter(o => o.id !== choice.option_id)
        .map(o => `· "${o.label}"（${o.inner_voice || '—'}）`)
        .join('\n');
      const isCanonical = !!(trigger?.options || []).find(o => o.id === choice.option_id)?.is_canonical;
      return `[${i + 1}] ${fmtTs(ts)} · ${choice.scene_label}${choice.type === 'recall' ? '（回顾打脸）' : ''}
情境：${(trigger?.prompt_lines || []).join(' / ') || '—'}
你选了："${choice.option_label}"${isCanonical ? '（剧情正在发生的方向）' : '（与剧情不一样的方向）'}
你的内心理由：${choice.option_inner_voice ? `"${choice.option_inner_voice}"` : '—'}
${others ? `当时其他可选：\n${others}` : ''}`;
    }).join('\n\n');

    const system = `你是 HBO ${showName} 的剧本顾问。任务：给观众**读一遍他的立场轨迹**。

═══ 红线（违反就是失败） ═══
1. 不归类。绝对不要写"你属于 X 党 / 你是 X 类型 / 你是审慎型 / 你倾向 Y 阵营"这种 persona 标签或党派 banner。
2. 不打分。不要"你 6/10 站绿党"、不要任何数字、不要 sparkline、不要排名。
3. 不评判。不要说"这是个明智的选择 / 这是个鲁莽的选择"。
4. 不预言用户。不要写"你将来会..."、不要替观众预测下一集他会怎么选。
5. 不剧透原剧后续真实剧情。

═══ 该写什么 ═══
按 issue（议题）维度组织，不要按时间线流水账。每个 issue 一段：
- 先用一句话指明这件事本身的张力（例：维斯特洛的政治婚姻里，私情有多少空间？）
- 再说在这件事上你做过的具体选择 —— 用 [N] 引用上面给的编号场景作为证据
- 同一议题如果你前后立场有变化（包括打脸 / recall），就明确指出转折点
- 如果你多次站到"与剧情不一样的方向"，可以指出你在抗某一种叙事重力

挑 3-4 个最有 substance 的议题来写，不是覆盖全部。

═══ 形式 ═══
全文 350-500 字。第二人称"你"，平静克制语气。
每个议题一段，段间空一行。
最后一段不是总结、不是定调，是 1 个**开放式问句**，把"如果再来一次你还会这样选吗"这层张力抛回给观众，不要替观众回答。
不要 markdown 标题、不要 emoji、不要 [N] 之外的标点装饰。`;

    const user = `【剧集】${episode}（${showName}）
【你做过的立场选择，按时间顺序】

${blocks}

请按上面的红线 + 形式约束，给我读一遍我的立场轨迹。`;

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      let providerInfo = null;
      const stream = ai.chatStream({
        task: 'chat',
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 1200,
        temperature: 0.7,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'meta') { providerInfo = { provider: chunk.provider, model: chunk.model }; continue; }
        if (chunk.type === 'text' && chunk.delta) send('text', { delta: chunk.delta });
      }
      send('done', {
        source: 'llm',
        episode,
        choice_count: choices.length,
        provider: providerInfo?.provider || null,
        model: providerInfo?.model || null,
      });
      res.end();
    } catch (err) {
      if (controller.signal.aborted) return res.end();
      console.error('[stance/summary] LLM error:', err?.message || err);
      send('text', { delta: `\n\n（总结中断：${err?.message || '未知错误'}）` });
      send('done', { source: 'error' });
      res.end();
    }
  });
}

module.exports = { register };
