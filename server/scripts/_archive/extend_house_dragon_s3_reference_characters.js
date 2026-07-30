#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
const DB_PATH = path.join(SERVER_DIR, 'kb', 'characters', 'house-of-the-dragon.json');

const OFFICIAL_CANON_SOURCES = [
  {
    name: 'HBO House of the Dragon Interactive Guide',
    url: 'https://hotd-interactive-map.micro.hbo.com/',
    priority: 'official',
    use_for: [
      'canonical_name',
      'title_en',
      'house',
      'family',
      'faction',
      'map_context',
      'dragon_entries',
    ],
  },
];

const CHARACTERS = [
  {
    character_id: 'tyland_lannister',
    canonical_name: 'Tyland Lannister',
    display_name_zh: '泰兰·兰尼斯特',
    short_identity_zh: '兰尼斯特家族成员，绿党官员',
    house: 'Lannister',
    tags: ['green', 'court', 'lannister'],
    actor_versions: [{ actor_name: 'Jefferson Hall', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'tyland_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: 'Lord',
      title_zh: '兰尼斯特贵族',
      political_role_zh: '绿党阵营的宫廷与军事联络人物，在海战中被迫面对真实战场',
      alive: true,
      safe_summary_zh: 'S03E01 中从宫廷权力网络进入喉道战局，身份从官员被重新放到战场压力下检验。'
    }]
  },
  {
    character_id: 'sharako_lohar',
    canonical_name: 'Sharako Lohar',
    display_name_zh: '沙拉科·洛哈尔',
    short_identity_zh: '三女儿王国舰队指挥者',
    house: 'Triarchy',
    tags: ['triarchy', 'commander', 'antagonist'],
    actor_versions: [{ actor_name: 'Abigail Thorn', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'sharako_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: 'Admiral',
      title_zh: '三女儿王国舰队指挥者',
      political_role_zh: '三女儿王国进攻视点，与科利斯构成外来进攻者和本土海域专家的对照',
      alive: true,
      safe_summary_zh: 'S03E01 中率三女儿王国舰队进入喉道，主动攻击瓦列利安舰队。'
    }]
  },
  {
    character_id: 'gwayne_hightower',
    canonical_name: 'Gwayne Hightower',
    display_name_zh: '格韦恩·海塔尔',
    short_identity_zh: '阿莉森特的兄弟，海塔尔家族成员',
    house: 'Hightower',
    tags: ['green', 'hightower', 'soldier'],
    actor_versions: [{ actor_name: 'Freddie Fox', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'gwayne_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: 'Ser',
      title_zh: '海塔尔骑士',
      political_role_zh: '绿党军政线中的观察者，连接阿莉森特、科尔与海塔尔家族利益',
      alive: true,
      safe_summary_zh: 'S03E01 中处在海塔尔军营与绿党军事线，常承担现实提醒和道德质询功能。'
    }]
  },
  {
    character_id: 'ormund_hightower',
    canonical_name: 'Ormund Hightower',
    display_name_zh: '奥蒙德·海塔尔',
    short_identity_zh: '海塔尔家族地方军事贵族',
    house: 'Hightower',
    tags: ['green', 'hightower', 'commander'],
    actor_versions: [{ actor_name: 'James Norton', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'ormund_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: 'Lord Hightower',
      title_zh: '海塔尔领主',
      political_role_zh: '河湾地海塔尔军队的统领，更接近地方军事贵族而非君临宫廷人物',
      alive: true,
      safe_summary_zh: 'S03E01 中作为海塔尔军队的新军事视点进入故事，强调秩序、身份和军纪。'
    }]
  },
  {
    character_id: 'oscar_tully',
    canonical_name: 'Oscar Tully',
    display_name_zh: '奥斯卡·徒利',
    short_identity_zh: '奔流城公爵，河间地年轻领主',
    house: 'Tully',
    tags: ['riverlands', 'lord', 'black'],
    actor_versions: [{ actor_name: 'Archie Barnes', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'oscar_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: 'Lord of Riverrun',
      title_zh: '奔流城公爵',
      political_role_zh: '以礼制和合法性约束戴蒙暴力的河间地年轻最高领主',
      alive: true,
      safe_summary_zh: 'S03E01 河间地线中，年轻但握有政治合法性，用领主身份制衡戴蒙。'
    }]
  },
  {
    character_id: 'roderick_dustin',
    canonical_name: 'Roderick Dustin',
    display_name_zh: '罗德里克·达斯丁',
    short_identity_zh: '北境冬狼军领袖',
    house: 'Dustin',
    tags: ['north', 'winter-wolves', 'soldier'],
    actor_versions: [{ actor_name: 'Tommy Flanagan', version: 'default', active_range: { from: 'S03E01', to: null }, face_group_id: 'roderick_default' }],
    state_timeline: [{
      from: 'S03E01',
      to: null,
      title_en: 'Lord',
      title_zh: '北境领主',
      political_role_zh: '北境冬狼军的粗粝战争视点，代表主动赴死的北境战争信念',
      alive: true,
      safe_summary_zh: 'S03E01 河间地与北境军线中，以冬狼军领袖身份进入战局。'
    }]
  }
];

