#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
const DB_PATH = path.join(SERVER_DIR, 'kb', 'characters', 'house-of-the-dragon.json');

const NEW_CHARACTERS = [
  {
    character_id: 'jacaerys_velaryon',
    canonical_name: 'Jacaerys Velaryon',
    display_name_zh: '杰卡里斯·瓦列利安',
    short_identity_zh: '雷妮拉的长子，龙骑士',
    house: 'Velaryon/Targaryen',
    tags: ['royalty', 'black', 'dragonrider'],
    actor_versions: [{ actor_name: 'Harry Collett', version: 'adult', active_range: { from: 'S03E01', to: null }, face_group_id: 'jacaerys_adult' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: 'Prince',
      title_zh: '王子',
      political_role_zh: '雷妮拉阵营的继承人之一，喉道战役中试图保护母亲并投入空战',
      alive: true,
      safe_summary_zh: '雷妮拉的长子，骑乘沃马克斯。在 S03E01 中阻止雷妮拉亲征，又在喉道海战中参战。'
    }]
  },
  {
    character_id: 'baela_targaryen',
    canonical_name: 'Baela Targaryen',
    display_name_zh: '贝妮拉·坦格利安',
    aliases: ['贝拉', 'Baela'],
    short_identity_zh: '戴蒙之女，龙骑士',
    house: 'Targaryen',
    tags: ['royalty', 'black', 'dragonrider'],
    actor_versions: [{ actor_name: 'Bethany Antonia', version: 'adult', active_range: { from: 'S03E01', to: null }, face_group_id: 'baela_adult' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: 'Lady',
      title_zh: '坦格利安贵女',
      political_role_zh: '雷妮拉阵营的年轻龙骑士，喉道海战的空中力量',
      alive: true,
      safe_summary_zh: '戴蒙的女儿，骑乘月舞。在 S03E01 喉道海战中支援科利斯舰队。'
    }]
  },
  {
    character_id: 'rhaena_targaryen',
    canonical_name: 'Rhaena Targaryen',
    display_name_zh: '雷妮亚·坦格利安',
    short_identity_zh: '戴蒙之女，尝试驯服偷羊贼',
    house: 'Targaryen',
    tags: ['royalty', 'black', 'dragonrider'],
    actor_versions: [{ actor_name: 'Phoebe Campbell', version: 'adult', active_range: { from: 'S03E01', to: null }, face_group_id: 'rhaena_adult' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: 'Lady',
      title_zh: '坦格利安贵女',
      political_role_zh: '雷妮拉阵营的年轻成员，正在建立自己的龙骑士身份',
      alive: true,
      safe_summary_zh: '戴蒙的女儿。S03E01 中在雾谷尝试驯服偷羊贼，并在后段参与海战。'
    }]
  },
  {
    character_id: 'addam_of_hull',
    canonical_name: 'Addam of Hull',
    display_name_zh: '亚当·胡尔',
    short_identity_zh: '胡尔出身的年轻水手',
    house: 'Hull/Velaryon',
    tags: ['black', 'sailor'],
    actor_versions: [{ actor_name: 'Clinton Liberty', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'addam_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: null,
      title_zh: '水手',
      political_role_zh: '科利斯舰队中的年轻成员，靠近瓦列利安权力核心',
      alive: true,
      safe_summary_zh: '在 S03E01 与科利斯同船，见证喉道伏击并参与舰队应战。'
    }]
  },
  {
    character_id: 'alyn_of_hull',
    canonical_name: 'Alyn of Hull',
    display_name_zh: '亚林·胡尔',
    short_identity_zh: '胡尔出身的水手',
    house: 'Hull/Velaryon',
    tags: ['black', 'sailor'],
    actor_versions: [{ actor_name: 'Abubakar Salim', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'alyn_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: null,
      title_zh: '水手',
      political_role_zh: '科利斯舰队中的成员，与科利斯存在更深的家族线索',
      alive: true,
      safe_summary_zh: '在 S03E01 与科利斯共饮并交谈，处在瓦列利安舰队叙事线中。'
    }]
  },
  {
    character_id: 'ulf_white',
    canonical_name: 'Ulf White',
    display_name_zh: '乌尔夫·怀特',
    short_identity_zh: '龙种，平民出身的龙骑士',
    house: 'Dragonseed',
    tags: ['black', 'dragonseed', 'dragonrider'],
    actor_versions: [{ actor_name: 'Tom Bennett', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'ulf_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: null,
      title_zh: '龙种',
      political_role_zh: '雷妮拉阵营的新晋龙骑士，对身份和奖赏有强烈诉求',
      alive: true,
      safe_summary_zh: 'S03E01 中反复谈及自己的出身、龙血与巨龙，把龙视为越过贵族秩序的权力凭证。'
    }]
  },
  {
    character_id: 'hugh_hammer',
    canonical_name: 'Hugh Hammer',
    display_name_zh: '休·锤',
    short_identity_zh: '龙种，平民出身的龙骑士',
    house: 'Dragonseed',
    tags: ['black', 'dragonseed', 'dragonrider'],
    actor_versions: [{ actor_name: 'Kieran Bew', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'hugh_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: null,
      title_zh: '龙种',
      political_role_zh: '雷妮拉阵营的新晋龙骑士，与乌尔夫一同行动',
      alive: true,
      safe_summary_zh: 'S03E01 中与乌尔夫等人讨论命令、封赏和是否等待瓦格哈尔。'
    }]
  },
  {
    character_id: 'alys_rivers',
    canonical_name: 'Alys Rivers',
    display_name_zh: '亚莉·河文',
    short_identity_zh: '赫伦堡相关的神秘女人',
    house: 'Rivers',
    tags: ['mystic', 'riverlands'],
    actor_versions: [{ actor_name: 'Gayle Rankin', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'alys_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: null,
      title_zh: '女巫般的河间地女人',
      political_role_zh: '以预言和警告影响战局边缘人物',
      alive: true,
      safe_summary_zh: 'S03E01 中突然出现在佣兵面前，警告他们已经错过战争。'
    }]
  },
  {
    character_id: 'vermax',
    canonical_name: 'Vermax',
    display_name_zh: '沃马克斯',
    short_identity_zh: '杰卡里斯的龙',
    house: 'Dragon',
    tags: ['dragon', 'black'],
    actor_versions: [],
    state_timeline: [{ from: 'S03E01', to: null, title_zh: '巨龙', title_en: 'Dragon', political_role_zh: '杰卡里斯的坐骑，黑党空中战力', alive: true, safe_summary_zh: '杰卡里斯骑乘的巨龙，在喉道海战中遭遇重创。' }]
  },
  {
    character_id: 'moondancer',
    canonical_name: 'Moondancer',
    display_name_zh: '月舞',
    short_identity_zh: '贝妮拉的龙',
    house: 'Dragon',
    tags: ['dragon', 'black'],
    actor_versions: [],
    state_timeline: [{ from: 'S03E01', to: null, title_zh: '巨龙', title_en: 'Dragon', political_role_zh: '贝妮拉的坐骑，黑党空中战力', alive: true, safe_summary_zh: '贝妮拉骑乘的巨龙，在喉道海战中多次俯冲攻击敌舰。' }]
  },
  {
    character_id: 'sheepstealer',
    canonical_name: 'Sheepstealer',
    display_name_zh: '偷羊贼',
    short_identity_zh: '野龙',
    house: 'Dragon',
    tags: ['dragon', 'black'],
    actor_versions: [],
    state_timeline: [{ from: 'S03E01', to: null, title_zh: '野龙', title_en: 'Wild dragon', political_role_zh: '雷妮亚试图驯服的巨龙', alive: true, safe_summary_zh: 'S03E01 中被雷妮亚尝试驯服，仍保留明显野性。' }]
  }
];

