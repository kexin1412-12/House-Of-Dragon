const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const charactersLib = require('./lib/characters');
const seasonLib = require('./lib/season');
const ai = require('./lib/ai');
const { retrieve: retrieveKnowledge } = require('./lib/retrieval');

const KB_DIR = path.join(__dirname, 'kb');

const UPLOADS_DIR = path.join(__dirname, 'uploads');

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

// 影视分析方法库 —— Agent 用这些 pattern 把视觉观察翻译成意义
const ANALYSIS_PATTERNS = [
  '身体压制（踩压/逼视/低角度仰视）→ 权力关系不对等或屈辱',
  '空镜或长留白 → 延长情绪余韵，让观众消化情感',
  '重复出现的物件/动作 → 伏笔，要留意',
  '镜头从背后拍 → 角色被动或信息被遮蔽',
  '景深虚化某人 → 暂时被移出叙事中心',
  '对称构图 → 权威、仪式或不可改变的命运',
  '暖光（金/橘）→ 亲密、权威、回忆；冷光（蓝/灰）→ 孤独、疏离、威胁',
  '突然的特写 → 强调真实情绪，常用在背叛/觉醒瞬间',
  '音乐主题变奏 → 角色或主题的转折',
  '逆光剪影 → 角色身份/动机暂被隐藏',
  '同一动作两人对照剪辑 → 暗示二人未来命运对照或对立',
];

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

// ─── 分支 cue 生成的辅助 ─────────────────────────────────────
// 内存缓存：同一个 branch_id 只让 LLM 写一次（演示时多次走到也用同一句）
const BRANCH_CUE_CACHE = new Map();

// 把 LLM 输出里可能的 ```json fence、外层文字剥掉，找到第一个 {…} 解析
function parseCueJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // 去 ```json fence
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  // 找第一个完整 JSON 对象
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (!obj || typeof obj.headline !== 'string' || typeof obj.sub !== 'string') return null;
    const headline = obj.headline.trim().slice(0, 40);
    const sub = obj.sub.trim().slice(0, 30);
    if (!headline || !sub) return null;
    return { headline, sub };
  } catch { return null; }
}

// 解析 perspective HUD 的 LLM JSON（容忍 ```json fence + 外层杂文）
// 在解析阶段强制 label 来自安全表，防止 LLM 自创 "眼前/盘算/隐忧" 这类古风标签。
function parsePerspectiveJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (!obj || !Array.isArray(obj.cards) || obj.cards.length < 1) return null;
    obj.cards = obj.cards.slice(0, 3).map((c, i) => {
      const rawLabel = String(c?.label || '').trim();
      // 不在安全表里 → 用位置默认（看到/判断/风险）替换
      const label = PERSPECTIVE_LABEL_SAFELIST.includes(rawLabel)
        ? rawLabel
        : (PERSPECTIVE_FALLBACK_LABELS[i] || '看到');
      return {
        label,
        text: String(c?.text || '').trim().slice(0, 30),
      };
    }).filter(c => c.text);
    if (obj.cards.length === 0) return null;
    if (obj.subtitle) obj.subtitle = String(obj.subtitle).trim().slice(0, 30);
    if (obj.pov_character) obj.pov_character = String(obj.pov_character).trim().slice(0, 24);
    return obj;
  } catch { return null; }
}