const STATE_UPDATES = {
  mysaria: {
    from: 'S03E01',
    to: null,
    title_en: null,
    title_zh: '白虫，雷妮拉的信息顾问',
    political_role_zh: '雷妮拉身边的信息网络与现实判断来源，代表平民情报和宫廷外部视角',
    alive: true,
    safe_summary_zh: 'S03E01 中与雷妮拉同处龙石岛封闭空间，功能上补足信息、安抚和现实判断。'
  },
  larys_strong: {
    from: 'S03E01',
    to: null,
    title_en: 'Lord Confessor',
    title_zh: '拉里斯·斯壮',
    political_role_zh: '绿党阴影中的筹码管理者，与伊耿形成逃亡依存关系',
    alive: true,
    safe_summary_zh: 'S03E01 中与伊耿处于逃亡线，掌握信息与安排，也把伊耿视为未来政治筹码。'
  },
  criston_cole: {
    from: 'S03E01',
    to: null,
    title_en: 'Lord Commander',
    title_zh: '御林铁卫队长，绿党军职核心',
    political_role_zh: '绿党军事指挥者，开始面对自己参与制造的战争后果',
    alive: true,
    safe_summary_zh: 'S03E01 中承受战争疲惫与指挥责任，不再只是由欲望和怨恨推动。'
  }
};

const RELATIONSHIPS = [
  ['rhaenyra_targaryen', 'mysaria', '女王与情报顾问', 'queen-advisor', 'ally', '弥赛丽亚为雷妮拉提供信息、平民网络和现实判断。'],
  ['aegon_targaryen_ii', 'larys_strong', '逃亡依存', 'fugitive-dependency', 'secret', '伊耿需要拉里斯安排逃亡，拉里斯需要伊耿作为未来政治筹码。'],
  ['alicent_hightower', 'aemond_targaryen', '母子 / 权力恐惧', 'mother-son-power-fear', 'blood', '阿莉森特面对伊蒙德时混杂亲情、恐惧、厌恶与政治判断。'],
  ['criston_cole', 'gwayne_hightower', '军中同僚', 'military-companions', 'ally', '格韦恩在科尔身边承担观察者、现实提醒者和海塔尔利益代表功能。'],
  ['gwayne_hightower', 'ormund_hightower', '海塔尔家族同盟', 'hightower-kin', 'blood', '二人同属海塔尔家族，但奥蒙德更接近地方军事贵族。'],
  ['daemon_targaryen', 'oscar_tully', '暴力与合法性的拉扯', 'violence-vs-legitimacy', 'ally', '奥斯卡虽年轻，却以河间地合法性约束戴蒙的暴力。'],
  ['daemon_targaryen', 'roderick_dustin', '战场同盟', 'battlefield-allies', 'ally', '罗德里克代表北境冬狼军的主动赴死信念，与戴蒙河间地战线相连。'],
  ['corlys_velaryon', 'sharako_lohar', '海战对手', 'naval-rivals', 'enemy', '沙拉科率外来舰队进攻，科利斯凭本土海域经验反制。'],
  ['tyland_lannister', 'sharako_lohar', '绿党与三女儿王国合作线', 'green-triarchy-contact', 'ally', '泰兰作为绿党代表被卷入三女儿王国舰队与喉道战局。']
];

function mergeTimeline(existing, incoming) {
  const out = [...existing];
  const keys = new Set(out.map(e => `${e.from}|${e.to || ''}|${e.title_zh || e.relation_zh || ''}`));
  for (const entry of incoming) {
    const key = `${entry.from}|${entry.to || ''}|${entry.title_zh || entry.relation_zh || ''}`;
    if (!keys.has(key)) {
      out.push(entry);
      keys.add(key);
    }
  }
  out.sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
  return out;
}

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

function normalizeSourceUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';
    url.search = '';
    return url.href.replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
  }
}

function mergeCanonSources(existing, incoming) {
  const out = existing.map(source => ({ ...source }));
  for (const source of incoming) {
    const key = normalizeSourceUrl(source.url);
    const current = out.find(item => normalizeSourceUrl(item.url) === key);
    if (!current) {
      out.push({ ...source, use_for: [...(source.use_for || [])] });
      continue;
    }
    for (const [field, value] of Object.entries(source)) {
      if (field === 'use_for') continue;
      if (current[field] == null || current[field] === '') current[field] = value;
    }
    current.use_for = [...new Set([...(current.use_for || []), ...(source.use_for || [])])];
  }
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
  const entry = { from: 'S03E01', to: null, relation_zh: relationZh, relation_en: relationEn, relation_kind: kind, summary_zh: summaryZh };
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
  db._canon_sources = mergeCanonSources(db._canon_sources || [], OFFICIAL_CANON_SOURCES);

  const characterChanges = { added: 0, updated: 0 };
  for (const character of CHARACTERS) characterChanges[upsertCharacter(db, character)]++;

  let stateUpdates = 0;
  for (const [id, state] of Object.entries(STATE_UPDATES)) {
    if (appendState(db, id, state)) stateUpdates++;
  }

  const relationshipChanges = { added: 0, updated: 0 };
  for (const args of RELATIONSHIPS) relationshipChanges[upsertRelationship(db, ...args)]++;

  db.s3_reference_expansion_at = new Date().toISOString();
  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  console.log(`Reference characters added=${characterChanges.added}, updated=${characterChanges.updated}`);
  console.log(`State updates=${stateUpdates}`);
  console.log(`Reference relationships added=${relationshipChanges.added}, updated=${relationshipChanges.updated}`);
}

main();
