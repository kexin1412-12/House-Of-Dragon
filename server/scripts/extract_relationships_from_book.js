#!/usr/bin/env node
/**
 * extract_relationships_from_book.js
 *
 * 输入：references/blood-and-fire.md（原文）
 * 输出：kb/characters/extracted/<source>.relationships.json
 *
 * 用 Gemini 长上下文（默认 gemini-2.5-flash，1M ctx）抽取人物 + 关系。
 * 严格按 cursor 边界过滤——只保留 from_episode <= target_cursor 的关系。
 *
 * 不直接覆盖 kb/characters/house-of-the-dragon.json；需要单独跑
 * merge_extracted_relationships.js 审查后合并。
 *
 * 用法：
 *   node scripts/extract_relationships_from_book.js \
 *     --source references/blood-and-fire.md \
 *     --target-cursor S01E05 \
 *     --out kb/characters/extracted/blood-and-fire.relationships.json
 *
 * 可选：
 *   --max-chunk-chars 400000   # 单 chunk 上限（默认 400k 中文字 ~ 500k tokens）
 *   --dry-run                  # 只 print 抽取计划，不调 LLM
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');
const { PDFParse } = require('pdf-parse');

// ─── CLI ─────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv);
const SERVER_ROOT = path.join(__dirname, '..');

// --source 可以是 .md / .txt / .pdf。没指定时按优先级查 references/blood-and-fire.{pdf,md,txt}
function autoResolveSource() {
  if (args.source) return args.source;
  const candidates = ['references/blood-and-fire.pdf', 'references/blood-and-fire.md', 'references/blood-and-fire.txt'];
  for (const c of candidates) {
    if (fs.existsSync(path.resolve(SERVER_ROOT, c))) return c;
  }
  return 'references/blood-and-fire.md'; // 留默认让 loadSource 报错
}
const sourcePath = autoResolveSource();
const targetCursor = args['target-cursor'] || 'S01E05';
const outPath = args.out || `kb/characters/extracted/${path.basename(sourcePath).replace(/\.[^.]+$/, '')}.relationships.json`;
// 默认 150k chars/chunk —— 经验值：Gemini 2.5 Flash 输出约 65k tokens 上限，
// 输入超过 200k 中文字时输出 JSON 容易截断。
const maxChunkChars = parseInt(args['max-chunk-chars'] || '150000', 10);
// 默认只读 PDF 前 290 页（HotD S01E05 = 约 112 AC，对应这本中译版 290 页前的内容）。
// 0 或负数 = 不限制。
const maxSourcePages = parseInt(args['max-source-pages'] || '290', 10);
const dryRun = !!args['dry-run'];

// 把 cursor 映射到《血与火》书中的年份（AC = After Aegon's Conquest）
// HotD S01 大致覆盖 103 AC（韦赛里斯继位）到 129 AC（韦赛里斯死、龙舞开始）
const CURSOR_TO_BOOK_YEAR = {
  'pre-S01': 100, // 杰赫里斯一世晚年
  'S01E01': 105,  // 韦赛里斯继位、雷尼拉被立为继承人
  'S01E02': 106,  // 阿丽森特入宫、戴蒙夺龙石岛
  'S01E03': 110,  // 雷尼拉满 17 岁、议会逼婚
  'S01E04': 111,  // 雷尼拉&戴蒙的丝绸街事件
  'S01E05': 112,  // 雷尼拉婚礼（绿礼服 + 克里斯顿提议私奔）
  'S01E06': 120,  // 时间跳跃：雷尼拉孩子们已出生
  'S01E07': 120,  // 雷娜拉葬礼、艾蒙夺龙
  'S01E08': 129,  // 韦赛里斯临终、王座之争开端
  'S01E09': 129,  // 伊耿二世加冕、绿党政变
  'S01E10': 129,  // 卢克之死、龙舞正式开打
};
function cursorToYear(cursor) {
  return CURSOR_TO_BOOK_YEAR[cursor] || 112;
}
const targetYear = cursorToYear(targetCursor);

const sourceAbs = path.resolve(SERVER_ROOT, sourcePath);
const outAbs = path.resolve(SERVER_ROOT, outPath);

// ─── 读源文件并切片 ───────────────────────────────────────────
async function loadSource() {
  if (!fs.existsSync(sourceAbs)) {
    console.error(`[err] source not found: ${sourceAbs}`);
    process.exit(1);
  }
  const ext = path.extname(sourceAbs).toLowerCase();

  if (ext === '.pdf') {
    console.log(`[extract] parsing PDF ...`);
    const buffer = fs.readFileSync(sourceAbs);
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const totalPages = result.pages?.length || 0;
    if (!totalPages) {
      console.error(`[err] PDF parser returned no pages. Maybe scanned/image PDF? Try OCR first.`);
      process.exit(1);
    }
    // 截到前 N 页（pdf-parse 的 last:N 选项不生效，自己切）
    const usePages = (maxSourcePages > 0)
      ? result.pages.slice(0, Math.min(maxSourcePages, totalPages))
      : result.pages;
    // 重新拼回带页标的文本，方便 LLM 看到页码
    const text = usePages
      .map(p => `\n-- ${p.num} of ${totalPages} --\n\n${p.text || ''}`)
      .join('\n')
      .trim();
    if (text.length < 1000) {
      console.error(`[err] PDF parsed but text < 1000 chars (${text.length}). Maybe scanned/image PDF? Try OCR first.`);
      process.exit(1);
    }
    console.log(`[extract] PDF text extracted: ${text.length} chars from ${usePages.length}/${totalPages} pages (--max-source-pages=${maxSourcePages})`);
    return text;
  }

  // text / markdown 路径
  const raw = fs.readFileSync(sourceAbs, 'utf8');
  // 占位符保护（仅对 .md 模板，PDF 没这个问题）
  if (raw.length < 1000 || raw.includes('(原文待粘贴')) {
    console.error(`[err] source file looks like a placeholder. Paste 血与火 原文 into ${sourcePath}, or drop a .pdf into references/.`);
    process.exit(1);
  }
  // 去掉 README 头部，只保留 --- 分隔线之后到下一 --- 之前的内容
  const segs = raw.split(/^---\s*$/m);
  const body = segs.length >= 3 ? segs.slice(1, -1).join('\n---\n') : raw;
  return body.trim();
}

function chunkByChapters(text, maxChars) {
  // 按 ## 章节切；如果没有 ## 标记，就按定长切
  const chapterRe = /^##\s+.*$/m;
  const hasChapters = chapterRe.test(text);
  let chunks;
  if (hasChapters) {
    const lines = text.split('\n');
    const groups = [];
    let cur = [];
    for (const line of lines) {
      if (/^##\s/.test(line) && cur.length) { groups.push(cur.join('\n')); cur = []; }
      cur.push(line);
    }
    if (cur.length) groups.push(cur.join('\n'));
    chunks = groups;
  } else {
    chunks = [];
    for (let i = 0; i < text.length; i += maxChars) chunks.push(text.slice(i, i + maxChars));
  }
  // 把过长的 chapter 再切
  const out = [];
  for (const c of chunks) {
    if (c.length <= maxChars) out.push(c);
    else for (let i = 0; i < c.length; i += maxChars) out.push(c.slice(i, i + maxChars));
  }
  return out;
}

// ─── Gemini 抽取 ────────────────────────────────────────────
const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          character_id: { type: 'string' },         // snake_case 唯一 id
          canonical_name: { type: 'string' },       // 英文原名
          display_name_zh: { type: 'string' },      // 中文译名
          short_identity_zh: { type: 'string' },    // 中文一句话身份
          house: { type: 'string' },                // 家族（英文姓）
          first_mentioned_episode: { type: 'string' }, // 第一次在 S01 哪集出场，"pre-S01" 表示开局已存在
        },
        required: ['character_id', 'canonical_name', 'display_name_zh'],
      },
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source_id: { type: 'string' },
          target_id: { type: 'string' },
          relation_zh: { type: 'string' },           // 中文：如 父女/夫妻/挚友/政治盟友/政治对立/暧昧/疏离
          relation_en: { type: 'string' },           // english kebab: parent-of/spouse/best-friend/...
          summary_zh: { type: 'string' },            // ≤40 字中文一句话摘要
          from_episode: { type: 'string' },          // 该关系状态从哪一集开始（"pre-S01" 表示开局即存在）
          to_episode: { type: 'string' },            // 该状态结束的集（""="尚未结束/到 cursor 仍有效"）
        },
        required: ['source_id', 'target_id', 'relation_zh', 'relation_en', 'summary_zh', 'from_episode'],
      },
    },
  },
  required: ['characters', 'relationships'],
};

const SYSTEM_PROMPT = (cursor, year) => `你是 HBO《龙之家族》关系图谱抽取 Agent。任务：从《血与火》原文里抽人物 + 人物关系，输出严格 JSON。

═══ 硬性时间边界（最重要，违反就重写） ═══
**目标节点 = ${cursor}，对应书中 ${year} AC（征服后第 ${year} 年）。**

只输出 **在 ${year} AC（含）之前已经成立** 的人物和关系。

判断方法（按这个顺序）：
1. 看《血与火》原文里事件的年份标注（例如 "103 AC"、"112 AC"） —— 大于 ${year} AC 的一律不要
2. 看章节归属：
   - "杰赫里斯一世晚年" / "大议会（Great Council）" / "韦赛里斯一世继位" / "继承之争" / "继承人之争" → **可以输出**
   - "龙舞战争" / "Dance of the Dragons" / "黑党 vs 绿党的全面战争" → **不要输出**
   - "Aegon III 摄政期" / "Aegon III 亲政" / "Aegon IV" / "Lysene Spring" / "Daughter's War" → **不要输出**

═══ 严禁出现的人物（这些都是 ${year} AC 之后才登场或出生的角色） ═══
看到这些名字，**整条关系都不要写进输出**：
- Aegon III / 伊耿三世（${year} AC 时仍是婴儿或未出生）
- Daenaera Velaryon / 戴安娜拉·瓦列利安
- Lara Rogare / 拉腊·罗佳尔
- Urwin Peck / 乌尔温·培克
- Elin Velaryon / 埃林·瓦列利安
- Baena Velaryon、Baenela Velaryon / 贝妮拉·瓦列利安
- Jaehaera / 杰赫妮拉·坦格利安
- Aegon IV / 伊耿四世（很久以后）
- Naerys / 奈丽丝（很久以后）
- 任何"Mushroom（蘑菇）侍奉伊耿三世"那段里仅当时段角色

═══ 重点要抽出来的人物（这些是 S01 主线角色） ═══
- Viserys I / 韦赛里斯一世
- Rhaenyra Targaryen / 雷尼拉·坦格利安（年轻版本，未结婚 / 刚嫁赖诺尔）
- Daemon Targaryen / 戴蒙·坦格利安（与第一任妻子瑞亚还在世或刚死时）
- Alicent Hightower / 阿丽森特·海塔尔（still queen，孩子还小）
- Otto Hightower / 奥托·海塔尔
- Aemma Arryn / 艾玛·艾林（已逝）
- Rhaenys Targaryen / 雷妮丝·坦格利安（"那位从未当上女王的女王"）
- Corlys Velaryon / 科利斯·瓦列利安（海蛇）
- Laenor Velaryon / 赖诺尔·瓦列利安
- Laena Velaryon / 雷娜·瓦列利安（${year} AC 时刚嫁戴蒙不久 —— 也可能尚未成婚，按年份判断）
- Criston Cole / 克里斯顿·科尔
- Harwin Strong / 哈文·斯壮
- Lyonel Strong / 莱昂诺·斯壮
- Larys Strong / 拉里斯·斯壮
- Mysaria / 米桑迪娅
- Rhea Royce / 瑞亚·罗伊斯
- Jaehaerys I / 杰赫里斯一世（已逝，但与雷尼拉的关系是"祖孙"，可以写）
- Aegon II / 伊耿二世（${year} AC 时是幼童 —— 可以写他作为阿丽森特之子，但不要剧透他将来争位）

═══ 关系约束 ═══
- from_episode 必须 ≤ ${cursor}（pre-S01 表示开局已存在，例如 "雷尼拉是韦赛里斯之女"是 pre-S01）
- 如果关系到 ${cursor} 仍有效，to_episode 留空字符串 ""
- 如果关系在 ${cursor} 之前已经结束（例如人物已死），to_episode 填结束的集
- 不要输出 ${cursor} 之后才发生的关系（如龙舞战争、某些角色的死亡、私生子真相揭露等）

═══ 输出原则 ═══
1. **character_id 用 snake_case**，例如 rhaenyra_targaryen, alicent_hightower, criston_cole
2. relation_en 用 kebab-case 标准词汇：
   parent-of / child-of / sibling-of / spouse / lover / former-lover / ally / enemy
   political-rival / friend / former-friend / mentor / sworn-protector / informant / vassal
3. relation_zh 简洁：父女 / 夫妻 / 兄弟 / 政治盟友 / 政治对立 / 挚友 / 关系疏离 / 暧昧 / 旧情人 / 御林铁卫
4. summary_zh ≤ 40 字，写关系**当下的具体性质**，不要写"她爱他"这种空话
5. 同一对 (source, target) 在不同时间点状态不同 → 输出多条，分别填 from_episode/to_episode
6. character 字段尽量补全 short_identity_zh（一句话身份）+ house + first_mentioned_episode

═══ 不要做的事 ═══
- 不要包含已经超出 ${cursor} 的事件（私生子曝光、各方阵营公开决裂、龙舞、各角色死亡等）
- 不要输出文学解读 / 情感渲染 / 旁白
- 不要输出未在原文中明确出现的人物
- character_id 不要用拼音，用英文标准转写`;

const USER_PROMPT_TEMPLATE = (chunkIdx, totalChunks, text) => `这是《血与火》第 ${chunkIdx + 1}/${totalChunks} 段原文。请从这一段抽取人物 + 关系（严格遵守 cursor 边界）：

═══ 原文 ═══
${text}
═══ 原文结束 ═══

直接输出 JSON。`;

async function extractFromChunk(chunk, idx, total) {
  const system = SYSTEM_PROMPT(targetCursor, targetYear);
  const user = USER_PROMPT_TEMPLATE(idx, total, chunk);
  const { data, provider, model } = await ai.generateStructured({
    task: 'book_extraction',
    system,
    messages: [{ role: 'user', content: user }],
    schema: EXTRACTION_SCHEMA,
    temperature: 0.1,
  });
  return { data: data || { characters: [], relationships: [] }, provider, model };
}

// ─── 合并 + spoiler 二次过滤 + 时间线分组 ─────────────────────
function isPastOrEqual(ep, cursor) {
  // "pre-S01" 永远是过去；其他按字符串比较（S01E01 < S01E05）
  if (!ep) return false;
  if (ep === 'pre-S01' || ep.startsWith('pre-')) return true;
  return ep <= cursor;
}

// 已知 S01E05 后才登场/出生的角色 —— 二次防御：即使 LLM 越界把它们标 from_episode=S01E05，
// 也会被这一层拦掉。匹配 character_id 或 display_name_zh 含子串均拒。
const POST_S01E05_CHARACTER_BLACKLIST_IDS = [
  'aegon_iii_targaryen', 'aegon_iv_targaryen',
  'daenaera_velaryon', 'elin_velaryon',
  'baena_velaryon', 'baenela_velaryon',
  'lara_rogare', 'lotho_rogare', 'roggerio_rogare',
  'urwin_peck', 'amory_peck', 'milia_peck', 'jedam_peck',
  'jaehaera_targaryen', 'jaehaenera_targaryen',
  'mushroom', 'gaemon_palehair',
  'naerys_targaryen', 'rhaena_cobray', 'cohen_cobray',
  'recharino_raenden', 'budaimeer', 'merwin_flower',
  'sandor_doke', 'torren_mandler',
];
const POST_S01E05_NAME_FRAGMENTS = [
  '伊耿三世', '伊耿四世', '戴安娜拉', '拉腊·罗佳尔', '罗佳尔',
  '乌尔温', '培克', '杰赫妮拉', '蘑菇', '盖蒙·淡发',
  '奈丽丝', '雷妮亚·科布瑞', '科布瑞',
];
function isPostS01E05Character(c) {
  if (!c) return false;
  if (c.character_id && POST_S01E05_CHARACTER_BLACKLIST_IDS.includes(c.character_id)) return true;
  const name = (c.display_name_zh || '') + ' ' + (c.canonical_name || '');
  return POST_S01E05_NAME_FRAGMENTS.some(f => name.includes(f));
}
function isPostS01E05CharacterId(id, charsById) {
  if (POST_S01E05_CHARACTER_BLACKLIST_IDS.includes(id)) return true;
  const c = charsById.get(id);
  return c ? isPostS01E05Character(c) : false;
}

function groupRelationshipsByPair(rels) {
  const map = new Map();
  for (const r of rels) {
    const key = `${r.source_id}|${r.target_id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      from: r.from_episode === 'pre-S01' ? 'S01E01' : r.from_episode,
      to: r.to_episode && r.to_episode !== '' ? r.to_episode : null,
      relation_zh: r.relation_zh,
      relation_en: r.relation_en,
      summary_zh: r.summary_zh,
    });
  }
  // 每个 pair 内部按 from 排序
  const out = [];
  for (const [key, timeline] of map.entries()) {
    const [source, target] = key.split('|');
    timeline.sort((a, b) => (a.from || '').localeCompare(b.from || ''));
    out.push({ source, target, timeline });
  }
  return out;
}

function dedupeCharacters(chars) {
  const seen = new Map();
  for (const c of chars) {
    if (!c.character_id) continue;
    const prev = seen.get(c.character_id);
    if (!prev) { seen.set(c.character_id, c); continue; }
    // 合并字段：补全空白
    seen.set(c.character_id, {
      ...prev,
      ...c,
      short_identity_zh: prev.short_identity_zh || c.short_identity_zh,
      house: prev.house || c.house,
      first_mentioned_episode: [prev.first_mentioned_episode, c.first_mentioned_episode]
        .filter(Boolean).sort()[0] || null,
    });
  }
  return [...seen.values()];
}

// ─── main ─────────────────────────────────────────────────────
(async function main() {
  console.log(`[extract] source: ${sourcePath}`);
  console.log(`[extract] target_cursor: ${targetCursor}`);
  console.log(`[extract] out: ${outPath}`);

  if (!ai.isAvailable('book_extraction')) {
    console.error('[err] book_extraction provider not configured. Set GEMINI_API_KEY (or AI_BOOK_PROVIDER=openai + OPENAI_API_KEY).');
    process.exit(1);
  }
  console.log(`[extract] provider/model: ${JSON.stringify(ai.describe().book_extraction.active)}`);

  const text = await loadSource();
  console.log(`[extract] source size: ${text.length} chars`);

  const chunks = chunkByChapters(text, maxChunkChars);
  console.log(`[extract] split into ${chunks.length} chunk(s)`);

  if (dryRun) {
    chunks.forEach((c, i) => {
      const head = c.split('\n').find(l => /^##\s/.test(l)) || c.slice(0, 60).replace(/\n/g, ' ');
      console.log(`  chunk ${i + 1}: ${c.length} chars | ${head.slice(0, 80)}`);
    });
    console.log('[dry-run] exiting without LLM call');
    return;
  }

  const allChars = [];
  const allRels = [];
  let usedProvider = null, usedModel = null;
  let totalFiltered = 0, totalBlacklisted = 0;
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`[extract] chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars) ... `);
    const t0 = Date.now();
    try {
      const { data, provider, model } = await extractFromChunk(chunks[i], i, chunks.length);
      usedProvider = provider; usedModel = model;
      const cs = data.characters || [];
      const rs = data.relationships || [];

      // 三层过滤：
      // 1. 时间边界：from_episode > target_cursor 一律砍
      // 2. 角色黑名单：S01E05 之后才登场的角色（按 id / 中文名片段匹配）
      // 3. 关系两端必须都不是黑名单角色
      const csById = new Map(cs.map(c => [c.character_id, c]));
      const goodChars = cs.filter(c => !isPostS01E05Character(c));
      const droppedBlacklistChars = cs.length - goodChars.length;

      const goodRs = rs.filter(r => {
        if (!isPastOrEqual(r.from_episode, targetCursor)) return false;
        if (isPostS01E05CharacterId(r.source_id, csById)) return false;
        if (isPostS01E05CharacterId(r.target_id, csById)) return false;
        return true;
      });
      const droppedRs = rs.length - goodRs.length;
      totalFiltered += droppedRs;
      totalBlacklisted += droppedBlacklistChars;

      allChars.push(...goodChars);
      allRels.push(...goodRs);
      console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s | chars +${goodChars.length}/-${droppedBlacklistChars} | rels +${goodRs.length}/-${droppedRs}`);
    } catch (err) {
      const errOutPath = path.join(SERVER_ROOT, 'kb', 'characters', 'extracted', `chunk-${i + 1}.error.txt`);
      try {
        fs.mkdirSync(path.dirname(errOutPath), { recursive: true });
        fs.writeFileSync(errOutPath, `chunk ${i + 1} failed:\n${err.stack || err.message}\n\n--- chunk text head ---\n${chunks[i].slice(0, 2000)}`);
      } catch {}
      console.log(`FAILED: ${err.message} (debug saved to ${path.relative(SERVER_ROOT, errOutPath)})`);
    }
  }
  console.log(`[extract] post-filter dropped: ${totalBlacklisted} blacklisted chars, ${totalFiltered} out-of-bounds rels`);

  const dedupedChars = dedupeCharacters(allChars);
  const groupedRels = groupRelationshipsByPair(allRels);

  const output = {
    _schema_version: 1,
    _source: sourcePath,
    _target_cursor: targetCursor,
    _extracted_at: new Date().toISOString(),
    _provider: usedProvider,
    _model: usedModel,
    _stats: {
      characters_total: dedupedChars.length,
      relationships_total: groupedRels.length,
      timeline_entries_total: allRels.length,
      chunks: chunks.length,
    },
    characters: dedupedChars,
    relationships: groupedRels,
  };

  // 确保目录存在
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(output, null, 2));
  console.log(`\n[extract] written to ${outPath}`);
  console.log(`[extract] ${dedupedChars.length} characters, ${groupedRels.length} relationship pairs (${allRels.length} timeline entries total)`);
  console.log(`\nNext: review the output, then run merge_extracted_relationships.js --dry-run to preview merge.`);
})().catch(err => {
  console.error('[fatal]', err.stack || err);
  process.exit(1);
});
