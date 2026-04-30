#!/usr/bin/env node
/**
 * normalize_relationship_labels_v2.js
 *
 * v1 把所有 relation_zh 一刀切成 2-4 字泛化标签，结果丢失了一些原著锚点
 *  （父女信任崩塌 → 关系紧张 / 兄弟官方不予承认 → 决裂）。这版加 canon context：
 *
 *   - 把双方人物的 state_timeline / motivations_timeline / safe_summary 注入 prompt
 *   - 提高字数上限到 5 字
 *   - 强约束：原文锚定的具体事件（信任崩塌、政治分立、绿党雏形）必须保留语义，
 *     agent 只能去装饰（括号/箭头/逗号断句），不能把"具体事件"降格成"模糊状态"
 *
 * 只重跑已有 relation_zh_original 的条目（即 v1 改过的），其他保持现状。
 *
 *   node scripts/normalize_relationship_labels_v2.js              # dry-run
 *   node scripts/normalize_relationship_labels_v2.js --apply
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

const db = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
const charById = new Map((db.characters || []).map(c => [c.character_id, c]));

// 只看 v1 改过的（有 relation_zh_original 的）
const tasks = [];
for (let ri = 0; ri < (db.relationships || []).length; ri++) {
  const r = db.relationships[ri];
  for (let ti = 0; ti < (r.timeline || []).length; ti++) {
    const tl = r.timeline[ti];
    if (!tl?.relation_zh_original) continue;
    tasks.push({
      i: tasks.length,
      ri, ti,
      source: r.source,
      target: r.target,
      from: tl.from,
      to: tl.to,
      relation_zh_v1: tl.relation_zh,
      relation_zh_original: tl.relation_zh_original,
      summary_zh: tl.summary_zh,
      source_name: charById.get(r.source)?.display_name_zh || r.source,
      target_name: charById.get(r.target)?.display_name_zh || r.target,
    });
  }
}

console.log(`扫描到 ${tasks.length} 条 v1 改过的标签待复审。`);
if (tasks.length === 0) process.exit(0);

// 抽各角色在 [from, to] 范围里的 canon state（state_timeline / motivations）
function rangeOverlaps(a, b) {
  // 简化：只要 episode 字符串有重叠就算（"S01E05" 这种的字典序够用）
  const aFrom = a.from || 'S01E01', aTo = a.to || 'S01E10';
  const bFrom = b.from || 'S01E01', bTo = b.to || 'S01E10';
  return !(aTo < bFrom || aFrom > bTo);
}
function canonContext(charId, from, to) {
  const c = charById.get(charId);
  if (!c) return null;
  const range = { from, to: to || 'now' };
  const states = (c.state_timeline || []).filter(s => rangeOverlaps(s, range)).map(s => ({
    range: `${s.from}-${s.to || 'now'}`,
    title: s.title_zh,
    political_role: s.political_role_zh,
    summary: s.safe_summary_zh,
    alive: s.alive,
  }));
  const motivs = (c.motivations_timeline || []).filter(m => rangeOverlaps(m, range)).map(m => ({
    range: `${m.from}-${m.to || 'now'}`,
    motivation: m.motivation_zh,
    evidence: m.evidence_zh,
  })).slice(0, 3);
  return { states, motivations: motivs };
}

const systemPrompt = `你是《龙之家族》关系图谱的精校编辑。前一版自动化过度概括，把"原著里有具体锚点的关系"压成了泛化状态词。你的任务：基于注入的 canon context（双方人物的 state_timeline / motivations）重新校准短标签。

铁律：
1. **保留原著锚点**：如果原始标签 (original) 写了一个有典出的具体事件（"信任崩塌"指 S01E05 月亮茶 / "政治分立"指阿莉森特绿衣登场 / "绿党雏形"指克里斯顿倒戈 / "官方不予承认"指奥托唆使废黜戴蒙），新标签必须保留这一原著语义。**只能去装饰**（括号、逗号、箭头、副句），**不能把具体事件降级为通用状态**。
2. **字数 ≤ 5 个汉字**，无标点、无括号、无空格、无箭头。可以是 4 字成语 / 4-5 字状态短语。
3. **canon context 是裁判**：如果 source/target 在该集数范围内的 state 显示双方关系仍存（例如"夫妻"还在），不要丢弃关系类型词；如果显示已经破裂或反目，可以只用立场词。
4. v1 标签 (current) 是错误参考——优先回到 original 的语义，只是格式更干净。

输出每条 i 对应一个 relation_zh。`;

const userPayload = tasks.map(t => ({
  i: t.i,
  pair: `${t.source_name}（${t.source}）→ ${t.target_name}（${t.target}）`,
  episode_range: `${t.from} → ${t.to || 'now'}`,
  current_v1: t.relation_zh_v1,
  original: t.relation_zh_original,
  summary_zh: t.summary_zh,
  source_canon: canonContext(t.source, t.from, t.to),
  target_canon: canonContext(t.target, t.from, t.to),
}));

const userPrompt = `请为以下 ${tasks.length} 条关系给出贴合原著的精校标签。返回 items 数组：

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
  const task = ai.isAvailable('reasoning') ? 'reasoning'
             : ai.isAvailable('chat') ? 'chat'
             : null;
  if (!task) { console.error('AI not configured'); process.exit(1); }
  console.log(`调用 AI（task=${task}）……`);

  const result = await ai.generateStructured({
    task,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    schema,
    schemaName: 'relationship_labels_v2',
    temperature: 0.15,
  });

  const items = result?.items || result?.data?.items || [];
  if (items.length !== tasks.length) {
    console.warn(`⚠ 返回 ${items.length} / ${tasks.length}，缺失项保持原样。`);
  }
  const byI = new Map(items.map(it => [it.i, it]));

  function sanitize(label) {
    if (!label) return '';
    let s = String(label).trim();
    s = s.replace(/[（(].*?[)）]/g, '');
    s = s.replace(/[，,。\.\-—–→\/\\\s"'《》【】\[\]]/g, '');
    if (s.length > 5) s = s.slice(0, 5);
    return s;
  }

  console.log('\n=== v2 复审对照 ===');
  let dirty = 0;
  for (const t of tasks) {
    const it = byI.get(t.i);
    const clean = sanitize(it?.relation_zh);
    if (!clean) {
      console.log(`  [${t.i}] ${t.source_name} → ${t.target_name} : v1="${t.relation_zh_v1}" ✗ 跳过`);
      continue;
    }
    if (clean === t.relation_zh_v1) {
      console.log(`  [${t.i}] ${t.source_name} → ${t.target_name} : v1="${t.relation_zh_v1}"  ✓ 维持`);
      continue;
    }
    dirty++;
    console.log(`  [${t.i}] ${t.source_name} → ${t.target_name}   ${t.from}→${t.to||'now'}`);
    console.log(`        v1="${t.relation_zh_v1}"  →  v2="${clean}"`);
    console.log(`        original="${t.relation_zh_original}"`);
    console.log(`        rationale: ${it?.rationale || ''}`);
    if (args.apply) {
      db.relationships[t.ri].timeline[t.ti].relation_zh = clean;
    }
  }

  console.log(`\n复审结果：${dirty} 条调整。`);
  if (!args.apply) { console.log('（dry-run）加 --apply 写入。'); return; }

  if (dirty > 0) {
    const ts = Date.now();
    const backup = `${kbPath}.backup-relabel-v2-${ts}.json`;
    fs.copyFileSync(kbPath, backup);
    console.log('backup →', path.relative(SERVER_ROOT, backup));
    fs.writeFileSync(kbPath, JSON.stringify(db, null, 2), 'utf8');
    console.log('written →', path.relative(SERVER_ROOT, kbPath));
  }
})().catch(err => { console.error('FAILED:', err.stack || err.message); process.exit(1); });
