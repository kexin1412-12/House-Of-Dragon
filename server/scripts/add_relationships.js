/* 一次性脚本：补全 House of the Dragon 角色关系网。
   原 DB 仅 7 条 relationship，导致关系图人物太少（10 个角色完全孤立）。
   这里补满主要血缘 + 婚姻 + 政治阵营 + 私情，让任何时间点的图都能撑起来。 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'kb', 'characters', 'house-of-the-dragon.json');
const BACKUP = DB_PATH + '.backup-' + Date.now() + '.json';

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
fs.writeFileSync(BACKUP, JSON.stringify(db, null, 2), 'utf8');
console.log('backed up →', BACKUP);

// 现有关系键（避免重复）
const existing = new Set();
for (const r of db.relationships || []) {
  const k = [r.source, r.target].sort().join('::');
  existing.add(k);
}

const NEW = [
  // ── Velaryon 家族 ──────────────────────────────────────
  {
    source: 'corlys_velaryon', target: 'rhaenys_targaryen',
    timeline: [{ from: 'S01E01', to: null, relation_zh: '夫妻',
      relation_en: 'spouse',
      summary_zh: '潮汐之主与"未当上的女王"——海军势力与坦格利安血脉的联姻。' }],
  },
  {
    source: 'rhaenys_targaryen', target: 'viserys_targaryen',
    timeline: [{ from: 'S01E01', to: null, relation_zh: '表亲',
      relation_en: 'cousin',
      summary_zh: '本应继承王位的人。先王大议会上韦赛里斯被选中，蕾妮丝被跳过。' }],
  },
  {
    source: 'rhaenys_targaryen', target: 'rhaenyra_targaryen',
    timeline: [{ from: 'S01E01', to: null, relation_zh: '表姑侄',
      relation_en: 'aunt-niece',
      summary_zh: '同样的"被跳过"是雷尼拉的镜子——蕾妮丝是同盟，也是警示。' }],
  },
  {
    source: 'corlys_velaryon', target: 'rhaenyra_targaryen',
    timeline: [
      { from: 'S01E07', to: 'S01E09', relation_zh: '政治盟友',
        relation_en: 'political-ally',
        summary_zh: '通过子嗣联姻把瓦列利安家族绑在雷尼拉一方。' },
      { from: 'S01E10', to: null, relation_zh: '关系紧张',
        relation_en: 'strained',
        summary_zh: '失子之痛 + 战略分歧让同盟出现裂痕。' },
    ],
  },
  {
    source: 'corlys_velaryon', target: 'daemon_targaryen',
    timeline: [{ from: 'S01E02', to: null, relation_zh: '政治盟友',
      relation_en: 'political-ally',
      summary_zh: '阶梯列岛之战的并肩者；后又因联姻成姻亲。' }],
  },
  {
    source: 'rhaenys_targaryen', target: 'daemon_targaryen',
    timeline: [{ from: 'S01E01', to: null, relation_zh: '表亲',
      relation_en: 'cousin',
      summary_zh: '同代坦格利安，对宫廷政治都看得透。' }],
  },

  // ── Strong 家族 ────────────────────────────────────────
  {
    source: 'harwin_strong', target: 'lyonel_strong',
    timeline: [{ from: 'S01E01', to: null, relation_zh: '父子',
      relation_en: 'father-son',
      summary_zh: '哈尔温是河铭城公爵 Lyonel 的长子与继承人。' }],
  },
  {
    source: 'larys_strong', target: 'lyonel_strong',
    timeline: [{ from: 'S01E01', to: 'S01E06', relation_zh: '父子',
      relation_en: 'father-son',
      summary_zh: '拉里斯是河铭城公爵的次子。' }],
  },
  {
    source: 'harwin_strong', target: 'larys_strong',
    timeline: [{ from: 'S01E01', to: null, relation_zh: '兄弟',
      relation_en: 'siblings',
      summary_zh: '"折骨"哈尔温与"瘸子"拉里斯——气质截然相反的两兄弟。' }],
  },
  {
    source: 'harwin_strong', target: 'rhaenyra_targaryen',
    timeline: [{ from: 'S01E06', to: 'S01E06', relation_zh: '私情',
      relation_en: 'lover',
      summary_zh: '雷尼拉三个儿子的生父（公开身份是公主与驸马劳琳诺的孩子）。' }],
  },
  {
    source: 'larys_strong', target: 'alicent_hightower',
    timeline: [{ from: 'S01E07', to: null, relation_zh: '政治附庸',
      relation_en: 'covert-ally',
      summary_zh: '靠为王后做"脏活"上位——耳目、纵火、刺杀。' }],
  },

  // ── Daemon 私情 ────────────────────────────────────────
  {
    source: 'daemon_targaryen', target: 'mysaria',
    timeline: [{ from: 'S01E01', to: null, relation_zh: '情人',
      relation_en: 'lover',
      summary_zh: '戴蒙最早的情妇与心腹耳目；后亦成下层人脉网络的入口。' }],
  },

  // ── Criston Cole ─────────────────────────────────────
  {
    source: 'criston_cole', target: 'rhaenyra_targaryen',
    timeline: [
      { from: 'S01E02', to: 'S01E04', relation_zh: '卫士与公主',
        relation_en: 'protector',
        summary_zh: '雷尼拉亲选的白袍护卫，曾因好感生情。' },
      { from: 'S01E05', to: null, relation_zh: '决裂',
        relation_en: 'rival',
        summary_zh: '私情破裂后倒向阿莉森特一方，自此对她抱有近乎扭曲的恨意。' },
    ],
  },
  {
    source: 'criston_cole', target: 'alicent_hightower',
    timeline: [{ from: 'S01E05', to: null, relation_zh: '政治盟友',
      relation_en: 'political-ally',
      summary_zh: '王后的私人护卫与心腹，"绿党"军中执剑人。' }],
  },

  // ── Alicent 的孩子（S01E06 时间跳跃后登场） ──────────
  {
    source: 'aegon_targaryen_ii', target: 'alicent_hightower',
    timeline: [{ from: 'S01E06', to: null, relation_zh: '母子',
      relation_en: 'mother-son',
      summary_zh: '王后阿莉森特的长子，"绿党"立场上的王位候选。' }],
  },
  {
    source: 'aegon_targaryen_ii', target: 'viserys_targaryen',
    timeline: [{ from: 'S01E06', to: null, relation_zh: '父子',
      relation_en: 'father-son',
      summary_zh: '韦赛里斯的长子，但父亲从未真正想立他为继承人。' }],
  },
  {
    source: 'aemond_targaryen', target: 'alicent_hightower',
    timeline: [{ from: 'S01E06', to: null, relation_zh: '母子',
      relation_en: 'mother-son',
      summary_zh: '王后的次子，少年时即失一目并夺得瓦格哈尔。' }],
  },
  {
    source: 'aemond_targaryen', target: 'viserys_targaryen',
    timeline: [{ from: 'S01E06', to: null, relation_zh: '父子',
      relation_en: 'father-son',
      summary_zh: '韦赛里斯的次子。' }],
  },
  {
    source: 'helaena_targaryen', target: 'alicent_hightower',
    timeline: [{ from: 'S01E06', to: null, relation_zh: '母女',
      relation_en: 'mother-daughter',
      summary_zh: '王后唯一的女儿；性情温和，常说出像预言一样的怪话。' }],
  },
  {
    source: 'helaena_targaryen', target: 'viserys_targaryen',
    timeline: [{ from: 'S01E06', to: null, relation_zh: '父女',
      relation_en: 'father-daughter',
      summary_zh: '韦赛里斯的小女儿。' }],
  },
  {
    source: 'aegon_targaryen_ii', target: 'aemond_targaryen',
    timeline: [{ from: 'S01E06', to: null, relation_zh: '兄弟',
      relation_en: 'siblings',
      summary_zh: '同母兄弟。年少时哥哥经常嘲弄艾蒙德没有龙。' }],
  },
  {
    source: 'aegon_targaryen_ii', target: 'helaena_targaryen',
    timeline: [
      { from: 'S01E06', to: 'S01E07', relation_zh: '兄妹',
        relation_en: 'siblings',
        summary_zh: '同母兄妹。' },
      { from: 'S01E08', to: null, relation_zh: '夫妻',
        relation_en: 'spouse',
        summary_zh: '为延续坦格利安血统由阿莉森特安排的政治联姻。' },
    ],
  },
  {
    source: 'aemond_targaryen', target: 'helaena_targaryen',
    timeline: [{ from: 'S01E06', to: null, relation_zh: '兄妹',
      relation_en: 'siblings',
      summary_zh: '同母兄妹。' }],
  },
  {
    source: 'aegon_targaryen_ii', target: 'rhaenyra_targaryen',
    timeline: [
      { from: 'S01E06', to: 'S01E07', relation_zh: '同父异母',
        relation_en: 'half-siblings',
        summary_zh: '同一个父亲；雷尼拉是嫡长女继承人，伊耿是男性长子。' },
      { from: 'S01E08', to: null, relation_zh: '王位之争',
        relation_en: 'rival',
        summary_zh: '继承权之争公开化；"绿党"与"黑党"分裂的核心冲突。' },
    ],
  },
  {
    source: 'aemond_targaryen', target: 'rhaenyra_targaryen',
    timeline: [
      { from: 'S01E06', to: 'S01E06', relation_zh: '同父异母',
        relation_en: 'half-siblings',
        summary_zh: '同一个父亲。' },
      { from: 'S01E07', to: null, relation_zh: '政治对立',
        relation_en: 'political-rival',
        summary_zh: '驯龙夺目事件后裂痕公开；他成为"绿党"阵营最锋利的剑。' },
    ],
  },
  {
    source: 'helaena_targaryen', target: 'rhaenyra_targaryen',
    timeline: [{ from: 'S01E06', to: null, relation_zh: '同父异母',
      relation_en: 'half-siblings',
      summary_zh: '同一个父亲。' }],
  },
];

let added = 0;
for (const r of NEW) {
  const k = [r.source, r.target].sort().join('::');
  if (existing.has(k)) {
    console.log('skip (already exists):', r.source, '<->', r.target);
    continue;
  }
  db.relationships.push(r);
  existing.add(k);
  added++;
}

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
console.log(`added ${added} new relationships → total ${db.relationships.length}`);
