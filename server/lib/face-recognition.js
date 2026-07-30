// 人脸识别：Gemini Pro 视觉识别（唯一路径）。
// 之前的 ArcFace/deepface 闭集服务已下线——库内特征向量不可分（53 张真实帧只认出 4 张，
// 44 张坍缩到同一身份），全量切到多模态 LLM 识别。
// agent.js 的 /recognize 端点和 scripts/eval 的③评测都走这同一个函数。
const ai = require('./ai');
const charactersLib = require('./characters');

function bboxOverlapHigh(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) return false;
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const min = Math.min(areaA, areaB);
  return min > 0 && inter / min > 0.5;
}

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

function isAvailable() {
  return ai.isAvailable('face_recognition');
}

async function recognizeFaces({ image, db, cursor, recognitionContext }) {
  if (!isAvailable()) return null;

  const contextIds = new Set(recognitionContext?.candidate_character_ids || []);
  const knownChars = db ? (db.characters || []).map(c => ({
    character_id: c.character_id,
    display_name_zh: c.display_name_zh,
    short_identity_zh: c.short_identity_zh,
    house: c.house,
  })) : [];

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
    task: 'face_recognition',
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

module.exports = { recognizeFaces, isAvailable, bboxOverlapHigh };