const STATE_UPDATES = {
  rhaenyra_targaryen: {
    from: 'S03E01',
    to: null,
    title_en: 'Queen claimant',
    title_zh: '黑党女王，铁王座宣称者',
    political_role_zh: '雷妮拉派核心，试图夺取君临并亲自介入喉道战局',
    alive: true,
    safe_summary_zh: 'S03E01 中制定夺取君临的计划，并在喉道危机中坚持亲自参战。'
  },
  daemon_targaryen: {
    from: 'S03E01',
    to: null,
    title_en: 'Prince Consort',
    title_zh: '亲王，雷妮拉的王夫',
    political_role_zh: '黑党军事支柱，在河间地战线推进战事',
    alive: true,
    safe_summary_zh: 'S03E01 中继续河间地战事，并以武力确认敌军动向。'
  },
  corlys_velaryon: {
    from: 'S03E01',
    to: null,
    title_en: 'Lord of the Tides',
    title_zh: '潮汐之主，黑党海军统帅',
    political_role_zh: '以瓦列利安舰队支撑雷妮拉阵营，喉道海战核心人物',
    alive: true,
    safe_summary_zh: 'S03E01 中指挥舰队进入喉道并遭遇伏击。'
  },
  aegon_targaryen_ii: {
    from: 'S03E01',
    to: null,
    title_en: 'King claimant',
    title_zh: '绿党国王，行踪不明',
    political_role_zh: '绿党名义上的王权核心，但本集处于失踪与被搜寻状态',
    alive: true,
    safe_summary_zh: 'S03E01 中以信使身份隐藏行踪，被守卫识破后成为绿党追查焦点。'
  },
  aemond_targaryen: {
    from: 'S03E01',
    to: null,
    title_en: 'Prince Regent',
    title_zh: '摄政王子，瓦格哈尔骑手',
    political_role_zh: '绿党实际军事威慑，围绕伊耿失踪与瓦格哈尔行动制造压力',
    alive: true,
    safe_summary_zh: 'S03E01 中围绕伊耿失踪展开追查，其龙瓦格哈尔成为众人等待或畏惧的力量。'
  },
  alicent_hightower: {
    from: 'S03E01',
    to: null,
    title_en: 'Queen Dowager',
    title_zh: '太后',
    political_role_zh: '绿党宫廷核心人物之一，战争局势中的母亲与政治参与者',
    alive: true,
    safe_summary_zh: 'S03E01 中与海拉娜等人处在绿党宫廷线中，面对战争后果与家族压力。'
  },
  helaena_targaryen: {
    from: 'S03E01',
    to: null,
    title_en: 'Queen',
    title_zh: '王后',
    political_role_zh: '绿党宫廷中的象征性人物，常以预感和疏离感回应局势',
    alive: true,
    safe_summary_zh: 'S03E01 中处于绿党宫廷线，与阿莉森特共同承受战争阴影。'
  }
};

