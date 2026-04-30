#!/usr/bin/env node
/**
 * normalize_relationship_labels.js
 *
 * 起因：character KB 里 relationships[].timeline[].relation_zh 写得太放飞 ——
 *   "父女（信任崩塌）" / "守护者→失意者→敌对" / "夫妻（政治婚姻，开局即被血涂改）"
 * 这些放在关系图边线上太长、风格不一致。需要让 agent 重写成 2–4 字干净标签，
 * 戏剧化原文搬到 summary_zh 里保留（detail 卡片还能看）。
 *
 * 用法：
 *   node scripts/normalize_relationship_labels.js              # dry-run，打印对照表
 *   node scripts/normalize_relationship_labels.js --apply      # 真改 KB（先自动 backup）
 *   node scripts/normalize_relationship_labels.js --kb kb/characters/<file>.json
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
const kbPath = path.resolve(
  SERVER_ROOT,
  args.kb || 'kb/characters/house-of-the-dragon.json'
);

if (!fs.existsSync(kbPath)) {
  console.error('KB not found:', kbPath);
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
const charById = new Map((db.characters || []).map(c => [c.character_id, c]));

// 收集所有需要重写的 timeline 条目；保留索引便于回写
const tasks = [];
for (let ri = 0; ri < (db.relationships || []).length; ri++) {
  const r = db.relationships[ri];
  for (let ti = 0; ti < (r.timeline || []).length; ti++) {
    const tl = r.timeline[ti];
    if (!tl || !tl.relation_zh) continue;
    // 已经规范过就跳过
    if (tl.relation_zh_original) continue;
    tasks.push({
      i: tasks.length,
      ri,
      ti,
      source: r.source,
      target: r.target,
      from: tl.from,
      to: tl.to,
      relation_zh: tl.relation_zh,
      relation_en: tl.relation_en || null,
      summary_zh: tl.summary_zh || null,
      source_name: charById.get(r.source)?.display_name_zh || r.source,
      target_name: charById.get(r.target)?.display_name_zh || r.target,
    });
  }
}

console.log(`扫描到 ${tasks.length} 条待重写的关系标签（${kbPath}）`);
if (tasks.length === 0) { console.log('没有需要处理的标签。'); process.exit(0); }

// ─── LLM 调用 ─────────────────────────────────────────────
const systemPrompt = `你是《龙之家族》关系图谱编辑。你的工作是把过度戏剧化的关系标签重写成简洁规范的标签。

输入：每条关系包含 source（人物 A）→ target（人物 B），生效集数范围，以及当前的 relation_zh 标签和 summary_zh 长描述。

要求：
- 输出 2–4 个汉字的关系标签（**严格 ≤ 4 字**），表达当前阶段两人关系的本质。
- **不要**括号、逗号、引号、破折号、箭头、空格等任何标点。
- 优先用简洁的关系类型词：父女 / 叔侄 / 夫妻 / 表姑侄 / 同父异母 / 龙骑士 / 私情 / 政治盟友 / 公开政敌 / 关系疏离 / 王位之争 / 政治对立 / 决裂 / 同盟 / 暗恋 / 暧昧 等。
- 已经反目/对立时优先体现立场，不要用亲属称谓（例如不要写"叔侄"，写"暧昧"或"同盟"或"政敌"）。
- 同一段关系（同 source、target、时间段）只出一个最贴切的标签。
- 不要复述 summary_zh 内容，只给标签。`;

const userPayload = tasks.map((t, i) => ({
  i,
  pair: `${t.source_name}（${t.source}）→ ${t.target_name}（${t.target}）`,
  episode_range: `${t.from} → ${t.to || 'now'}`,
  current_relation_zh: t.relation_zh,
  relation_en: t.relation_en,
  summary_zh: t.summary_zh,
}));

const userPrompt = `请为以下 ${tasks.length} 条关系生成规范标签。返回数组，元素顺序与输入 i 一一对应：

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
        },
        required: ['i', 'relation_zh'],
      },
    },
  },
  required: ['items'],
};

(async () => {
  const task = ai.isAvailable('reasoning') ? 'reasoning'
             : ai.isAvailable('chat') ? 'chat'
             : null;
  if (!task) {
    console.error('没有可用的 AI provider（OPENAI_API_KEY / GEMINI_API_KEY 都没配？）');
    process.exit(1);
  }
  console.log(`调用 AI（task=${task}）……`);

  const result = await ai.generateStructured({
    task,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    schema,
    schemaName: 'relationship_labels',
    temperature: 0.2,
  });

  // 不同 provider 包装层级不同：openai 直接给 schema 顶层；reasoning 路由会多裹一层 data
  const items = result?.items || result?.data?.items || [];
  if (items.length !== tasks.length) {
    console.warn(`⚠ 返回 ${items.length} 条，期望 ${tasks.length} 条；按 i 字段对齐。`);
  }
  const byI = new Map(items.map(it => [it.i, it.relation_zh]));

  // 校验 + 安全降级：太长 / 含标点 → 去掉括号/逗号/箭头后取前 4 字
  function sanitize(label) {
    if (!label) return '';
    let s = String(label).trim();
    s = s.replace(/[（(].*?[)）]/g, '');
    s = s.replace(/[，,。\.\-—–→\/\\\s"'《》【】\[\]]/g, '');
    if (s.length > 4) s = s.slice(0, 4);
    return s;
  }

  console.log('\n=== 改写对照 ===');
  let dirty = 0;
  for (const t of tasks) {
    const raw = byI.get(t.i);
    const clean = sanitize(raw);
    if (!clean) {
      console.log(`  [${t.i}] ${t.source_name} → ${t.target_name} : "${t.relation_zh}"  ✗ LLM 没给标签，跳过`);
      continue;
    }
    if (clean === t.relation_zh) {
      console.log(`  [${t.i}] ${t.source_name} → ${t.target_name} : "${t.relation_zh}"  ✓ 已规范，无需改`);
      continue;
    }
    dirty++;
    console.log(`  [${t.i}] ${t.source_name} → ${t.target_name}`);
    console.log(`        "${t.relation_zh}"  →  "${clean}"`);
    if (args.apply) {
      const tl = db.relationships[t.ri].timeline[t.ti];
      tl.relation_zh_original = tl.relation_zh;     // 保留原文
      tl.relation_zh = clean;
      // 原文如果带剧情描述、summary 又是空的，把原文挪到 summary 里
      if (!tl.summary_zh) tl.summary_zh = t.relation_zh;
    }
  }

  console.log(`\n共需改写 ${dirty} 条。`);
  if (!args.apply) {
    console.log('（dry-run）加 --apply 实际写入 KB（会先自动 backup）。');
    return;
  }

  if (dirty > 0) {
    const ts = Date.now();
    const backupPath = `${kbPath}.backup-relabel-${ts}.json`;
    fs.copyFileSync(kbPath, backupPath);
    console.log('\nbackup →', path.relative(SERVER_ROOT, backupPath));
    fs.writeFileSync(kbPath, JSON.stringify(db, null, 2), 'utf8');
    console.log('written →', path.relative(SERVER_ROOT, kbPath));
  } else {
    console.log('没有任何条目改动，跳过写入。');
  }
})().catch(err => {
  console.error('FAILED:', err.stack || err.message);
  process.exit(1);
});
