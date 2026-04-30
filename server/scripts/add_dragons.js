/* 把 House of the Dragon 主要龙加进角色库，并连上"龙骑士"关系。
   注：龙以"角色"形式存在（house = 'dragon'，tag 'dragon'），所以现有
   relationship-graph endpoint 不用改 schema 就能渲染他们。 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'kb', 'characters', 'house-of-the-dragon.json');
const BACKUP = DB_PATH + '.backup-dragons-' + Date.now() + '.json';

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
fs.writeFileSync(BACKUP, JSON.stringify(db, null, 2), 'utf8');
console.log('backed up →', BACKUP);

// ── 龙（characters） ──────────────────────────────────
const DRAGONS = [
  { id: 'caraxes',   zh: '凯拉克西斯',  en: 'Caraxes',   short: '血翼，戴蒙的红龙' },
  { id: 'syrax',     zh: '赛拉克丝',    en: 'Syrax',     short: '雷尼拉的金龙' },
  { id: 'vhagar',    zh: '瓦格哈尔',    en: 'Vhagar',    short: '现存最年长、最大的龙' },
  { id: 'meleys',    zh: '梅蕾斯',      en: 'Meleys',    short: '红色女王，蕾妮丝的龙' },
  { id: 'sunfyre',   zh: '阳焰',        en: 'Sunfyre',   short: '伊耿二世的金鳞龙' },
  { id: 'dreamfyre', zh: '梦火',        en: 'Dreamfyre', short: '海拉娜的浅蓝龙' },
  { id: 'seasmoke',  zh: '海雾',        en: 'Seasmoke',  short: '银灰色，劳琳诺的龙' },
];

const existingCharIds = new Set((db.characters || []).map(c => c.character_id));
let charsAdded = 0;
for (const d of DRAGONS) {
  if (existingCharIds.has(d.id)) continue;
  db.characters.push({
    character_id: d.id,
    canonical_name: d.en,
    display_name_zh: d.zh,
    short_identity_zh: d.short,
    house: 'dragon',                 // 渲染时会变 "DRAGON" 副标
    tags: ['dragon'],
    actor_versions: [],
    state_timeline: [],
  });
  charsAdded++;
}

// ── 龙骑士关系 ───────────────────────────────────────
const existingRelKeys = new Set();
for (const r of db.relationships || []) {
  existingRelKeys.add([r.source, r.target].sort().join('::'));
}

const BONDS = [
  // 全程稳定的 bond
  { dragon: 'caraxes',   rider: 'daemon_targaryen',   from: 'S01E01' },
  { dragon: 'syrax',     rider: 'rhaenyra_targaryen', from: 'S01E01' },
  { dragon: 'meleys',    rider: 'rhaenys_targaryen',  from: 'S01E01' },
  { dragon: 'seasmoke',  rider: 'corlys_velaryon',    from: 'S01E01',
    summary: '原本是科利斯之子劳琳诺的龙，剧中没有直接登场太多——这里以瓦列利安家族关联呈现。' },
  // 中期才登场 / 形成 bond
  { dragon: 'vhagar',    rider: 'aemond_targaryen',   from: 'S01E07',
    summary: 'S01E07 哈伦堡，艾蒙德在莱娜·瓦列利安死后大胆抢下空闲的瓦格哈尔。' },
  { dragon: 'sunfyre',   rider: 'aegon_targaryen_ii', from: 'S01E06' },
  { dragon: 'dreamfyre', rider: 'helaena_targaryen',  from: 'S01E06' },
];

let relsAdded = 0;
for (const b of BONDS) {
  const key = [b.dragon, b.rider].sort().join('::');
  if (existingRelKeys.has(key)) continue;
  db.relationships.push({
    source: b.rider,
    target: b.dragon,
    timeline: [{
      from: b.from,
      to: null,
      relation_zh: '龙骑士',
      relation_en: 'dragon-rider',
      summary_zh: b.summary || `${b.rider} 与 ${b.dragon} 之间的龙骑士血誓。`,
    }],
  });
  existingRelKeys.add(key);
  relsAdded++;
}

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
console.log(`added ${charsAdded} dragons + ${relsAdded} bonds`);
console.log(`total characters: ${db.characters.length}, total relationships: ${db.relationships.length}`);