const RELATIONSHIPS = [
  ['rhaenyra_targaryen', 'jacaerys_velaryon', '母子', 'mother-son', 'blood', '杰卡里斯是雷妮拉的长子，也是她在战争中的继承人与保护者。'],
  ['rhaenyra_targaryen', 'baela_targaryen', '盟友 / 继女', 'stepmother-stepdaughter', 'ally', '贝妮拉站在雷妮拉阵营，并以龙骑士身份参战。'],
  ['rhaenyra_targaryen', 'rhaena_targaryen', '盟友 / 继女', 'stepmother-stepdaughter', 'ally', '雷妮亚站在雷妮拉阵营，并试图建立自己的龙骑士身份。'],
  ['daemon_targaryen', 'baela_targaryen', '父女', 'father-daughter', 'blood', '贝妮拉是戴蒙的女儿。'],
  ['daemon_targaryen', 'rhaena_targaryen', '父女', 'father-daughter', 'blood', '雷妮亚是戴蒙的女儿。'],
  ['corlys_velaryon', 'addam_of_hull', '舰队上下级', 'fleet-command', 'ally', '亚当在科利斯舰队中行动，与科利斯同处喉道战局。'],
  ['corlys_velaryon', 'alyn_of_hull', '舰队上下级', 'fleet-command', 'ally', '亚林与科利斯共处瓦列利安舰队线，关系里带有未明说的家族张力。'],
  ['baela_targaryen', 'moondancer', '龙骑士与坐骑', 'dragonrider-dragon', 'ally', '月舞是贝妮拉的龙。'],
  ['rhaena_targaryen', 'sheepstealer', '驯服中的龙骑关系', 'would-be-dragonrider', 'ally', '雷妮亚正在尝试驯服偷羊贼。'],
  ['jacaerys_velaryon', 'vermax', '龙骑士与坐骑', 'dragonrider-dragon', 'ally', '沃马克斯是杰卡里斯的龙。'],
  ['ulf_white', 'hugh_hammer', '龙种同伴', 'dragonseed-companions', 'ally', '乌尔夫与休同为平民出身的龙种，在本集多次一同行动。'],
  ['alys_rivers', 'aemond_targaryen', '神秘牵引', 'mystic-influence', 'secret', '亚莉·河文的出现与警告让绿党和龙骑行动带上神秘色彩。']
];