function defaultPerspectivePayload(displayName, subtitle) {
  return {
    pov_character: displayName,
    subtitle: subtitle || '',
    cards: [
      { label: '看到', text: '当前画面信息还不完整' },
      { label: '判断', text: 'TA 还不能确认对方意图' },
      { label: '风险', text: '这可能影响 TA 的位置' },
    ],
    actions: ['继续 TA 的视角', '回到正片'],
  };
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

// perspective HUD 卡片标签的安全表 —— LLM 只能从这 6 个里挑 3 个（按场景需要）
const PERSPECTIVE_LABEL_SAFELIST = ['看到', '判断', '风险', '立场', '关系', '代价'];
const PERSPECTIVE_FALLBACK_LABELS = ['看到', '判断', '风险'];

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

// 解析 roleplay intro 的 LLM JSON
function parseRoleplayIntroJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (!obj || typeof obj !== 'object') return null;
    const hero = String(obj.hero_line || '').trim();
    const sub = String(obj.sub_line || '').trim();
    const prompt = String(obj.prompt_line || '').trim();
    const qs = Array.isArray(obj.suggested_questions) ? obj.suggested_questions : [];
    if (!hero) return null;
    const cleanQs = qs
      .map(q => String(q || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    return {
      hero_line: hero.slice(0, 40),
      sub_line: sub.slice(0, 30),
      prompt_line: prompt.slice(0, 30),
      suggested_questions: cleanQs,
    };
  } catch { return null; }
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

// LLM 不可用 / 写挂了的时候用 —— 每个分支不一样，全部维斯特洛意象
function staticCueFallback(bp) {
  const idx = bp?.branch_id || '';
  const POOL = [
    { headline: '学士的鹅毛笔停在这一行上。', sub: '由你来填这格留白。' },
    { headline: '渡鸦还没飞出窗。', sub: '你愿换它去哪？' },
    { headline: '誓言已到唇边，未出口。', sub: '你愿替他说出口吗？' },
  ];
  let h = 0;
  for (const c of idx) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return POOL[h % POOL.length];
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
    foreshadow: /伏笔|细节|彩蛋|铺垫|暗示|留意|重要吗|有什么用/.test(q),
    emotion: /紧张|压抑|恐惧|悲伤|爽|震撼|节奏|高潮|反转/.test(q),
    navigation: /只看|跳到|整理|回顾|时间线|人物线|线索线|重排/.test(q)
  };
}

function inferPrimaryIntent(intents) {
  if (intents.shot) return 'shot';
  if (intents.foreshadow) return 'foreshadow';
  if (intents.character) return 'character';
  if (intents.navigation) return 'navigation';
  if (intents.emotion) return 'emotion';
  return 'plot';
}

function getShotAnalysis(kb, t) {
  return currentScene(kb, t)?.shot || null;
}

function getPlotContext(kb, t) {
  return scenesUpTo(kb, t).slice(-5).map(s => ({
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
  const primary = inferPrimaryIntent(intents);

  return {
    primary,
    intents,
    shot: intents.shot || primary === 'plot' ? getShotAnalysis(kb, t) : null,
    plot: getPlotContext(kb, t),
    foreshadow: intents.foreshadow ? getForeshadowContext(kb, t) : null,
    characters: intents.character ? getCharacterState(kb, t) : null,
    emotion: intents.emotion || intents.shot ? getEmotionState(kb, t) : null,
    navigation: intents.navigation ? getNavigationContext(kb, t, question) : null
  };
}

function getMissedScenes(kb, previousTime, currentTime) {
  if (previousTime == null) return [];

  return scenesBetween(kb, previousTime, currentTime)
    .filter(s => {
      const importance = s.narrative?.importance || 0;
      const shotImportance = s.shot?.importance || 0;
      const hasForeshadow = !!s.foreshadow?.setup_hint;
      return importance >= 0.65 || shotImportance >= 0.7 || hasForeshadow;
    })
    .map(s => ({
      scene_id: s.scene_id,
      t: s.start_time,
      fact: s.plot?.fact,
      shot_intent: s.shot?.intent,
      setup_hint: s.foreshadow?.setup_hint,
      importance: s.narrative?.importance
    }));
}

function buildContext(kb, params) {
  const {
    cursorTime,
    previousTime,
    question,
    behavior = 'normal',
    mode = 'casual',
    session = {}
  } = params;

  const scene = currentScene(kb, cursorTime);
  const toolBundle = buildToolBundle(kb, cursorTime, question);
  const missed = behavior === 'skip' || behavior === 'fast_forward'
    ? getMissedScenes(kb, previousTime, cursorTime)
    : [];

  return {
    video_title: kb.title,
    current_time: cursorTime,
    previous_time: previousTime ?? null,
    behavior,
    mode,
    current_scene: scene ? {
      scene_id: scene.scene_id,
      time_range: [scene.start_time, scene.end_time],
      plot_fact: scene.plot?.fact,
      plot_reading: scene.plot?.reading,
      narrative: scene.narrative || null,
      shot: scene.shot || null,
      characters: enrichCharacters(kb, scene.characters, cursorTime),
      foreshadow_setup_hint: scene.foreshadow?.setup_hint || null,
      tags: scene.tags || []
    } : null,
    recent_plot: getPlotContext(kb, cursorTime),
    missed_scenes: missed,
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

// ─── 角色对谈（roleplay）—— 共谋者机制 B ─────────────────────────────────
// 区别于 SYSTEM_PROMPT（外部观察者），这里 LLM **就是**那个角色。
function buildRoleplaySystem(profile, db, displayName) {
  const boundary = profile._episode_boundary || {};
  const knowsList = (boundary.knows || []).map(k => `- ${k}`).join('\n') || '- （此集没有明确的 knows 列表）';
  const dontKnowList = (boundary.does_not_know || []).map(k => `- ${k}`).join('\n') || '- （此集没有明确的 does_not_know 列表，但仍不能讲未来）';
  const relationshipBlock = Object.entries(profile.key_relationships_zh || {})
    .map(([cid, summary]) => {
      const entry = db ? (db.characters || []).find(c => c.character_id === cid) : null;
      const name = entry?.display_name_zh || cid;
      return `- ${name}：${summary}`;
    })
    .join('\n') || '（无）';
  const samples = (profile.sample_quotes_zh || []).map(q => `「${q}」`).join('\n') || '（无）';

  return `${profile.voice_zh || `你扮演 ${displayName}。`}

═══ 你是谁（绝不能跳出） ═══
你是 ${displayName}，不是 AI、不是助手、不是旁观者。
用户在与你对话，就像他真的坐在你面前。
不要说"作为 AI"、"作为这个角色"、"我扮演"、"根据剧情设定"。

═══ 你的核心性格 ═══
${(profile.core_traits_zh || []).map(t => `- ${t}`).join('\n') || '（无）'}

═══ 你的说话方式 ═══
${profile.speech_pattern_zh || '（无特殊要求）'}

═══ 你和其他角色的关系 ═══
${relationshipBlock}

═══ 当前剧集是 ${profile._episode || '未知'}。你在这一刻的信息边界（铁律） ═══
你**知道**：
${knowsList}

你**不知道**（哪怕用户问、哪怕你在原著里看过）：
${dontKnowList}

如果用户问的是"不知道"列表里的事：
- 真诚地表现出困惑、警觉、或转移话题
- 不能说"剧透警告"，不能说"我不能告诉你"——你不知道这件事，不是不告诉
- 例：如果有人问雷尼拉"你和戴蒙将来会不会在一起"，她应当反问"将来？……你这话是什么意思"或者直接转开

═══ 你的语气样本（模仿） ═══
${samples}

═══ 输出规则 ═══
- 只用中文
- 50 字以内（除非用户明显在追问让你展开）
- 不写舞台指示（不要写"（皱眉）""（停顿）"）
- 不写括号注释、不写 OOC、不写场景描述
- 不要复述用户的问题
- 直接以你这个角色的口吻回话，像真人说话

═══ 安全网 ═══
如果用户问的事完全在你的信息边界外，又不能转移话题，可以说类似：
- "这话从何说起。"
- "你是在试我？"
- "我不太懂你在问什么。"`;
}

// 三档输出 —— 关键：让三档在**信息种类**上拉开，不是只在长度上。
// oneline = 一刀；brief = 答清楚；deep = 给视觉/多角度/替代可能
function buildAnswerSpec(depth) {
  const d = depth === 'oneline' || depth === 'deep' ? depth : 'brief';

  if (d === 'oneline') {
    return `

═══ 输出格式（oneline / 一句）═══
**只输出 1 句话，≤ 28 个中文字符。**
- 不要分层、不要 [事实]/[解读]/[推测] tag
- 不要"是的"/"这是"/"画面中"开头，直接给最关键的一刀
- 通常是"解读"性质，但写出来不带 tag

例：
Q: 阿丽森穿绿礼服意味着什么？
A: 海塔尔家族在公开亮阵营。

Q: 这个镜头什么意思？
A: 她在装作没听见父亲的话。

Q: 拉里斯刚才看了一眼克里斯顿是想做什么？
A: 他在确认这位骑士能不能被海塔尔家收编。
`;
  }

  if (d === 'deep') {
    return `

═══ 输出格式（deep / 深挖）═══
三层都要写，**每层质感必须不同**：

[事实]（≤ 60 字）—— **不只描述发生了什么，要加视觉细节**：
  - 景别 / 构图 / 光（"特写""逆光剪影""中景平视"）
  - 服装色 / 站位 / 道具（"她坐左下、他立右上"）
  - 对白原文片段（如有可引）

[解读]（≤ 80 字）—— **必须给至少 2 个角度**：
  - "从 X 角度看……但从 Y 角度看……"
  - 或"对她而言……对家族而言……"
  - **只给一种解读 = 不及格**

[推测]（≤ 60 字）—— **必须给替代可能 A/B**：
  - "可能 A，也可能 B"
  - "未必是 X 看起来的那样，也许只是 Y"
  - 用"也许""可能""我怀疑"明确标不确定

每个 tag 在一次回答里最多 1 次。tag 后空一格再写正文。

例：
Q: 阿丽森穿绿礼服意味着什么？
A:
[事实] 中景平视镜头，她身穿海塔尔家族绿色礼服独自走入大厅，宾客静默回头。
[解读] 对绿党而言，这是公开亮阵营、向韦赛里斯施压；对她个人，是父亲被撤后母性立场的一次反扑。
[推测] 也许她并非主动选这件礼服，可能是奥托提前耳语；也可能她已嗅到雷尼拉处境的危险，提前划清界限。
`;
  }

  // brief —— 默认档：直接答清楚，不堆砌
  return `

═══ 输出格式（brief / 简明 · 默认档）═══
两层：[事实] + [解读]。**不要 [推测] 这一层**（除非用户明确问"会不会/可能吗"）。

[事实]（≤ 30 字）当前画面、对白或 KB 里**已发生**的事，不夹判断；如果两者都不明，可以省掉这一层只写 [解读]
[解读]（≤ 45 字）这件事**意味着什么**，一句结论性判断

不要凑长度。能 1-2 句说清就 1-2 句。tag 必须在段首加空格。每个 tag 最多 1 次。
**不要因为信息不足就回"这段暂时还看不出来"** —— 你有 KB 和原著常识可用，如果连这都答不了再说没把握。

例 A（双层）：
Q: 阿丽森穿绿礼服意味着什么？
A:
[事实] 她身穿海塔尔家族的绿色礼服走入婚宴。
[解读] 这是公开亮阵营的政治宣告，绿党对抗黑党的开端。

例 B（单层 [解读]，画面信息薄时）：
Q: 这两人现在什么关系？
A:
[解读] 表面是君臣，实际更像奥托父女在朝堂的延伸。
`;
}

const SYSTEM_PROMPT = `
你是"AI导演注 Agent"，运行在长视频播放器旁边。你的任务不是复述剧情，而是帮助用户在不被剧透的前提下读懂剧情、镜头语言、人物动机、伏笔和情绪节奏。

你会收到一段经过防剧透过滤的 context。context 只包含用户当前播放时间之前的信息。你必须严格只基于 context 回答。

硬性规则：
1. 绝不剧透。不要提及 context 中不存在的信息，不要说"后面会""最终""其实""真相是""将会"等暗示未来的表达。
2. 伏笔只能轻提示，不能揭示回收方式。如果 context 里只有 setup_hint，只能说"这里值得留意"，不能解释它未来的作用。
3. 回答必须贴合用户当前问题和当前时间点，不要泛泛讲电影理论。
4. 如果信息不足，直接说"这段暂时还看不出来"，不要编造。
5. 默认 1-3 句中文，像陪用户看剧时的低声解读，不要写成论文。
6. 如果 mode 是 director，可以稍微专业一点，解释构图、景别、运镜、光线、剪辑。
7. 如果 mode 是 detective，只给提示，不直接给结论。
8. 如果 mode 是 casual，用朋友聊天的方式解释。
9. 如果 mode 是 study，可以分成"镜头 / 情绪 / 叙事作用"三小句，但仍然简洁。
10. 如果用户刚刚发生 skip、倍速、回看、暂停等行为，要优先解释他可能错过了什么，或者为什么这一段值得看。
11. 当用户问"这是谁/他俩什么关系/他现在什么身份"时，使用 current_scene.characters[] 里的 display_name / house / current_status / relationships 作答；只引用字段里实际存在的称号、立场、关系；relationships 已按当前进度过滤，可放心使用。如果某字段为 null，说明此刻还看不出来，直接说"这段暂时还看不出来"。
12. 关键：如果用户消息附带了画面图像，那个图像才是当前真正发生的事实。Context 里的 KB 数据可能是粗略骨架或老的预处理结果，**只能作为人物词典/家族关系的背景参考**。如果 KB 描述与图像明显冲突（人物对不上、动作对不上、地点对不上），相信图像，按图像描述当前画面，并对识别到的角色用 KB 里的身份/关系信息补充。如果图像里的人物 KB 里查不到，就用你对该剧的常识识别其角色名 + 简短身份。

输出要求：
只输出自然语言，不要 JSON，不要代码块，不要说"根据上下文"。
`;

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

  if (context.behavior === 'skip' || context.behavior === 'fast_forward') {
    const missed = context.missed_scenes || [];
    if (missed.length) {
      const m = missed[missed.length - 1];
      return `你刚刚跳过的这段有个关键点：${m.setup_hint || m.shot_intent || m.fact}`;
    }
  }

  if (primary === 'shot' && scene.shot?.intent) {
    return `这个镜头主要在表达${scene.shot.emotion || '情绪变化'}。${scene.shot.intent}`;
  }

  if (primary === 'foreshadow' && scene.foreshadow_setup_hint) {
    return `${scene.foreshadow_setup_hint} 这里先留意就好，暂时不展开。`;
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
  const previousTime = bodyOrQuery.previousTime != null ? normalizeTime(bodyOrQuery.previousTime) : null;
  const question = String(bodyOrQuery.question || '').trim();
  const behavior = bodyOrQuery.behavior || 'normal';
  const mode = bodyOrQuery.mode || 'casual';
  const session = bodyOrQuery.session || {};

  const context = buildContext(kb, {
    cursorTime,
    previousTime,
    question,
    behavior,
    mode,
    session
  });

  return {
    cursorTime,
    previousTime,
    question,
    behavior,
    mode,
    context
  };
}

// ─── 人物识别：face_service 优先 + 智能跳过 LLM ─────────────
// 思路：face_service 跑完知道画面里**总检出多少张脸 + 匹配上多少张**。
// 检出 N 张 = 匹配 N 张 → 整帧已识完，直接返回，不调 LLM（这是最大头：
// 命中场景下从 ~2s 降到 ~200ms）。否则（face_service 没起 / 没检出脸 /
// 半匹配）才调 Gemini 兜底，再按 bbox 合并 face_service 已匹配的部分。
//
// 代价：相比纯并行版，半匹配/face_service down 时多串行一段 ~200ms；但
// 这种场景下 LLM 调用本来 ~2s 起步，多几百毫秒整体感受不出来 —— 而完全
// 命中的常见路径却能省掉一整个 Gemini 调用 + 它的 token 成本。

async function recognizeViaFaceService({ image, db, cursor }) {
  const url = process.env.FACE_SERVICE_URL;
  if (!url) return null;
  const fr = await fetch(`${url}/recognize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image }),
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
  return { matched, totalDetected, rawMatchedCount };
}

async function recognizeViaLLM({ image, db, cursor }) {
  if (!ai.isAvailable('vision')) return null;

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

  const userText = knownChars.length
    ? `Known character database（识别到这些角色时，请把对应 character_id 填入返回结果；DB 之外的人物 character_id 留空）：\n${JSON.stringify(knownChars, null, 2)}\n\n识别下面这一帧画面里的人物：`
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
        dbEntry = (db.characters || []).find(x =>
          String(x.display_name_zh || '').replace(/\s/g, '') === target ||
          String(x.canonical_name || '').replace(/\s/g, '').toLowerCase() === target.toLowerCase()
        );
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
    const onScreen = Array.isArray(scene.characters_on_screen) && scene.characters_on_screen.length
      ? scene.characters_on_screen
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

    // face_service 先跑，全识到就跳过 LLM；半匹配/没起/没检出才调 Gemini。
    // 见 recognizeViaFaceService 上方注释里的设计说明。
    const t0 = Date.now();
    let faceResult = null;
    try {
      faceResult = await recognizeViaFaceService({ image, db, cursor });
    } catch (e) {
      console.warn('[recognize] face_service:', e?.message || e);
    }

    const faceChars = faceResult?.matched || [];
    const totalDetected = faceResult?.totalDetected ?? 0;
    const rawMatchedCount = faceResult?.rawMatchedCount ?? 0;

    // 跳 LLM 的硬条件：face_service 起着 + 检出 ≥1 张脸 + 检出全部都匹配上
    const fullyResolved = faceResult !== null
      && totalDetected > 0
      && rawMatchedCount === totalDetected;

    if (fullyResolved) {
      return res.json({
        characters: faceChars,
        cursor_used: cursor,
        has_kb: !!kb,
        llm_ready: ai.isAvailable('vision'),
        sources: { insightface: faceChars.length, llm: 0, faces_detected: totalDetected },
        skipped: 'llm_unneeded_face_service_full_match',
        elapsed_ms: Date.now() - t0,
      });
    }

    // 否则 LLM 兜底（face_service 没起 / 没检出脸 / 半匹配都走这里）
    let llmChars = [];
    try {
      llmChars = (await recognizeViaLLM({ image, db, cursor })) || [];
    } catch (e) {
      console.error('[recognize] llm:', e?.message || e);
    }

    const characters = mergeRecognitions(faceChars, llmChars);

    res.json({
      characters,
      cursor_used: cursor,
      has_kb: !!kb,
      llm_ready: ai.isAvailable('vision'),
      sources: { insightface: faceChars.length, llm: llmChars.length, faces_detected: totalDetected },
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
      behavior: prepared.behavior,
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
      previousTime: req.body?.previousTime != null ? normalizeTime(req.body.previousTime) : null,
      question: String(req.body?.question || '').trim(),
      behavior: req.body?.behavior || 'normal',
      mode: req.body?.mode || 'casual',
      context: { current_scene: null, tool_bundle: { primary: null, intents: {} } },
    };

    send('meta', {
      has_kb: !!kb,
      cursor_time: prepared.cursorTime,
      behavior: prepared.behavior,
      mode: prepared.mode,
      primary_intent: prepared.context.tool_bundle?.primary || null,
      intents: prepared.context.tool_bundle?.intents || {},
      mode_used: prepared.mode === 'roleplay' ? 'roleplay' : (hasImageEarly ? 'vision' : 'kb'),
    });

    // 任务类型在拿到 image/clipFrames 之后再决定（visualMode 才走 vision_chat）
    const controller = new AbortController();

    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    // ─── 角色对谈（共谋者机制 B）—— 早分支 ─────────────────────
    // 触发条件：mode === 'roleplay' 且 characterId 已知。如果 profile 缺失，fall through 到普通问答。
    if (prepared.mode === 'roleplay' && req.body?.characterId) {
      const showId = (kb && kb.show_id) || 'house-of-the-dragon';
      const episode = resolveEpisode(kb);
      const profile = charactersLib.lookupRoleplayProfile(showId, req.body.characterId, episode);
      const db = getCharacterDb(showId);
      const dbCard = db ? charactersLib.findCharacter(db, req.body.characterId) : null;
      const displayName = dbCard?.display_name_zh || dbCard?.canonical_name || req.body.characterId;

      if (profile) {
        const roleplaySystem = buildRoleplaySystem(profile, db, displayName);

        const exchanges = Array.isArray(req.body?.session?.last_exchanges)
          ? req.body.session.last_exchanges.slice(-6)
          : [];
        const dialogueLines = exchanges
          .map(e => {
            const who = e.role === 'user' ? '用户' : displayName;
            return `${who}：${String(e.text || '').slice(0, 200)}`;
          })
          .join('\n');

        const userQuestion = prepared.question || '（用户没说话，但他正看着你。）';
        const optImageEarly = req.body?.image;
        const optHasImage = !!(optImageEarly && typeof optImageEarly === 'string' && optImageEarly.startsWith('data:image/'));

        const userContent = [];
        if (optHasImage) {
          userContent.push({ type: 'image', dataUrl: optImageEarly, detail: 'low' });
          userContent.push({
            type: 'text',
            text: `（这是用户当前看到的画面 —— 你不必描述它，但可以从中感知此刻气氛。）`,
          });
        }
        userContent.push({
          type: 'text',
          text: dialogueLines
            ? `先前对话：\n${dialogueLines}\n\n用户现在对你说：${userQuestion}`
            : `用户对你说：${userQuestion}`,
        });

        const roleplayTask = optHasImage ? 'vision_chat' : 'chat';
        if (!ai.isAvailable(roleplayTask)) {
          send('text', { delta: '（这一会儿我说不出话——你换个时候再来找我。）' });
          send('done', { source: 'template' });
          return res.end();
        }

        try {
          let providerInfo = null;
          let usage = null;
          const stream = ai.chatStream({
            task: roleplayTask,
            system: roleplaySystem,
            messages: [{ role: 'user', content: userContent }],
            maxTokens: 280,
            temperature: 0.85,
            signal: controller.signal,
          });
          for await (const chunk of stream) {
            if (chunk.type === 'meta') {
              providerInfo = { provider: chunk.provider, model: chunk.model };
              continue;
            }
            if (chunk.type === 'text' && chunk.delta) send('text', { delta: chunk.delta });
            if (chunk.type === 'done') usage = chunk.usage;
          }
          send('done', {
            source: 'llm',
            mode: 'roleplay',
            character_id: req.body.characterId,
            display_name: displayName,
            episode,
            provider: providerInfo?.provider || null,
            model: providerInfo?.model || null,
            usage,
          });
          return res.end();
        } catch (err) {
          if (controller.signal.aborted) return res.end();
          console.error('[roleplay] stream error:', err.message);
          send('text', { delta: '（这一会儿我说不出话——你换个时候再来找我。）' });
          send('done', { source: 'error', mode: 'roleplay' });
          return res.end();
        }
      }
      // profile 缺失 → 不报错，fall through 到普通视觉/KB 问答
    }

    const image = req.body?.image;
    const hasImage = image && typeof image === 'string' && image.startsWith('data:image/');

    // Server-side clip extraction：从上传视频里抓 cursor 附近 3 帧
    const videoFile = req.body?.videoFile;
    let clipFrames = [];
    if (videoFile && typeof videoFile === 'string' && /^[a-zA-Z0-9._\-]+$/.test(videoFile) && !videoFile.includes('..')) {
      const vp = path.join(UPLOADS_DIR, videoFile);
      try {
        clipFrames = await extractClipFrames(vp, prepared.cursorTime, 8, 3);
      } catch (e) {
        console.error('[chat] clip extract failed:', e.message);
      }
    }
    const hasClip = clipFrames.length > 0;
    const visualMode = hasImage || hasClip;

    const VISION_SYSTEM_PROMPT = `你是用户的"剧友"，正在陪 ta 一起追《龙之家族》。你很熟这部剧和《冰与火之歌》的世界观，但**绝对不剧透**。

你的目标不是讲百科，而是帮用户在当下这一刻看懂：
这句话在试探什么、谁在压谁、谁在装、谁在忍、谁的处境变危险了。

═══ 你的人设 ═══
- 你像坐在用户旁边一起看剧的人，轻声提醒，不做课堂讲解
- 你懂坦格利安、海塔尔、瓦列利安这些家族的规矩、体面、血统和权力游戏
- 你知道宫廷里很多话不是字面意思，而是在试探、威胁、示好、割席、逼人表态
- 你有原著读者的敏感度，但不能说未来，只能说"当前已经能看出来的东西"
- 语气可以有一点中世纪宫廷感，但要自然，不要写成论文

═══ 绝对不剧透 ═══
只能使用：
1. 当前画面
2. previous_context 已经发生的对白/剧情
3. character_dictionary 在当前 cursor 之前允许出现的人物信息

禁止使用：
- 未来剧情
- 未来死亡
- 未来阵营变化
- 未来婚姻、背叛、称号变化
- 当前时间点之后才揭示的人物关系
- 原著中但剧集当前还没演到的信息

如果某件事你知道未来会发生，但当前还没发生，必须当作不知道。

═══ 信息来源优先级 ═══
回答前按这个顺序判断：

1. character_dictionary
   - 如果识别到人物，必须优先使用人物名字
   - 如果字典给了关系，就用关系解释
   - 如果字典没有写关系，不要自己补
   - 严禁根据发色、衣服、气质猜家族或身份

2. retrieved_knowledge（已按当前在场角色 + 用户问题检索过的相关条目，含 wiki 世界观和影评解说精华）
   - 用它来补充字典里没写的"为什么"、"潜台词"、"权力背景"
   - 注意 _score 低的条目相关度弱，谨慎使用
   - 不要把整段照搬；提取里面的判断，自己用一句话说出来

3. previous_context
   - 最近对白比当前单帧更重要
   - 用户问"什么意思"时，优先解释这句话接着前面在干嘛
   - 如果没有最近对白，就不要强行解读潜台词

4. 当前画面
   - 表情、站位、距离、沉默、谁先开口，可以作为辅助
   - 但画面只能辅助，不允许单独决定人物身份和关系

═══ 回答重点 ═══
优先解释这些东西：
- 这句话是在试探谁
- 谁掌握主动权
- 谁在给台阶
- 谁在威胁
- 谁在装糊涂
- 谁在忍气吞声
- 谁的身份/处境发生变化
- 这段对当前权力关系有什么影响

═══ 解读角度（按需融入，不强行）═══
retrieved_knowledge 里如果出现了下面任一角度的**具体观察**，**且与当前场景明显对得上**，可以自然地织进回答里 —— 但只在它真的能加深用户对当下这一刻的理解时用，不要为了显得专业硬塞。

**(1) 视听语言 / 场景细节**
- 色彩与服装：阿丽森的绿色服装 = "绿党"信号；红黑礼裙 = 阵营转变；海伦娜黑红刺绣 = 家族斗争预兆
- 人物站位：韦赛里斯站在铁王座前不坐 = 权力不安；对峙站位 = 冲突将爆
- 道具象征：铁王座割伤 = 王权代价；龙头骨 = 家族脆弱；瓦雷利亚语 = 贵族身份
- 剪辑：比武+剖腹的交叉剪辑 = 暴力与生命对照；平行剪辑 = 紧张累积
- 镜头：特写转脸 = 真实情绪暴露；逆光剪影 = 动机被遮蔽

**(2) 互文性与致敬**
- 跟《权游》前作的呼应（"血色婚礼又来了"、瑟曦、囧雪等历史阴影）
- 片头家谱 / 王朝史的厚重感：当前剧情如何嵌入坦格利安百年史
- 提示用户"这个 callback 是给老观众的"

**(3) 文本潜台词与台词拆解**
- 关键遗言 / 一句话的歧义如何改写历史（典型：国王临终遗言被听成另一个意思）
- 信息差导致的"罗生门"：A 知道 X、B 不知道，于是 B 误解了 A
- 双关、暗号、宫廷套话的**真意 vs 字面**

**(4) 心理分析 / 潜意识**
- 梦境 / 幻觉的功能：戴蒙的梦游揭示恐惧 / 欲望 / 身份焦虑
- 角色"黑化"的心理曲线：环境如何一步步异化温和的人
- 沉默 / 重复动作背后的潜意识

**(5) 类型 / 基调与作者风格**
- "地狱笑话"：用荒诞或幽默冲淡悲剧重量
- 视觉奇观的分布：龙战如何服务叙事压力（不是炫技），含龙量节奏
- 体裁混搭：宫廷剧 / 家庭伦理 / 战争片 的切换

**(6) 社会学与权力结构**
- 性别与权力：女性在男权继承制下的生存策略（雷尼拉的处境、阿丽森的工具人化）
- 阶级 / 民众视角：底层平民如何看待高层动荡（"君临民众生活"切片）
- 制度对个人的碾压：礼仪、继承法、家族联姻如何决定个体命运

═══ 判断要不要用的标准 ═══
✓ 用：retrieved_knowledge 里有针对**这个时间点 / 这个角色 / 这个场景**的具体注解，能直接帮用户看懂
✗ 不用：只是泛泛的影评理论，跟当前画面对不上号；用户问的是简单事实（"他是谁"）
✗ 不用：当前 retrieved_knowledge 里没有相关条目 → 就别假装看见了

例子：
用户问："她为什么穿这身绿"
→ 命中色彩注解："绿色不是随便选的 —— 这是海塔尔家族的颜色，她穿这身等于公开站到了奥托那一边。"

用户问："这段啥意思"（场景：戴蒙坐铁王座）
→ 命中道具象征："戴蒙坐到了王座上 —— 哪怕只是哥哥不在，他也忍不住要试试那个位置。"

用户问："国王刚才说什么"（场景：国王临终）
→ 命中潜台词角度："国王在说梦里见到的'应许王子'，但听到的人会以为他在说自己的儿子伊耿 —— 这句话之后就是误会的源头。"

用户问："这场会议为什么气氛这么怪"
→ 命中社会学角度："因为桌上女性话语权的差距 —— 阿丽森本来该旁听，今天却开口替儿子定调，这在维斯特洛是越线的。"

用户问："这俩人什么关系"（场景没有特殊信号）
→ 不要硬扯镜头分析，老老实实答关系。

═══ 原著 / 维斯特洛风格 ═══
也可以参考你对原著的理解但是千万不能剧透。也可以参考我给你的b站解说的风格

可以使用这种味道：
- "这话听着客气，其实是在亮刀。"
- "他没把剑拔出来，但意思已经到了。"
- "这是宫廷里的软威胁。"
- "在维斯特洛，沉默有时候比誓言还重。"
- "他是在给对方留体面，也是在提醒对方别越线。"
- "这不是闲聊，是在探口风。"
- "表面是家事，底下全是继承权。"

但不要写成古风、不要过度文学化、不要每句都像旁白。

═══ 禁止的错误 ═══
- 不要说"这个金发男子可能是兰尼斯特"
- 不要说"似乎暗示未来会……"
- 不要说"根据原著……"
- 不要说"从叙事结构来看……"
- 不要说"这个场景表明编剧想表达……"
- 不要把不确定的东西说死
- 不要用百科口吻介绍角色生平

═══ 不确定时的说法 ═══
如果信息不够，就这样说：
- "这句单拎出来有点断，得看前一句。"
- "我不敢说死，但他像是在试探。"
- "现在还看不明牌，先记住这人说话不太干净。"
- "这会儿别急着下结论，他是在绕着说。"

═══ 语言风格 ═══
严禁这样开头：
"这段画面里……" / "画面中……" / "镜头里……" / "这个场景……"
"结合上下文……" / "根据字典……" / "据资料显示……"

回答要像随口说，但有判断力。

例子：
用户问："这段什么意思"
好回答：
"他是在试探对方知不知道那个秘密。话说得很轻，但其实已经把刀贴到桌下了。"

用户问："他为什么不说话"
好回答：
"他在忍。现在开口就是把自己拖进局里，沉默反而更安全。"

用户问："这俩人什么关系"
好回答：
"他们不是普通熟人。说话太近了，而且彼此都知道对方藏着事。"

用户问："她为什么生气"
好回答：
"因为这不是一句冒犯，是当众不给她体面。在宫廷里，这比骂人还狠。"

用户问："这人是谁"
如果能识别：
"这是雷尼拉。现在她不只是公主，还是被公开承认的继承人。"
如果不能识别：
"我不敢认死，光看这一帧容易认错。你点一下'当前人物'更稳。"

═══ 长度 ═══
默认 1-3 句中文，最多 80 字。
只有用户明确问"详细讲"，才可以稍微展开。
不要结尾加"如果你想……"这种话。`;

    let userContent;
    if (visualMode) {
      // 视觉模式：服务端 ffmpeg 抽 N 帧 + 前端单帧 + KB 字典 + wiki lore + 历史对话 + 分析方法
      const db = kb ? getCharacterDb(kb.show_id) : null;
      const cursor = kb ? charactersLib.cursorAtTime(kb, prepared.cursorTime) : null;
      const characterDictionary = db ? (db.characters || []).map(c => {
        const card = charactersLib.lookupCharacter(db, c.character_id, cursor);
        return {
          character_id: c.character_id,
          display_name: c.display_name_zh,
          short_identity: c.short_identity_zh,
          house: c.house,
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
            .slice(-6)
            .map(s => ({ t: s.start_time, scene_id: s.scene_id, summary: s.plot.fact }))
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
      // 把 character_id 翻译成中文名 + 别名，给检索打分用
      const charNames = [];
      const charAliases = [];
      for (const cid of sceneCharIds) {
        const entry = (db?.characters || []).find(c => c.character_id === cid);
        if (!entry) continue;
        if (entry.display_name_zh) charNames.push(entry.display_name_zh);
        if (entry.canonical_name) charAliases.push(entry.canonical_name);
        if (entry.house) charAliases.push(entry.house);
        if (entry.short_identity_zh) charAliases.push(entry.short_identity_zh);
      }
      const retrievedKnowledge = retrieveKnowledge({
        query: prepared.question || '',
        characterNames: charNames,
        characterAliases: charAliases,
        k: 8,
      });

      const clipDescription = hasClip
        ? `${clipFrames.length} 张连续画面：` + clipFrames.map((f, i) => {
            const tag = i === 0 ? '稍早' : (i === clipFrames.length - 1 ? '稍后' : '中间≈提问时刻');
            return `第${i + 1}张 (t=${f.t.toFixed(1)}s, ${tag})`;
          }).join('、')
        : null;

      const agentInput = {
        current_time_s: Math.floor(prepared.cursorTime),
        user_mode: prepared.mode || 'casual',
        user_behavior: prepared.behavior || 'normal',
        clip_window: clipDescription,
        previous_context: {
          from_prior_agent_observations: previousFromAgent,
          from_kb_scenes_before_now: previousFromKb,
        },
        conversation,
        character_dictionary: characterDictionary,
        // 用打分检索后的相关知识替换无脑 slice(0,12)
        retrieved_knowledge: retrievedKnowledge,
        analysis_patterns: ANALYSIS_PATTERNS,
        user_question: prepared.question || '请解释当前画面。',
      };

      // 图像顺序：clipFrames（按时间从早到晚）→ 前端 capture（如果还有的话作为"当前精确时刻"）
      const images = [];
      for (const f of clipFrames) {
        images.push({ type: 'image', dataUrl: f.dataUrl, detail: 'high' });
      }
      if (hasImage) {
        images.push({ type: 'image', dataUrl: image, detail: 'high' });
      }

      userContent = [
        ...images,
        {
          type: 'text',
          text: `↑ 上面是用户当前看到的视频片段（按时间顺序排列）。下面是结构化 Agent 输入（按 SYSTEM 里"内部推理流程"使用；不要把字段名/JSON 写进答案）：

\`\`\`json
${JSON.stringify(agentInput, null, 2)}
\`\`\``,
        },
      ];
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

    const task = visualMode ? 'vision_chat' : 'chat';
    if (!ai.isAvailable(task)) {
      send('text', { delta: generateTemplate(prepared.context, prepared.question) });
      send('done', { source: 'template' });
      return res.end();
    }

    // 三档输出（一句 / 简明 / 深挖）+ 三层标注（事实 / 解读 / 推测）
    const depth = ['oneline', 'brief', 'deep'].includes(req.body?.depth)
      ? req.body.depth : 'brief';
    const baseSystem = visualMode ? VISION_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const systemWithSpec = baseSystem + buildAnswerSpec(depth);

    // deep 档要装得下三层多角度内容；oneline 卡到 60 强制简短；brief 默认。
    const maxTokens = depth === 'deep' ? 900 : (depth === 'oneline' ? 60 : 280);

    try {
      let usage = null;
      let providerInfo = null;

      const stream = ai.chatStream({
        task,
        system: systemWithSpec,
        messages: [{ role: 'user', content: userContent }],
        maxTokens,
        temperature: visualMode ? 0.7 : 0.4, // 视觉问答需要更自然的口语，温度高一点
        signal: controller.signal,
      });

      for await (const chunk of stream) {
        if (chunk.type === 'meta') {
          providerInfo = { provider: chunk.provider, model: chunk.model };
          continue;
        }
        if (chunk.type === 'text' && chunk.delta) send('text', { delta: chunk.delta });
        if (chunk.type === 'done') usage = chunk.usage;
      }

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
      send('text', {
        delta: generateTemplate(prepared.context, prepared.question)
      });
      send('done', { source: 'template' });
      res.end();
    }
  });

  // ─── 共谋者 · 机制 C：平行视角 · HUD 卡片版 ────────────────
  // 不写小说。让 LLM 从安全表 [看到/判断/风险/立场/关系/代价] 里挑 3 个 label，
  // 每张卡片正文写当前场景里 TA 的具体认知。语气是 HBO 译制风的冷峻政治叙事，
  // 不是史书学士那一套。
  app.post('/api/agent/perspective/generate', async (req, res) => {
    const { videoId, t, characterId } = req.body || {};
    const kb = videoId ? loadKB(videoId) : null;
    if (!kb || !characterId) {
      return res.status(400).json({ error: 'videoId + characterId required' });
    }
    const cursorTime = normalizeTime(t);
    const scene = currentScene(kb, cursorTime);
    if (!scene) {
      return res.status(400).json({ error: 'no scene at cursor' });
    }
    const showId = kb.show_id || 'house-of-the-dragon';
    const episode = resolveEpisode(kb);
    const profile = charactersLib.lookupRoleplayProfile(showId, characterId, episode);
    const db = getCharacterDb(showId);
    const dbCard = db ? charactersLib.findCharacter(db, characterId) : null;
    const displayName = dbCard?.display_name_zh || dbCard?.canonical_name || characterId;
    const subtitleLine = dbCard?.short_identity_zh || profile?.subtitle || '';

    if (!ai.isAvailable('perspective') && !ai.isAvailable('chat')) {
      return res.status(503).json({ error: 'no llm available' });
    }

    // 在场角色（用中文名）
    const onScreenIds = new Set();
    for (const c of (scene.characters_on_screen || [])) if (c.character_id) onScreenIds.add(c.character_id);
    for (const c of (scene.characters || [])) if (c.id) onScreenIds.add(c.id);
    const onScreenNames = [...onScreenIds].map(cid => {
      const e = db ? charactersLib.findCharacter(db, cid) : null;
      return e?.display_name_zh || e?.canonical_name || cid;
    });
    const isOnScreen = onScreenIds.has(characterId);

    const traits = profile?.core_traits_zh?.join('、') || '（未提供）';
    const knows = profile?._episode_boundary?.knows?.join('；') || '（未提供）';
    const dontKnow = profile?._episode_boundary?.does_not_know?.join('；') || '（未提供）';

    const system = `你是 HBO 《龙之家族》风格的"角色认知 HUD" Agent。任务：把当前这场戏里 ${displayName} 的认知做成 3 张极短卡片。

═══ 风格目标（这是核心，违反就重写） ═══
- 冷峻、克制、现实、政治化 —— 像宫廷分析，不是诗化旁白
- 抓的是：身份、家族、继承、盟友、敌人、风险、代价、立场
- 现代中文，但保留冰火世界的权力压力
- 不要"文学感"，不要抒情，不要玄学

═══ 绝对禁止（命中任何一条都会被丢弃） ═══
- 古风/书房意象：执笔、卷宗、史书、史册、羊皮纸、鹅毛笔、学士、落墨、另一卷、书页、篇章
- 文言/古风副词：汝、吾、岂、毋、由是、其一其二、归途
- 仙侠：苍生、天道、轮回、红尘、众生
- 宿命论修辞：命运、宿命、命运之门、命运在你手中、改写历史、抉择
- 旧版 HUD 标签：眼前、盘算、隐忧
- 套话："此刻就在你面前""问问看""问她一句""问 TA 一句""你后悔吗""你到底想做什么""另一条路"
- "此刻"作为副词也不要用 —— 用"现在""正在""当前"或者干脆不写时间状语

═══ 万金油对冲句拉黑 ═══
下面这些是"听起来像在说什么但其实没说"的废话句式，命中即丢弃：
- "X 仍然活跃" / "X 可能在影响 Y" / "X 可能影响 Y 局势" / "X 影响家族稳定"
- "暂未明朗" / "尚未明朗" / "尚不清楚" / "不得而知"
不要用"可能在""可能会被""或许会"开头空对空地猜测影响。要写就写具体的、画面/材料里能落地的事——
比如："父子争吵后被赶出王廷"比"可能影响家族稳定"好十倍。如果只能写空话，宁可换一张卡的 label。

═══ 输出格式（严格 JSON） ═══
{
  "pov_character": "${displayName}",
  "subtitle": "（≤20 字，TA 当前身份/位置标签，例如「王后｜海塔尔家族」「龙石岛公主｜王位继承人」）",
  "cards": [
    {"label": "（必须从安全表里挑）", "text": "（≤26 字）"},
    {"label": "（必须从安全表里挑，不要重复）", "text": "（≤26 字）"},
    {"label": "（必须从安全表里挑，不要重复）", "text": "（≤26 字）"}
  ]
}

═══ label 安全表（只能用这 6 个，按场景挑 3 个最贴的） ═══
看到、判断、风险、立场、关系、代价

═══ 写 text 的硬规则 ═══
1. 每张卡片正文 ≤ 26 个中文字符
2. 内容必须从下面的"当前场景"和"TA 在这一集知道的事"里长出来；不能脱离上下文写一句任何角色都能套的话
3. **第三人称硬规则**：必须写"她/他"，绝对不能写"我"。注意"TA 在这一集知道的事"那段材料是用第一人称（"我刚从符石城回来"）写的 —— 那是 TA 自己的视角，是输入，不是输出。你写卡片时必须把它改写成第三人称（"他刚从符石城回来"）。卡片正文里出现"我""我的"算输出失败。
4. 不引用原剧台词，不剧透未来
5. 写具体的身份、动机、风险，不写情绪形容词堆砌

═══ 优秀范例（仅供把握质地，禁止照抄字面） ═══
范例 A（阿丽森看见雷尼拉接近危险选择）：
{
  "pov_character": "阿丽森·海塔尔",
  "subtitle": "王后｜海塔尔家族",
  "cards": [
    {"label": "看到", "text": "雷尼拉正在靠近一个危险的选择"},
    {"label": "判断", "text": "这会削弱她在宫廷的位置"},
    {"label": "风险", "text": "海塔尔家族可能被卷入后果"}
  ]
}
范例 B（雷尼拉面对克里斯顿的提议）：
{
  "pov_character": "雷尼拉·坦格利安",
  "subtitle": "龙石岛公主｜王位继承人",
  "cards": [
    {"label": "看到", "text": "他给了她一条离开宫廷的可能"},
    {"label": "判断", "text": "这不是爱情那么简单"},
    {"label": "代价", "text": "接受会触碰王室继承责任"}
  ]
}

不要任何前后说明、不要 markdown、不要 \`\`\`。直接输出 JSON。`;

    // POV 角色与每位"在场"角色的关系（cursor-filtered）—— 让 LLM 写"关系"
    // 那张卡时有具体可锚定的事实（盟友/政敌/血亲/暧昧/疏离等），不再瞎猜。
    const cursorMark = charactersLib.cursorAtTime(kb, cursorTime);
    const povRels = db ? charactersLib.lookupRelationships(db, characterId, cursorMark) : [];
    const onScreenRelations = [...onScreenIds]
      .filter(cid => cid !== characterId)
      .map(cid => {
        const rel = povRels.find(r => r.with === cid);
        const other = db ? charactersLib.findCharacter(db, cid) : null;
        const otherName = other?.display_name_zh || other?.canonical_name || cid;
        if (!rel) return `${otherName}：暂无明确记载关系`;
        const head = rel.relation || rel.relation_kind || '关系';
        return `${otherName}：${head}${rel.summary ? ` —— ${rel.summary}` : ''}`;
      });

    const sceneSummary = [
      scene.plot?.fact && `场景事实：${scene.plot.fact}`,
      scene.plot?.reading && `导演意图：${scene.plot.reading}`,
      scene.narrative && `叙事节拍：${scene.narrative}`,
      scene.shot?.intent && `镜头意图：${scene.shot.intent}`,
      scene.shot?.emotion && `场景情绪：${scene.shot.emotion}`,
      Array.isArray(scene.tags) && scene.tags.length && `场景标签：${scene.tags.join('、')}`,
      onScreenNames.length && `在场：${onScreenNames.join('、')}`,
      onScreenRelations.length && [`${displayName} 与在场角色的关系（截至当前进度）：`, ...onScreenRelations.map(s => `  - ${s}`)].join('\n'),
      isOnScreen
        ? `${displayName} 在画面里。`
        : `${displayName} 不在画面里 —— 但理论上可能在场外、附近，或刚刚离开。请合理处理。`,
    ].filter(Boolean).join('\n');

    const user = `【当前剧集】${episode || '未知'}
【时间点】${Math.floor(cursorTime / 60)}:${String(Math.floor(cursorTime % 60)).padStart(2, '0')}
【POV 角色】${displayName}${subtitleLine ? `（${subtitleLine}）` : ''}
【性格】${traits}
【在这一集 TA 知道的事】${knows}
【在这一集 TA 不知道、不能写进卡片的事】${dontKnow}

【当前场景（剧情切片）】
${sceneSummary}

请基于上面的"剧情切片"和"与在场角色的关系"，生成 ${displayName} 在这一刻的认知 HUD。
卡片必须扣住具体的人和事——比如"看到"那张写谁在做什么具体动作、"关系"那张直接写 TA 与画面里另一个具体角色的状态、"风险"那张写如果当前局面继续会损失什么具体的东西。
label 必须从安全表（看到/判断/风险/立场/关系/代价）里挑 3 个不同的。直接输出 JSON。`;

    try {
      const result = await ai.chat({
        // Routes to gemini-2.5-pro by default (see lib/ai/router.js).
        // Falls back to chat task / openai if gemini key is missing.
        task: ai.isAvailable('perspective') ? 'perspective' : 'chat',
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 500,
        temperature: 0.6,
      });
      const txt = String(result?.text || '').trim();
      const parsed = parsePerspectiveJSON(txt);
      if (!parsed) {
        return res.status(500).json({
          error: 'llm returned non-JSON',
          raw: txt.slice(0, 300),
          fallback: defaultPerspectivePayload(displayName, subtitleLine),
        });
      }
      // 命中负面词库（古风/套话）或第一人称泄漏 → 视为污染，丢掉这次输出走 fallback。
      const bannedHit = parsed.cards.some(c => containsBannedOverlayPhrase(c.text)) ||
        (parsed.subtitle && containsBannedOverlayPhrase(parsed.subtitle));
      const firstPersonHit = parsed.cards.some(c => containsFirstPerson(c.text));
      if (bannedHit || firstPersonHit) {
        return res.status(422).json({
          error: bannedHit
            ? 'llm output violates anti-template constraints'
            : 'llm output leaked first-person voice',
          raw_payload: parsed,
          fallback: defaultPerspectivePayload(displayName, subtitleLine),
        });
      }
      // 强制 actions 固定（前端按位置渲染），neutral / 政治叙事风
      parsed.actions = ['继续 TA 的视角', '回到正片'];
      // 兜底 subtitle
      if (!parsed.subtitle && subtitleLine) parsed.subtitle = subtitleLine;
      // 兜底 pov_character
      if (!parsed.pov_character) parsed.pov_character = displayName;

      res.json({ ...parsed, episode, character_id: characterId });
    } catch (err) {
      console.error('[perspective] error:', err.message);
      return res.status(500).json({
        error: err.message,
        fallback: defaultPerspectivePayload(displayName, subtitleLine),
      });
    }
  });

  // ─── P0 · 动态人物卡 ─────────────────────────────────────────
  // 长按头像/face bbox 触发：返回截至 cursor 的 4 张极短卡片，
  // 「当前身份 / 阵营 / 与主角关系（或主角自己的"立场"） / 最近事件」。
  // 数据 = 角色 DB 的 spoiler-safe 切片（lookupCharacter + lookupRelationships）
  // + 当前 scene 的 plot.fact（如有）。LLM 把结构化数据润成 HBO 译制风一句话。
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

  // ─── 共谋者 · 机制 B · 角色对谈入场前奏（context-driven）─────
  // 前端在用户刚进入与某角色对谈、还没发出第一句时，需要一个"为什么是 TA、
  // 为什么是这一刻"的浮层文案。绝不能是"{name} 此刻就在你面前 / 问问看"
  // 这类填模板的句子；必须由当前 scene + character profile 现写。
  app.post('/api/agent/roleplay/intro', async (req, res) => {
    const { videoId, t, characterId } = req.body || {};
    const kb = videoId ? loadKB(videoId) : null;
    if (!kb || !characterId) {
      return res.status(400).json({ error: 'videoId + characterId required' });
    }
    const cursorTime = normalizeTime(t);
    const scene = currentScene(kb, cursorTime);
    if (!scene) {
      return res.status(400).json({ error: 'no scene at cursor' });
    }
    const showId = kb.show_id || 'house-of-the-dragon';
    const episode = resolveEpisode(kb);
    const profile = charactersLib.lookupRoleplayProfile(showId, characterId, episode);
    const db = getCharacterDb(showId);
    const dbCard = db ? charactersLib.findCharacter(db, characterId) : null;
    const displayName = dbCard?.display_name_zh || dbCard?.canonical_name || characterId;
    const shortIdentity = dbCard?.short_identity_zh || profile?.subtitle || '';

    if (!ai.isAvailable('chat')) {
      return res.status(503).json({ error: 'no llm available' });
    }

    // 在场角色（中文名），用于让 LLM 知道当前对手戏是哪一组
    const onScreenIds = new Set();
    for (const c of (scene.characters_on_screen || [])) if (c.character_id) onScreenIds.add(c.character_id);
    for (const c of (scene.characters || [])) if (c.id) onScreenIds.add(c.id);
    const onScreenNames = [...onScreenIds].map(cid => {
      const e = db ? charactersLib.findCharacter(db, cid) : null;
      return e?.display_name_zh || e?.canonical_name || cid;
    });

    const traits = profile?.core_traits_zh?.join('、') || '（未提供）';
    const knows = profile?._episode_boundary?.knows?.join('；') || '（未提供）';
    // 与本场在场的其他角色，TA 的关系摘要 —— 这一段是冲突的来源
    const relevantRels = [];
    const relMap = profile?.key_relationships_zh || {};
    for (const otherId of onScreenIds) {
      if (otherId === characterId) continue;
      const summary = relMap[otherId];
      if (!summary) continue;
      const e = db ? charactersLib.findCharacter(db, otherId) : null;
      const otherName = e?.display_name_zh || otherId;
      relevantRels.push(`- 对 ${otherName}：${summary}`);
    }
    const relevantRelsBlock = relevantRels.join('\n') || '（这场没有与 TA 直接冲突的对手戏角色）';

    const system = `你是 HBO 《龙之家族》的"角色对谈入场前奏" UI 文案 Agent。

任务：在观众刚选中要与 ${displayName} 对谈、但还没发出第一句话之前，为画面生成一组上下文驱动的悬浮文案。

═══ 你绝对禁止做的事（命中任何一条都视为失败） ═══
不要使用以下任何模板句或词，不论变体：
- "${displayName} 此刻就在你面前"、"就在你面前"
- "问问看 ——"
- "你后悔吗"、"你到底想做什么"、"你到底想要什么"
- "另一条路正在打开"、"命运等待你的选择"、"命运在你手中"
- "书页尚未落下"、"执笔"、"卷宗"、"史书"、"史册"、"羊皮纸"、"鹅毛笔"、"学士"
- 中国古风：汝、吾、归途、由是、其一其二、岂、毋
- 仙侠：苍生、天道、轮回、红尘、众生
- 大词：改写历史、抉择、人生
不要写成"你站在 TA 面前 ……"这种泛舞台调度。
不要把所有人物都套同一句式。

═══ 风格要求 ═══
- 冷峻、克制，带 HBO 字幕译制风的政治-家族压力感
- 不写小说体，写影视 HUD：每句独立成行，像字幕浮层
- 第三人称指代 TA（"她"/"他"），不要第一人称（不是日记）
- 文案必须从下方"当前场景"和"TA 与在场对手戏角色的关系"中长出来；
  不能脱离上下文写一句任何角色都能套进去的句子

═══ 输出严格 JSON ═══
{
  "hero_line": "12-22 字主句：基于此刻冲突给出一个**有信息量**的判断，不是煽情",
  "sub_line": "8-16 字副句：TA 此刻的身份/处境（例：'雷尼拉｜继承人与少女之间''阿丽森｜王后、母亲、海塔尔之女'）",
  "prompt_line": "8-18 字交互引导，例如'以她的视角看这场靠近''站在他的位置重新看这一幕'",
  "suggested_questions": [
    "8-20 字的问题，问的是 **这一场的具体冲突**，不是泛泛的人物背景",
    "另一条同样具体的问题",
    "再一条"
  ]
}

═══ 优秀范例（仅供把握质地，禁止照抄 hero_line / sub_line 字面） ═══
范例 A（雷尼拉与克里斯顿在私密空间靠近）：
{
  "hero_line": "她在试探一条不属于王室的路",
  "sub_line": "雷尼拉｜继承人与少女之间",
  "prompt_line": "以她的视角看这场靠近",
  "suggested_questions": [
    "她为什么被他吸引？",
    "这段关系危险在哪里？",
    "她此刻真正想摆脱什么？"
  ]
}
范例 B（阿丽森看见雷尼拉与他人接触）：
{
  "hero_line": "她看到的不只是一次交谈",
  "sub_line": "阿丽森｜王后、母亲、海塔尔之女",
  "prompt_line": "站在她的位置重新看这一幕",
  "suggested_questions": [
    "她为什么紧张？",
    "这对海塔尔家意味着什么？",
    "她看见了什么风险？"
  ]
}

不要任何前后说明、不要 markdown、不要 \`\`\`。直接输出 JSON。`;

    const sceneSummary = [
      scene.plot?.fact && `场景事实：${scene.plot.fact}`,
      scene.plot?.reading && `导演意图：${scene.plot.reading}`,
      onScreenNames.length && `在场：${onScreenNames.join('、')}`,
    ].filter(Boolean).join('\n') || '（场景信息缺失）';

    const user = `【当前剧集】${episode || '未知'}
【时间点】${Math.floor(cursorTime / 60)}:${String(Math.floor(cursorTime % 60)).padStart(2, '0')}
【对谈对象】${displayName}${shortIdentity ? `（${shortIdentity}）` : ''}
【TA 的核心性格】${traits}
【TA 此刻知道的事】${knows}

【当前场景】
${sceneSummary}

【TA 与在场对手戏角色的关系】
${relevantRelsBlock}

请基于以上具体信息生成入场前奏 JSON。hero_line 必须能让人一眼看出这一场和别场不一样。直接输出 JSON。`;

    try {
      const result = await ai.chat({
        task: 'chat',
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 500,
        temperature: 0.8,
      });
      const txt = String(result?.text || '').trim();
      const parsed = parseRoleplayIntroJSON(txt);
      if (!parsed) {
        return res.status(500).json({
          error: 'llm returned non-JSON',
          raw: txt.slice(0, 300),
        });
      }
      // 命中负面词库：当作模板生成失败处理，让前端走"无前奏"路径，
      // 而不是把模板硬塞回画面 —— 这正是这次重构要避免的事。
      const violation =
        containsBannedOverlayPhrase(parsed.hero_line) ||
        containsBannedOverlayPhrase(parsed.prompt_line) ||
        parsed.suggested_questions.some(containsBannedOverlayPhrase);
      if (violation) {
        return res.status(422).json({
          error: 'llm output violates anti-template constraints',
          raw_payload: parsed,
        });
      }
      // sub_line 兜底为静态身份（不会触发模板味，因为它就是事实标签）
      if (!parsed.sub_line && shortIdentity) {
        parsed.sub_line = `${displayName}｜${shortIdentity}`.slice(0, 30);
      }
      res.json({
        ...parsed,
        episode,
        character_id: characterId,
        display_name: displayName,
      });
    } catch (err) {
      console.error('[roleplay/intro] error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ─── 共谋者 · 玩家选项生成（Disco Elysium 风格） ─────────────────
  // NPC 说完一句之后，给玩家（默认扮演雷尼拉）生成 3 条**立场互不相同**的回应选项。
  // 文案锚定：roleplay.json 里的 sample_quotes_zh（从《血与火》原文 / 剧集摘出来的语气样本）
  // + speech_pattern_zh + core_traits_zh，确保口吻贴原作。
  app.post('/api/agent/roleplay/choices', async (req, res) => {
    const { videoId, t, characterId, lastNpcReply, history, playerId } = req.body || {};
    if (!characterId || !lastNpcReply) {
      return res.status(400).json({ error: 'characterId + lastNpcReply required', options: [] });
    }
    // dialogue 任务：默认 gemini-2.5-flash，openai 兜底
    if (!ai.isAvailable('dialogue') && !ai.isAvailable('chat')) {
      return res.status(503).json({ error: 'no llm available', options: [] });
    }
    const dialogueTask = ai.isAvailable('dialogue') ? 'dialogue' : 'chat';

    const kb = videoId ? loadKB(videoId) : null;
    const showId = kb?.show_id || 'house-of-the-dragon';
    const episode = kb ? resolveEpisode(kb) : null;
    const cursorTime = normalizeTime(t);
    const scene = kb ? currentScene(kb, cursorTime) : null;
    const db = getCharacterDb(showId);

    const npcCard = db ? charactersLib.findCharacter(db, characterId) : null;
    const npcName = npcCard?.display_name_zh || npcCard?.canonical_name || characterId;

    // 主角（玩家扮演的人）—— 默认雷尼拉，可由前端 playerId 覆盖
    const heroId = playerId || 'rhaenyra_targaryen';
    const heroProfile = charactersLib.lookupRoleplayProfile(showId, heroId, episode);
    const heroCard = db ? charactersLib.findCharacter(db, heroId) : null;
    const heroName = heroCard?.display_name_zh || heroId;

    // 当前 cursor 下 hero ↔ npc 的关系（如果有）
    const heroNpcRel = (() => {
      if (!db || !db.relationships) return null;
      for (const r of db.relationships) {
        const ok = (r.source === heroId && r.target === characterId) ||
                   (r.source === characterId && r.target === heroId);
        if (!ok) continue;
        const cur = charactersLib.currentEntry(r.timeline, episode);
        if (cur) return cur.relation_zh || cur.relation_en;
      }
      return null;
    })();

    const sceneFact = scene?.plot?.fact ? `场景：${String(scene.plot.fact).slice(0, 200)}` : '';
    const heroQuotes = heroProfile?.sample_quotes_zh?.length
      ? heroProfile.sample_quotes_zh.map(q => `「${q}」`).join('\n')
      : '（无样本）';
    const heroTraits = (heroProfile?.core_traits_zh || []).join('、') || '（无）';
    const heroSpeech = heroProfile?.speech_pattern_zh || '（无）';
    const histLines = (Array.isArray(history) ? history.slice(-4) : [])
      .map(h => `${h.role === 'user' ? heroName : (h.who || npcName)}：${String(h.text || '').slice(0, 200)}`)
      .join('\n');

    const system = `你是 ${heroName} 的"对白选项 Agent"，灵感取自《极乐迪斯科 Disco Elysium》的对话选项。

任务：${npcName} 刚说了一句话。给玩家（扮演 ${heroName}）生成 **3 条** 回应选项，每条立场不同、口吻像 ${heroName} 真的会说。

═══ ${heroName} 的语气样本（来自《血与火》原文 / 剧集；必须模仿，不要凭空生造）═══
${heroQuotes}

═══ ${heroName} 的核心性格 ═══
${heroTraits}

═══ ${heroName} 的说话方式 ═══
${heroSpeech}

═══ 此刻 ${heroName} 与 ${npcName} 的关系 ═══
${heroNpcRel || '（关系未明确记录，沿用一般贵族对待方式）'}

═══ 立场分类（3 条选项必须**立场互不相同**） ═══
- 王者：以王座继承人的威严回应；冷、短、不解释、不让步
- 审慎：不正面回答；用反问 / 旁敲侧击拖时间
- 血亲：动情；提及童年、父亲、亲缘、旧日情谊
- 挑衅：把话踢回去；让对方不舒服；带刺
- 政治：暗示利益、谈条件、拉关系
- 火焰：抑制不住的怒；坦格利安血气
- 沉默：不发声，只描述一个动作（"她不答"、"她转过身去"）—— text 必须是动作描述，不带引号

═══ 技能检定（**最多 1 条**选项可加；多数选项不需要） ═══
若选项是高风险（说错对方会立刻翻脸 / 暴露立场 / 改变格局），加一个检定：
{ "skill": "威严"|"王朝史"|"龙血"|"共情"|"韬光", "value": 6-18, "difficulty": "简单"|"中等"|"困难" }
- value < 9 → "简单"，9-13 → "中等"，> 13 → "困难"
- "威严"：用王座继承人身份压人；"王朝史"：引用先王或家族旧事；"龙血"：直觉/血脉；"共情"：读懂对方未说的；"韬光"：藏起真实情绪
- 大多数日常对白不加检定。每次最多给 1 条带检定的选项。

═══ 严格输出 JSON ═══
{
  "options": [
    {
      "stance": "王者" | "审慎" | "血亲" | "挑衅" | "政治" | "火焰" | "沉默",
      "tag": "**这一句**的 2-4 字动作/意图总结，绑定当前剧情，不要复用立场名",
      "text": "≤ 38 字。中文。'沉默'立场是动作描述不带引号；其余可带引号"…"。",
      "skill_check": null | { "skill": "...", "value": 数字, "difficulty": "..." }
    },
    { ... },
    { ... }
  ]
}

═══ tag 字段重点说明（**最重要**） ═══
tag 是显示在选项前的标签，必须是**这一句话当下要做的事**，不是抽象立场名。
- ❌ 不要："王者" "审慎" "血亲" 这种和 stance 重复的词
- ❌ 不要："雄辩" "智慧" 这种空洞抽象词
- ✅ 要：紧贴此刻情境的具体动作 / 意图，2-4 字
  - 例：${npcName} 在劝你低头 → "回敬" / "讨饶" / "撤话题" / "戳痛处"
  - 例：${npcName} 在打听机密 → "搪塞" / "套话回去" / "冷脸" / "假装糊涂"
  - 例：${npcName} 在挑衅 → "压火" / "回刀" / "让一步" / "翻旧账"
- 长度 2-4 个汉字；3 条选项的 tag 必须互不相同

约束：
- 必须 3 条；stance 互不相同；tag 互不相同
- text 是中文，长度 ≤ 38 字，必须像 ${heroName} 会说出口的（参考语气样本）
- 不要复述 ${npcName} 的话；不要写舞台指示（除"沉默"立场外不要写动作）
- 不要旁白、不要解释、不要 markdown、不要 \`\`\`
- 直接输出 JSON 对象`;

    const user = `【剧集】${episode || '未知'}
【对面是】${npcName}${npcCard?.short_identity_zh ? `（${npcCard.short_identity_zh}）` : ''}
${sceneFact}

${histLines ? '【最近对话】\n' + histLines + '\n' : ''}
【${npcName} 刚刚说】${String(lastNpcReply).slice(0, 400)}

请基于以上，给玩家（扮演 ${heroName}）生成 3 条回应选项。直接输出 JSON。`;

    try {
      const result = await ai.chat({
        task: dialogueTask,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 520,
        temperature: 0.9,
      });
      const txt = String(result?.text || '').trim();
      let parsed = null;
      const i = txt.indexOf('{');
      const j = txt.lastIndexOf('}');
      if (i !== -1 && j > i) {
        try { parsed = JSON.parse(txt.slice(i, j + 1)); } catch { parsed = null; }
      }
      const ALLOWED_STANCE = ['王者','审慎','血亲','挑衅','政治','火焰','沉默'];
      const ALLOWED_SKILL = ['威严','王朝史','龙血','共情','韬光'];
      const ALLOWED_DIFF = ['简单','中等','困难'];

      const raw = Array.isArray(parsed?.options) ? parsed.options : [];
      const seen = new Set();
      const seenTags = new Set();
      const clean = [];
      for (const o of raw) {
        const stance = ALLOWED_STANCE.includes(o?.stance) ? o.stance : null;
        if (!stance || seen.has(stance)) continue;
        const text = String(o?.text || '').trim().slice(0, 80);
        if (!text) continue;
        // tag：动态总结词组（绑剧情）；如果模型把 tag 写成了和 stance 一样，丢弃，让前端 fallback 显示
        let tag = String(o?.tag || '').trim();
        // 去掉可能带的方括号 / 引号 / 标点
        tag = tag.replace(/^[\[【「『"'\s]+|[\]】」』"'\s]+$/g, '').slice(0, 6);
        if (!tag || tag === stance || ALLOWED_STANCE.includes(tag)) tag = null;
        if (tag && seenTags.has(tag)) tag = null;        // 同轮 tag 不能撞
        let skill_check = null;
        if (o?.skill_check && typeof o.skill_check === 'object') {
          const sk = ALLOWED_SKILL.includes(o.skill_check.skill) ? o.skill_check.skill : null;
          const val = Number(o.skill_check.value);
          const dif = ALLOWED_DIFF.includes(o.skill_check.difficulty) ? o.skill_check.difficulty : null;
          if (sk && Number.isFinite(val) && val > 0 && val < 30 && dif) {
            skill_check = { skill: sk, value: Math.round(val), difficulty: dif };
          }
        }
        clean.push({ stance, tag, text, skill_check });
        seen.add(stance);
        if (tag) seenTags.add(tag);
        if (clean.length >= 3) break;
      }

      res.json({
        options: clean,
        hero_id: heroId,
        hero_name: heroName,
        hero_npc_relation: heroNpcRel,
        source: result?.source,
        model: result?.model,
      });
    } catch (err) {
      console.error('[roleplay/choices] error:', err.message);
      res.status(500).json({ error: err.message, options: [] });
    }
  });

  // ─── 共谋者 · 角色对谈 · 玩家内心声音（DE 风格）────────────────
  // 一次 turn 完成（玩家说了什么 + 角色回答了什么）后，前端调用本 endpoint
  // 拉 1-3 条"玩家内心声音"行（LOGIC / EMPATHY / INLAND EMPIRE 等），
  // 用于在 DE 风格面板里把"角色台词"与"玩家自己的直觉/分析"分色显示。
  // 这是 PLAYER 视角，不是角色视角；与 chat/stream 的 roleplay 严格分离。
  app.post('/api/agent/roleplay/voices', async (req, res) => {
    const { videoId, t, characterId, userQuestion, characterReply } = req.body || {};
    if (!characterId || !userQuestion || !characterReply) {
      return res.status(400).json({ error: 'characterId + userQuestion + characterReply required' });
    }
    if (!ai.isAvailable('chat')) {
      return res.status(503).json({ error: 'no llm available' });
    }
    const kb = videoId ? loadKB(videoId) : null;
    const showId = kb?.show_id || 'house-of-the-dragon';
    const episode = kb ? resolveEpisode(kb) : null;
    const cursorTime = normalizeTime(t);
    const scene = kb ? currentScene(kb, cursorTime) : null;
    const db = getCharacterDb(showId);
    const dbCard = db ? charactersLib.findCharacter(db, characterId) : null;
    const displayName = dbCard?.display_name_zh || dbCard?.canonical_name || characterId;

    const system = `你是 PLAYER 的内心声音 Agent —— 严格按《极乐迪斯科 Disco Elysium》skill voices 的语言密度来写。

任务：玩家刚刚和 ${displayName} 完成了一次对话交换。给玩家脑内浮出 2-3 条"内心声音"。
**不是 ${displayName} 的话**，**不是旁白**，是玩家脑内此刻自己人格 / 直觉 / 感官的具象化发言。

═══ DE 风的关键写法（必读，出错就毁了）═══
每条声音不是一句干巴巴的判断，而是一段 30-60 字的小独白，要包含：
1. **一个具体的感官锚点**（一个动作 / 一个停顿 / 一个声音 / 一处眼神 / 一缕光），不要凭空说
2. **一句基于这个锚点的小推论或感受**
3. 必要时再带一个"反问 / 自问 / 不安"的尾调

像：
- LOGIC："她答得太快了。三秒，没有停顿。一个真正在权衡的人不会答这么快——这是事先准备好的措辞。"
- EMPATHY："她下颌的肌肉在收紧。这不是不耐烦，是某种比那更深的东西——你见过你父亲在听到坏消息时也是这样。"
- INLAND EMPIRE："你忽然闻到一股蜡烛的味道。不是这间屋子的，是别处的，多年以前的。这场对话似曾相识。"
- AUTHORITY："你是龙石岛公主。她是王后。这屋子里只有两个比她位阶更高的人，其中一个是你父王，另一个就是你自己。"
- ESPRIT DE CORPS："此刻全城贵族都在用各自的方式赌一件事——她父亲会赢，还是你父亲会让步。她知道这个赌局，你也知道。"

不要写成："她在试探你" / "你要小心" / "她有所隐瞒" —— 这种是干瘪的判断，不是声音。

═══ 可选声音（挑 2-3 条最契合此刻的，**不能重复**）═══
- LOGIC（逻辑）：纯推理 / 矛盾 / 时间感 / 因果
- EMPATHY（共情）：从微表情 / 语气 / 沉默里读出对方真正在感觉什么
- AUTHORITY（权威）：地位差 / 谁能压谁 / 这屋子里的权力地图
- VOLITION（意志）：你的底线 / 你该不该让步 / 这句话出口意味着什么
- SUGGESTION（暗示）：这话该怎么追、怎么撬、怎么转向
- COMPOSURE（镇定）：你脸上 / 手上 / 呼吸有没有露馅
- PERCEPTION（感知）：屋里某个被忽略的物件 / 声响 / 光线
- INLAND EMPIRE（内陆帝国）：梦境式 / 莫名其妙的预感 / 童年片段闪回 / 通感
- ESPRIT DE CORPS（群体感）：宫廷 / 家族 / 王朝这个集体此刻在想什么、传什么风声

═══ 严格输出 JSON ═══
{
  "voices": [
    { "voice": "EMPATHY", "text": "30-60 字的中文段落。一段小独白，不是一句判断。" },
    { "voice": "LOGIC",   "text": "30-60 字。" },
    { "voice": "INLAND EMPIRE", "text": "30-60 字。" }
  ]
}

约束：
- 2-3 条；voice 互不重复；voice 必须是上面九种之一的英文大写名
- text 是中文段落，30-60 字理想，最长不超过 80 字；不要标点开头、不带 markdown
- 至少有 1 条要包含一个具体的感官锚点（动作 / 神情 / 声音 / 物件）
- 不要复述 ${displayName} 的台词字面；不要给"你接下来该说 X"这类建议
- 不要旁白口吻；保持"我脑子里有声音"的第二人称（你/我，不是 TA）
- 直接输出 JSON 对象`;

    const sceneLine = scene?.plot?.fact ? `场景：${scene.plot.fact}` : '';
    const user = `【剧集】${episode || '未知'}
【对谈对象】${displayName}
${sceneLine}

【玩家刚说】${String(userQuestion).slice(0, 200)}
【${displayName} 回答】${String(characterReply).slice(0, 300)}

请基于这次交换，给出玩家此刻脑内的 1-3 条内心声音。直接输出 JSON。`;

    // dialogue 任务：默认 gemini-2.5-flash，openai 兜底（与 /choices 一致）
    const voicesTask = ai.isAvailable('dialogue') ? 'dialogue' : 'chat';
    try {
      const result = await ai.chat({
        task: voicesTask,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 700,
        temperature: 0.95,
      });
      const txt = String(result?.text || '').trim();
      let parsed = null;
      const i = txt.indexOf('{');
      const j = txt.lastIndexOf('}');
      if (i !== -1 && j > i) {
        try { parsed = JSON.parse(txt.slice(i, j + 1)); } catch { parsed = null; }
      }
      const voices = Array.isArray(parsed?.voices) ? parsed.voices : [];
      const ALLOWED = new Set([
        'LOGIC','EMPATHY','AUTHORITY','VOLITION','SUGGESTION',
        'COMPOSURE','PERCEPTION','INLAND EMPIRE','ESPRIT DE CORPS',
      ]);
      // 清洗：voice 不重复；text 长度 12-120 字（太短的是干判断，淘汰）
      const seen = new Set();
      const clean = [];
      for (const v of voices) {
        const voice = String(v?.voice || '').trim().toUpperCase();
        const text = String(v?.text || '').trim().slice(0, 120);
        if (!voice || !ALLOWED.has(voice) || seen.has(voice)) continue;
        if (text.length < 12) continue;     // 短句一笔带过的，不是 DE 风，丢
        clean.push({ voice, text });
        seen.add(voice);
        if (clean.length >= 3) break;
      }
      res.json({ voices: clean, source: result?.source, model: result?.model });
    } catch (err) {
      console.error('[roleplay/voices] error:', err.message);
      // 软失败：返回空数组，前端不显示内心声音也能正常工作
      res.json({ voices: [], error: err.message });
    }
  });

  // ─── 共谋者 · 机制 A · 字幕旁白 cue 生成 ─────────────────────
  // 当分支点抵达时，前端要在画面底部浮一句旁白。这一句让 Gemini 按场景情绪
  // 现写，不写死。生成结果按 branch_id 内存缓存，同一个分支只走一次 LLM。
  app.get('/api/agent/branch/cue', async (req, res) => {
    const { videoId, branchId } = req.query;
    const kb = videoId ? loadKB(videoId) : null;
    if (!kb) return res.status(404).json({ error: 'no kb' });
    const bp = (kb.branch_points || []).find(b => b.branch_id === branchId);
    if (!bp) return res.status(404).json({ error: 'no branch' });

    if (BRANCH_CUE_CACHE.has(bp.branch_id)) {
      return res.json({ ...BRANCH_CUE_CACHE.get(bp.branch_id), cached: true });
    }

    if (!ai.isAvailable('chat')) {
      const fb = staticCueFallback(bp);
      return res.json({ ...fb, cached: false, fallback: true });
    }

    const system = `你为 HBO 《龙之家族》（House of the Dragon）写两行字幕旁白，将出现在画面底部 —— 像葛尔丹学士的卷宗在对观众低语。
观众即将面对一个改变剧情的选择，但你**不能透露任何具体事件、人物、动作**。

【写作笔触：西方史诗奇幻译制风】
模仿乔治·R·R·马丁《冰与火之歌》《血与火》及 HBO 字幕的中文译笔。
不是中国仙侠/武侠。不是网文。不是文言文。
是冷峻、宿命感、权力的代价、学士修史的口吻。

【可以用的词库（维斯特洛意象）】
学士、鹅毛笔、史书、史册、卷宗、留白、史页、誓言、箴言、渡鸦、诸神、命运（节制使用）、刀、剑、王座、火、影、风、烛火、羊皮纸、沉默

【禁用词（一律不要）】
- 中国古风：汝、卷至此、其一其二、由是、既此一笔、合卷、汝之、毋、岂
- 仙侠味：苍生、天道、轮回、众生、红尘
- UI 化：分支、选项、介入、按钮、请、点击；第二行不要用"你能 X"，要用"由你 X""换你 X""你愿 X 吗"等含蓄邀请
- 总结大词：人生、改写历史、抉择
- 任何角色姓名（雷尼拉/戴蒙/阿丽森/克里斯顿/韦赛里斯/任何家族名）
- 任何具体事件（婚礼/私奔/礼服/王冠/比武/龙/铁王座 ……）

【风格要求】
- 第二人称对观众说话："你"
- 用一个**具体而隐晦的维斯特洛意象**做载体（学士的笔尚未落下、渡鸦未飞、刀未出鞘、誓言未出口、风掠过羊皮纸 ……）
- 一行不超过 20 字，**短而有重量**
- 不要俗套、不要劝人、不要总结、不要解释

【格式（严格）】
两行：
- 第一行 10-18 字：克制的状态/事实/意象。
- 第二行 5-12 字：含蓄的邀请。

【优秀示例（仅供把握质地，不要照抄）】
- "学士的鹅毛笔停在这一行上。" / "由你来填这格留白。"
- "渡鸦还没飞出窗。" / "你愿换它去哪？"
- "刀还没出鞘。" / "由你让它别出来。"
- "誓言已到唇边，未出口。" / "你愿替他说出口吗？"
- "诸神在这一秒掷出了硬币。" / "落地之前，由你来定。"
- "史书的这一行还是空的。" / "你愿落这第一笔吗？"

输出严格 JSON：{"headline":"第一行","sub":"第二行"}
不要任何前后说明、不要 markdown、不要 \`\`\`。`;

    const user = `当前决策点的氛围（仅供你抓情绪，不能写进字幕）：
${bp.description || '（无具体描述）'}

请生成 cue。直接输出 JSON。`;

    try {
      const result = await ai.chat({
        task: 'chat',
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 200,
        temperature: 0.95,
      });
      const txt = String(result?.text || '').trim();
      const parsed = parseCueJSON(txt);
      if (parsed) {
        BRANCH_CUE_CACHE.set(bp.branch_id, parsed);
        return res.json({ ...parsed, cached: false });
      }
      // 解析失败 → fallback
      const fb = staticCueFallback(bp);
      return res.json({ ...fb, cached: false, fallback: true, raw: txt.slice(0, 200) });
    } catch (err) {
      console.error('[branch/cue] LLM err:', err.message);
      const fb = staticCueFallback(bp);
      return res.json({ ...fb, cached: false, fallback: true, error: err.message });
    }
  });

  // ─── 共谋者 · 机制 A：分支推演 ─────────────────────────────────
  // 列出当前 KB 标注好的「关键决策点」，前端用它在播放时间轴上提示。
  app.get('/api/agent/branch/list', (req, res) => {
    const { videoId } = req.query;
    const kb = videoId ? loadKB(videoId) : null;
    if (!kb) return res.json({ branch_points: [] });
    const points = (kb.branch_points || []).map(bp => ({
      branch_id: bp.branch_id,
      timestamp: bp.timestamp,
      label: bp.label,
      decision_holder_display: bp.decision_holder_display,
      description: bp.description,
      options: bp.options,
    }));
    res.json({ episode: resolveEpisode(kb), branch_points: points });
  });

  // 流式生成「替代世界线」。Prompt 严格按 V2 PRD §4.3 模板。
  app.post('/api/agent/branch/simulate', async (req, res) => {
    const { videoId, branchId, choice } = req.body || {};
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const kb = videoId ? loadKB(videoId) : null;
    if (!kb) {
      send('text', { delta: '当前视频还没有标注分支点。' });
      send('done', { source: 'error' });
      return res.end();
    }
    const bp = (kb.branch_points || []).find(b => b.branch_id === branchId);
    if (!bp) {
      send('text', { delta: '未找到对应的分支点。' });
      send('done', { source: 'error' });
      return res.end();
    }
    const userChoice = String(choice || '').slice(0, 280).trim();
    if (!userChoice) {
      send('text', { delta: '需要先做出一个选择。' });
      send('done', { source: 'error' });
      return res.end();
    }

    if (!ai.isAvailable('chat')) {
      send('text', { delta: '当前没有可用的 LLM provider，分支推演只能在配置后运行。' });
      send('done', { source: 'error' });
      return res.end();
    }

    const showName = kb.show_id === 'house-of-the-dragon' ? '《龙之家族》' : `《${kb.title || kb.video_id}》`;
    const episode = resolveEpisode(kb) || '';
    const ts = bp.timestamp;
    const tsLabel = `${Math.floor(ts / 60)}:${String(Math.floor(ts % 60)).padStart(2, '0')}`;

    const system = `你是 HBO ${showName} 编剧组的成员。你的任务是为观众生成一份"假设性叙事"——在原剧的某一个决策点上，观众替角色做了不同的选择，你把"那个世界线"写出来。

═══ 硬性原则 ═══
1. 严格遵循乔治·R·R·马丁的世界观、维斯特洛的政治逻辑、家族纹章与阵营、坦格利安王朝的内部矛盾。
2. 必须有戏剧张力——不要让结果太顺利，权力博弈从来都有代价。
3. 角色行为必须符合各自人格：戴蒙不会突然温柔、阿丽森不会突然真诚、克里斯顿压抑后会爆发。
4. 不要剧透原剧后续真实剧情——你写的是"如果，那么"的虚构世界线。
5. 全文严格控制在 400 字以内（中文计）。

═══ 输出格式（严格） ═══
分 3-5 段，每段是「场景描述 + 一两句关键对白」。最后一段以「⏵ 后续推演」开头，简要预测随后 1-3 集会发生的连锁反应（不超过 3 行）。

不要写"作为编剧"、不要做免责声明、不要解释自己在做什么。直接进入第一段场景。`;

    const user = `【原剧位置】${episode} · ${tsLabel}
【分支事件】${bp.label}
【决策方】${bp.decision_holder_display}
【原始情境】${bp.description}
【背景】${bp.context_for_llm || '（无）'}

【用户的选择】${userChoice}

请生成"用户世界线"的 60 秒剧情。`;

    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
      let providerInfo = null;
      const stream = ai.chatStream({
        task: 'chat',
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 700,
        temperature: 0.85,
        signal: controller.signal,
      });
      for await (const chunk of stream) {
        if (chunk.type === 'meta') { providerInfo = { provider: chunk.provider, model: chunk.model }; continue; }
        if (chunk.type === 'text' && chunk.delta) send('text', { delta: chunk.delta });
      }
      send('done', {
        source: 'llm',
        branch_id: branchId,
        episode,
        provider: providerInfo?.provider || null,
        model: providerInfo?.model || null,
      });
      res.end();
    } catch (err) {
      if (controller.signal.aborted) return res.end();
      console.error('[branch] simulate error:', err.message);
      send('text', { delta: '推演失败：' + err.message });
      send('done', { source: 'error' });
      res.end();
    }
  });

  // 列出当前 KB 在当前 episode 下，哪些角色支持 roleplay 对谈。
  // 前端用它在 bbox 热点上加「💬 可对谈」标识。
  // 传 t（秒）时还会标注 in_scene：当前光标 ±30s 窗口内出场过的角色。
  app.get('/api/agent/roleplay/cast', (req, res) => {
    const { videoId, t } = req.query;
    const kb = videoId ? loadKB(videoId) : null;
    const showId = (kb && kb.show_id) || 'house-of-the-dragon';
    const episode = resolveEpisode(kb);
    const all = charactersLib.loadRoleplayProfiles(showId);
    if (!all || !all.profiles) return res.json({ episode, characters: [] });
    const db = getCharacterDb(showId);

    // 当前 ±30s 窗口里 agent 已标注的出场角色（来自 scene.characters[] / characters_on_screen[]）
    const cursorTime = (t !== undefined && t !== '') ? Number(t) : null;
    let presentIds = null; // null = 不过滤（兼容老调用：没传 t 就当全部都在场）
    if (kb && Number.isFinite(cursorTime)) {
      const WINDOW = 30;
      const lo = cursorTime - WINDOW;
      const hi = cursorTime + WINDOW;
      presentIds = new Set();
      for (const sc of (kb.scenes || [])) {
        const s = sc.start_time, e = sc.end_time;
        if (s == null || e == null) continue;
        if (e < lo || s > hi) continue;
        for (const c of (sc.characters || [])) if (c?.id) presentIds.add(c.id);
        for (const c of (sc.characters_on_screen || [])) if (c?.character_id) presentIds.add(c.character_id);
      }
    }

    const characters = Object.keys(all.profiles).map(cid => {
      const profile = all.profiles[cid];
      const dbEntry = db ? charactersLib.findCharacter(db, cid) : null;
      const hasBoundaryForEpisode = !!(profile.info_boundary_per_episode && episode && profile.info_boundary_per_episode[episode]);
      return {
        character_id: cid,
        display_name: dbEntry?.display_name_zh || dbEntry?.canonical_name || cid,
        short_identity: dbEntry?.short_identity_zh || null,
        house: dbEntry?.house || null,
        ready_for_episode: hasBoundaryForEpisode,
        in_scene: presentIds ? presentIds.has(cid) : true,
      };
    });

    res.json({ episode, show_id: showId, characters, cursor_time: cursorTime });
  });

  // Symbol hotspots：按 cursor time 返回当前 scene 的 symbols（含 bbox + 词典 meaning + deep_reading）
  // 前端用来在画面上叠加可点击的剧情符号热点。
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
        category: dict.category || null,
        meaning_zh: sym.meaning_zh || dict.meaning_zh || null,
        viewer_takeaway: sym.viewer_takeaway || dict.viewer_takeaway || null,
        // 单符号自带的 deep_reading（agent 生成的）；前端会优先用它，回落到 scene.plot.deep_reading
        deep_reading: sym.deep_reading || null,
        source: sym.source || null,
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
}

module.exports = { register };
