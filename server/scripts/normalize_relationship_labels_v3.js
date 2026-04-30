#!/usr/bin/env node
/**
 * normalize_relationship_labels_v3.js
 *
 * v2 保住了原著锚点但写成了"古风文言"：父女崩塌 / 夫妻血涂 / 敌对反目 / 叔侄私密。
 * 这版严格强制现代汉语，禁用文言/戏剧词，但仍要锚定原著事件，不能笼统化。
 *
 * 处理范围：所有 timeline 条目（不止 v1 改过的）。已经是现代汉语的会被识别为"维持"。
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');

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
const kbPath = path.resolve(SERVER_ROOT, args.kb || 'kb/characters/house-of-the-dragon.json');

const db = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
const charById = new Map((db.characters || []).map(c => [c.character_id, c]));

const tasks = [];
for (let ri = 0; ri < (db.relationships || []).length; ri++) {
  const r = db.relationships[ri];
  for (let ti = 0; ti < (r.timeline || []).length; ti++) {
    const tl = r.timeline[ti];
    if (!tl?.relation_zh) continue;
    tasks.push({
      i: tasks.length,
      ri, ti,
      source: r.source,
      target: r.target,
      from: tl.from,
      to: tl.to,
      current: tl.relation_zh,
      original: tl.relation_zh_original || null, // canon-anchored 原文
      summary_zh: tl.summary_zh,
      source_name: charById.get(r.source)?.display_name_zh || r.source,
      target_name: charById.get(r.target)?.display_name_zh || r.target,
    });
  }
}

console.log(`扫描到 ${tasks.length} 条关系。`);

const BANNED = ['崩塌', '反目', '血涂', '血染', '私密', '哀歌', '殇', '陨', '昭然', '夙', '隙', '窕', '怨', '恨', '裂帛'];

const systemPrompt = `你是《龙之家族》关系图谱的精校编辑（现代汉语版）。

任务：把每条关系标签改成简洁的现代汉语，但必须保留原著锚定的具体事件含义。

铁律：
1. **只能用现代汉语日常词汇**。禁用文言、戏剧化、武侠、文学化用词。
   ❌ 禁用：${BANNED.join(' / ')}
   ❌ 不要：父女崩塌 / 夫妻血涂 / 叔侄私密 / 敌对反目 / 信任崩塌 / 爱恨情仇 / 血脉相连
   ✅ 要用：父女不和 / 政治夫妻 / 暧昧 / 决裂 / 信任破裂 / 关系破裂 / 公开对立

2. **保留原著锚点**：original 字段（如有）说明这是哪一具体事件——
   - 信任崩塌 = S01E05 月亮茶 → 用"信任破裂"或"关系破裂"或"父女不和"
   - 政治分立 = 阿莉森特绿衣登场 → 用"公开对立"或"立场对立"
   - 私人频道无人能进 = 婚宴耳语 → 用"暧昧"
   - 绿党雏形 = 克里斯顿倒戈 → 用"政治盟友"
   - 杀其情人者 / 凶手—被害者 = 杀戮 → 用"凶手"
   不要笼统化（不要把"信任崩塌"压成"关系紧张"），但必须改用现代词。

3. **字数 2–5 个汉字**，无标点、无括号、无空格、无箭头、无连接号。

4. 亲属称谓本身（父女 / 叔侄 / 兄妹 / 表姑侄 / 同父异母）不算古风，可保留。
   "夫妻 / 母子 / 父子" 等也保留。

返回每条 i 对应的 relation_zh 和一句 rationale。`;

const userPayload = tasks.map(t => ({
  i: t.i,
  pair: `${t.source_name} → ${t.target_name}`,
  episode_range: `${t.from} → ${t.to || 'now'}`,
  current: t.current,
  original_canon_anchor: t.original,
  summary: t.summary_zh,
}));
const userPrompt = `请规范以下 ${tasks.length} 条标签：

${JSON.stringify(userPayload, null, 2)}`;

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          i: { type: 'integer' },
          relation_zh: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['i', 'relation_zh', 'rationale'],
      },
    },
  },
  required: ['items'],
};

(async () => {
  const task = ai.isAvailable('reasoning') ? 'reasoning' : 'chat';
  console.log(`调用 AI（task=${task}）……`);
  const result = await ai.generateStructured({
    task,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    schema,
    schemaName: 'relationship_labels_v3',
    temperature: 0.15,
  });

  const items = result?.items || result?.data?.items || [];
  if (items.length !== tasks.length) console.warn(`⚠ 返回 ${items.length} / ${tasks.length}`);
  const byI = new Map(items.map(it => [it.i, it]));

  function sanitize(label) {
    if (!label) return '';
    let s = String(label).trim();
    s = s.replace(/[（(].*?[)）]/g, '');
    s = s.replace(/[，,。\.\-—–→\/\\\s"'《》【】\[\]]/g, '');
    if (s.length > 5) s = s.slice(0, 5);
    return s;
  }
  function hasBanned(s) {
    return BANNED.some(w => s.includes(w));
  }

  console.log('\n=== v3 现代汉语版改写 ===');
  let dirty = 0, retainedBan = 0;
  for (const t of tasks) {
    const it = byI.get(t.i);
    let clean = sanitize(it?.relation_zh);
    if (!clean) {
      console.log(`  [${t.i}] ${t.source_name}→${t.target_name} : "${t.current}" ✗ 跳过`);
      continue;
    }
    if (hasBanned(clean)) {
      console.log(`  [${t.i}] ${t.source_name}→${t.target_name} : "${clean}" ⚠ agent 仍带禁词，跳过`);
      retainedBan++;
      continue;
    }
    if (clean === t.current) continue; // 维持
    dirty++;
    console.log(`  [${t.i}] ${t.source_name}→${t.target_name}   ${t.from}→${t.to||'now'}`);
    console.log(`        "${t.current}"  →  "${clean}"   (${it?.rationale||''})`);
    if (args.apply) {
      const tl = db.relationships[t.ri].timeline[t.ti];
      if (!tl.relation_zh_original) tl.relation_zh_original = tl.relation_zh; // 第一次保留
      tl.relation_zh = clean;
    }
  }
  console.log(`\n${dirty} 条调整 · ${retainedBan} 条仍带禁词跳过。`);
  if (!args.apply) { console.log('（dry-run）加 --apply 写入。'); return; }
  if (dirty > 0) {
    const ts = Date.now();
    const backup = `${kbPath}.backup-relabel-v3-${ts}.json`;
    fs.copyFileSync(kbPath, backup);
    console.log('backup →', path.relative(SERVER_ROOT, backup));
    fs.writeFileSync(kbPath, JSON.stringify(db, null, 2), 'utf8');
    console.log('written →', path.relative(SERVER_ROOT, kbPath));
  }
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