function upsertCharacter(db, character) {
  const existing = db.characters.find(c => c.character_id === character.character_id);
  if (!existing) {
    db.characters.push(character);
    return 'added';
  }
  for (const [key, value] of Object.entries(character)) {
    if (key === 'state_timeline' || key === 'actor_versions') continue;
    if (existing[key] == null || (Array.isArray(existing[key]) && existing[key].length === 0)) {
      existing[key] = value;
    }
  }
  existing.actor_versions = mergeBy(existing.actor_versions || [], character.actor_versions || [], v => v.version);
  existing.state_timeline = mergeTimeline(existing.state_timeline || [], character.state_timeline || []);
  return 'updated';
}

function mergeBy(existing, incoming, keyFn) {
  const out = [...existing];
  const keys = new Set(out.map(keyFn));
  for (const item of incoming) {
    const key = keyFn(item);
    if (!keys.has(key)) {
      out.push(item);
      keys.add(key);
    }
  }
  return out;
}

function mergeTimeline(existing, incoming) {
  const out = [...existing];
  const keys = new Set(out.map(e => `${e.from}|${e.to || ''}|${e.title_zh || ''}`));
  for (const entry of incoming) {
    const key = `${entry.from}|${entry.to || ''}|${entry.title_zh || ''}`;
    if (!keys.has(key)) {
      out.push(entry);
      keys.add(key);
    }
  }
  out.sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
  return out;
}

function appendState(db, characterId, state) {
  const character = db.characters.find(c => c.character_id === characterId);
  if (!character) return false;
  character.state_timeline = mergeTimeline(character.state_timeline || [], [state]);
  return true;
}

function upsertRelationship(db, source, target, relationZh, relationEn, kind, summaryZh) {
  const existing = (db.relationships || []).find(r =>
    (r.source === source && r.target === target) || (r.source === target && r.target === source)
  );
  const entry = {
    from: 'S03E01',
    to: null,
    relation_zh: relationZh,
    relation_en: relationEn,
    summary_zh: summaryZh,
    relation_kind: kind
  };
  if (!existing) {
    db.relationships.push({ source, target, timeline: [entry] });
    return 'added';
  }
  existing.timeline = mergeTimeline(existing.timeline || [], [entry]);
  return 'updated';
}

function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.relationships = db.relationships || [];

  const characterChanges = { added: 0, updated: 0 };
  for (const character of NEW_CHARACTERS) {
    characterChanges[upsertCharacter(db, character)]++;
  }

  let stateUpdates = 0;
  for (const [id, state] of Object.entries(STATE_UPDATES)) {
    if (appendState(db, id, state)) stateUpdates++;
  }

  const relationshipChanges = { added: 0, updated: 0 };
  for (const args of RELATIONSHIPS) {
    relationshipChanges[upsertRelationship(db, ...args)]++;
  }

  db.s3_character_expansion_at = new Date().toISOString();
  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  console.log(`Characters added=${characterChanges.added}, updated=${characterChanges.updated}`);
  console.log(`State updates=${stateUpdates}`);
  console.log(`Relationships added=${relationshipChanges.added}, updated=${relationshipChanges.updated}`);
}

main();
