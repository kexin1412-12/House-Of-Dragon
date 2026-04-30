#!/usr/bin/env node
/**
 * normalize_relationship_kinds.js
 *
 * 把每条 relationship.timeline 条目归到 6 大视觉类型（用户决策 1）：
 *   blood    — 血亲（父子/母女/兄弟姐妹/叔侄/表亲）         视觉：实线粗
 *   marriage — 婚姻（现任配偶）                              视觉：实线+双环节点
 *   ally     — 盟友（同党派、同立场）                        视觉：实线
 *   friend   — 友人（私人友好）                              视觉：虚线
 *   enemy    — 敌对（公开冲突）                              视觉：红色实线
 *   secret   — 暗线（私情、暗中效忠、秘密关系）              视觉：点线
 *
 * 龙骑士不在 6 类里——龙作为 companion 挂在节点上，已被前端单独处理。
 *
 *   node scripts/normalize_relationship_kinds.js              # dry-run
 *   node scripts/normalize_relationship_kinds.js --apply
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

const KINDS = ['blood', 'marriage', 'ally', 'friend', 'enemy', 'secret'];

const tasks = [];
for (let ri = 0; ri < (db.relationships || []).length; ri++) {
  const r = db.relationships[ri];
  for (let ti = 0; ti < (r.timeline || []).length; ti++) {
    const tl = r.timeline[ti];
    if (!tl?.relation_zh) continue;
    // 龙骑士跳过——前端做 companion，不上图
    const sTags = charById.get(r.source)?.tags || [];
    const tTags = charById.get(r.target)?.tags || [];
    if (sTags.includes('dragon') || tTags.includes('dragon')) continue;
    tasks.push({
      i: tasks.length,
      ri, ti,
      pair: `${charById.get(r.source)?.display_name_zh || r.source} → ${charById.get(r.target)?.display_name_zh || r.target}`,
      from: tl.from,
      to: tl.to,
      relation_zh: tl.relation_zh,
      original: tl.relation_zh_original,
      summary_zh: tl.summary_zh,
      current_kind: tl.relation_kind || null,
    });
  }
}
console.log(`扫描到 ${tasks.length} 条人物关系（龙骑士跳过）`);

const systemPrompt = `你是《龙之家族》关系图谱编辑。任务：把每条关系归到 6 大视觉类型之一。

枚举（必须严格选其一）：
- blood     血亲：父子、母子、父女、母女、兄弟、姐妹、兄妹、叔侄、舅甥、表亲、同父异母 等血缘关系。**婚姻不算 blood**。
- marriage  婚姻：现任配偶（夫妻）。
- ally      盟友：同党派、同立场，公开互助。例：政治盟友、附庸、绿党/黑党同党。
- friend    友人：私人友好、闺蜜、密友。**不带政治色彩**。例：好友、密友、童年伙伴。
- enemy     敌对：公开冲突、决裂、政敌、政治对立、互为凶手、信任破裂、关系决裂、关系疏远（已带敌意）。
- secret    暗线：私情、暧昧、秘密效忠、暗杀、单方面隐藏的杀害关系。当一段关系是"未公开的"或"私下的"时归 secret。

判定规则：
1. 婚姻状态优先看是否当前在婚（"现任夫妻"=marriage）；曾经是夫妻但已经决裂/凶手关系 → enemy。
2. 政治盟友/政敌 → ally / enemy（不要因为带"政治"二字就归别处）。
3. "国王与侍女" / "侍女" → ally（早期阿莉森特陪侍韦赛里斯）
4. "凶手"（克里斯顿杀乔弗里、戴蒙杀瑞亚等）→ secret 或 enemy？规则：
   - 凶手与受害者之间：归 enemy（公然或事实上的对立）
   - 但若杀人是"暗杀/未公开"性质 → secret
5. "暧昧" / "私情" → secret
6. "关系疏远" 但还没对立 → friend（关系冷淡但仍是私人/前盟友）；已经走到对立 → enemy

返回数组每项含：i, kind（枚举值之一），rationale（一句话）。`;

const userPayload = tasks.map(t => ({
  i: t.i,
  pair: t.pair,
  episode_range: `${t.from} → ${t.to || 'now'}`,
  relation_zh: t.relation_zh,
  canon_anchor: t.original,
  summary: t.summary_zh,
}));
const userPrompt = `归类以下 ${tasks.length} 条关系：\n\n${JSON.stringify(userPayload, null, 2)}`;

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
          kind: { type: 'string', enum: KINDS },
          rationale: { type: 'string' },
        },
        required: ['i', 'kind', 'rationale'],
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
    schemaName: 'relationship_kinds',
    temperature: 0.1,
  });
  const items = result?.items || result?.data?.items || [];
  if (items.length !== tasks.length) console.warn(`⚠ 返回 ${items.length} / ${tasks.length}`);
  const byI = new Map(items.map(it => [it.i, it]));

  // 按 kind 分组打印
  const groups = Object.fromEntries(KINDS.map(k => [k, []]));
  let invalid = 0;
  for (const t of tasks) {
    const it = byI.get(t.i);
    const kind = it?.kind;
    if (!KINDS.includes(kind)) { invalid++; continue; }
    groups[kind].push({ ...t, kind, rationale: it.rationale });
    if (args.apply) {
      db.relationships[t.ri].timeline[t.ti].relation_kind = kind;
    }
  }
  for (const k of KINDS) {
    console.log(`\n[${k}] (${groups[k].length} 条)`);
    for (const g of groups[k]) {
      console.log(`  ${g.pair}  ${g.from}→${g.to||'now'}  "${g.relation_zh}"`);
    }
  }
  if (invalid) console.log(`\n⚠ ${invalid} 条无法归类（保持原 relation_kind）`);

  if (!args.apply) { console.log('\n（dry-run）加 --apply 写入。'); return; }
  const ts = Date.now();
  const backup = `${kbPath}.backup-relabel-kinds-${ts}.json`;
  fs.copyFileSync(kbPath, backup);
  console.log('\nbackup →', path.relative(SERVER_ROOT, backup));
  fs.writeFileSync(kbPath, JSON.stringify(db, null, 2), 'utf8');
  console.log('written →', path.relative(SERVER_ROOT, kbPath));
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
