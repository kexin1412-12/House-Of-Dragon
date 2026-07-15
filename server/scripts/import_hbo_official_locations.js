#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
const OUTPUT_PATH = path.join(SERVER_DIR, 'kb', 'locations', 'house-of-the-dragon.json');
const KNOWLEDGE_PATH = path.join(SERVER_DIR, 'references', 'hbo-official-locations.knowledge.json');
const OFFICIAL_ROOT = 'https://hotd-interactive-map.micro.hbo.com/';
const OFFICIAL_MAP_PAGE = 'https://www.hbo.com/house-of-the-dragon/map-of-westeros';

const LOCATION_META = {
  'altar-room': { name_zh: '祭坛厅', aliases: ['祭坛室'], kind: 'room', region: '君临 / 红堡' },
  'chamber-painted-table': { name_zh: '彩绘桌厅', aliases: ['彩绘桌议事厅', '龙石岛议事厅', '龙石岛，议事厅'], kind: 'council_chamber', region: '龙石岛' },
  courtyard: { name_zh: '外庭院', aliases: ['红堡外庭院'], kind: 'courtyard', region: '君临 / 红堡' },
  dragonmont: { name_zh: '龙山', aliases: ['Dragonmont 火山'], kind: 'volcano', region: '龙石岛', summary_zh: '龙山是笼罩龙石岛的巨大火山，城堡坐落在山脚。火山内部温暖的洞窟适合巨龙栖居、繁殖和产卵。' },
  dragonpit: { name_zh: '龙穴', aliases: ['君临龙穴', '雷妮丝丘龙穴'], kind: 'dragon_habitat', region: '君临', summary_zh: '龙穴位于君临的雷妮丝丘，是坦格利安家族在都城中圈养巨龙的巨大建筑。' },
  dragonstone: { name_zh: '龙石岛', aliases: ['龙石城', 'Dragonstone Castle'], kind: 'island_castle', region: '狭海', tagline_zh: '王储之座', summary_zh: '龙石岛是狭海中的火山岛。瓦雷利亚覆灭后，岛上的同名城堡成为坦格利安家族的祖传居城。' },
  driftmark: { name_zh: '潮头岛', aliases: ['漂木岛', 'Driftmark Island'], kind: 'island', region: '狭海', tagline_zh: '瓦列利安家族领地' },
  'elephant-shell': { name_zh: '象贝壳陈列（官方未命名）', aliases: ['大象贝壳'], kind: 'artifact', region: '潮头岛 / 九航厅' },
  'flea-bottom': { name_zh: '跳蚤窝', aliases: ['跳蚤底'], kind: 'district', region: '君临', summary_zh: '跳蚤窝是君临极度贫困的街区，贫穷、犯罪、乞丐和妓院共同构成其日常环境。' },
  godswood: { name_zh: '神木林', aliases: ['红堡神木林'], kind: 'garden', region: '君临 / 红堡' },
  'great-sept': { name_zh: '大圣堂', aliases: ['君临大圣堂'], kind: 'religious_site', region: '君临', summary_zh: '大圣堂是君临城内七神信仰的宗教礼拜中心。' },
  'hall-of-nine': { name_zh: '九航厅', aliases: ['九航大厅', 'Hall of Nine'], kind: 'great_hall', region: '潮头岛 / 高潮城', summary_zh: '九航厅内设漂木王座，并陈列海蛇九次远航从世界各地带回的艺术品与奇珍。' },
  harrenhal: { name_zh: '赫伦堡', aliases: ['Harrenhal Castle'], kind: 'castle', region: '河间地', tagline_zh: '受诅咒的城堡', summary_zh: '赫伦堡位于河间地神眼湖北岸，是维斯特洛规模最大的城堡。征服战争中它曾被伊耿与贝勒里恩焚毁，后来接连统治此地的家族多遭厄运，因此被普遍视为受诅咒之地。' },
  'high-tide': { name_zh: '高潮城', aliases: ['潮汐堡', '高潮堡'], kind: 'castle', region: '潮头岛', summary_zh: '潮头岛是瓦列利安家族的祖居。科利斯以九次远航积累的财富修建高潮城，用它取代岛另一侧较古老的漂木堡，作为家族的新权力中心。' },
  'kings-apartments': { name_zh: '国王寝宫', aliases: ['国王居所', '红堡国王寝宫'], kind: 'residence', region: '君临 / 红堡' },
  'kings-landing': { name_zh: '君临', aliases: ['君临城', "King's Landing"], kind: 'capital_city', region: '王领', tagline_zh: '七大王国首都', summary_zh: '君临位于维斯特洛东岸、黑水湾畔，是七大王国的首都。红堡、龙穴和大圣堂都位于城内。' },
  kingswood: { name_zh: '御林', aliases: ['国王森林'], kind: 'forest', region: '王领', tagline_zh: '国王猎场', summary_zh: '御林是维斯特洛在位君主的私人狩猎区域。' },
  pentos: { name_zh: '潘托斯', aliases: ['Pentos Free City'], kind: 'free_city', region: '厄斯索斯', tagline_zh: '自由贸易城邦', summary_zh: '潘托斯是九大自由贸易城邦之一，位于厄斯索斯、君临正东方向，是富庶的城邦。' },
  'red-keep': { name_zh: '红堡', aliases: ['君临红堡', "King's Landing, Red Keep"], kind: 'castle', region: '君临', summary_zh: '红堡位于君临东南角，是坦格利安国王的王室城堡，也是铁王座所在之处。' },
  'rhaenyras-apartments': { name_zh: '雷妮拉寝宫', aliases: ['雷妮拉居所', "Rhaenyra's Apartments"], kind: 'residence', region: '龙石岛' },
  runestone: { name_zh: '符石城', aliases: ['奔石城', 'Runestone Castle'], kind: 'castle', region: '艾林谷', tagline_zh: '罗伊斯家族领地', summary_zh: '符石城位于艾林谷、海鸥镇以北的狭海沿岸，是罗伊斯家族的居城。罗伊斯家族曾统治谷地，后来效忠于艾林家族。' },
  skull: { name_zh: '龙骨陈列（官方未命名）', aliases: ['头骨陈列'], kind: 'artifact', region: '潮头岛 / 九航厅' },
  'small-council': { name_zh: '御前会议厅', aliases: ['小议会厅', 'Small Council Chamber'], kind: 'council_chamber', region: '君临 / 红堡' },
  statue: { name_zh: '雕像陈列（官方未命名）', aliases: ['九航厅雕像'], kind: 'artifact', region: '潮头岛 / 九航厅' },
  stepstones: { name_zh: '石阶列岛', aliases: ['踏脚石群岛', 'The Stepstones'], kind: 'archipelago', region: '维斯特洛与厄斯索斯之间', tagline_zh: '争议之地', summary_zh: '石阶列岛是一串位于维斯特洛与厄斯索斯之间的小岛。商船前往世界主要市场时往往必须经过这里。' },
  'stone-bridge': { name_zh: '石桥', aliases: ['龙石岛石桥'], kind: 'bridge', region: '龙石岛', summary_zh: '这座石桥连接龙石城堡与岛上其余区域。' },
  'storms-end': { name_zh: '风息堡', aliases: ["Storm's End Castle"], kind: 'castle', region: '风暴地', tagline_zh: '拜拉席恩家族领地', summary_zh: '风息堡位于维斯特洛东岸的风暴地，是拜拉席恩家族的祖居。它被视为大陆上最坚固的堡垒之一，长久以来从未被风暴或围城攻陷。' },
  'throne-room': { name_zh: '王座厅', aliases: ['君临王座厅', "King's Landing, Throne Room", '红堡王座厅'], kind: 'throne_room', region: '君临 / 红堡' },
  'tournament-grounds': { name_zh: '比武场', aliases: ['君临比武场'], kind: 'arena', region: '君临', summary_zh: '君临的比武场可容纳大量观众，来自各地的骑士在此展示马上长枪和剑术。' },
  'tower-hand': { name_zh: '首相塔', aliases: ['国王之手塔', 'Tower of the Hand'], kind: 'tower', region: '君临 / 红堡' },
  valyria: { name_zh: '瓦雷利亚', aliases: ['旧瓦雷利亚', 'Old Valyria'], kind: 'ruined_city', region: '厄斯索斯', tagline_zh: '毁灭之城', summary_zh: '瓦雷利亚位于厄斯索斯，是坦格利安与瓦列利安家族的祖地。末日浩劫摧毁了这座城市，如今只剩废墟。' },
  vase: { name_zh: '花瓶陈列（官方未命名）', aliases: ['九航厅花瓶'], kind: 'artifact', region: '潮头岛 / 九航厅' },
};

const SUPPLEMENTAL_LOCATIONS = [
  {
    location_id: 'narrow-sea',
    canonical_name: 'Narrow Sea',
    display_name_zh: '狭海',
    aliases: ['狭海海域'],
    kind: 'sea',
    region_zh: '维斯特洛东岸与厄斯索斯之间',
    parent_location_id: null,
    summary_zh: '狭海位于维斯特洛东岸与厄斯索斯西岸之间；官方地图的龙石岛、符石城和潘托斯说明都以它作为地理参照。',
    source_class: 'official_description_reference',
    source_note_zh: 'HBO 官方地图正文提及，但没有设置独立地图标记。',
  },
  {
    location_id: 'vale-of-arryn',
    canonical_name: 'Vale of Arryn',
    display_name_zh: '艾林谷',
    aliases: ['谷地', '山谷', 'The Vale'],
    kind: 'region',
    region_zh: '维斯特洛东部',
    parent_location_id: null,
    summary_zh: 'S03E01 场景使用的区域级地点；官方地图通过符石城条目确认其位于艾林谷，但没有单列谷地标记。',
    source_class: 'episode_extension',
    source_note_zh: '用于绑定 S03E01 的区域级场景。',
  },
  {
    location_id: 'riverlands',
    canonical_name: 'Riverlands',
    display_name_zh: '河间地',
    aliases: ['河间地战场'],
    kind: 'region',
    region_zh: '维斯特洛中部',
    parent_location_id: null,
    summary_zh: 'S03E01 河间地战线的区域级地点；官方地图的赫伦堡条目确认赫伦堡位于河间地。',
    source_class: 'episode_extension',
    source_note_zh: '用于绑定戴蒙、冬狼军与佣兵相关场景。',
  },
  {
    location_id: 'the-gullet',
    canonical_name: 'The Gullet',
    display_name_zh: '喉道',
    aliases: ['喉道海战现场', '龙石岛隘口', '龙石岛隘口上空', '海上战场', '海上战场上空', '海上战船', '海上战船及上空', '海上，龙石岛隘口附近'],
    kind: 'strait',
    region_zh: '狭海 / 龙石岛与潮头岛附近',
    parent_location_id: 'narrow-sea',
    summary_zh: 'S03E01 海战使用的海峡级地点，位于龙石岛与潮头岛相关航道附近。它不属于当前 HBO 官方地图的 32 个独立标记。',
    source_class: 'episode_extension',
    source_note_zh: '来自 S03E01 场景知识库与单集参考资料。',
  },
  {
    location_id: 'kings-landing-gates',
    canonical_name: "King's Landing Gates",
    display_name_zh: '君临城门',
    aliases: ['君临城门外'],
    kind: 'city_gate',
    region_zh: '君临',
    parent_location_id: 'kings-landing',
    summary_zh: 'S03E01 用于区分君临城门场景与红堡内部场景的子地点。',
    source_class: 'episode_extension',
    source_note_zh: '当前 HBO 官方地图未设置独立城门标记。',
  },
];

function parseArgs(argv) {
  const out = { source: null, pageHtml: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') out.source = argv[++i];
    else if (argv[i] === '--page-html') out.pageHtml = argv[++i];
  }
  return out;
}

async function fetchText(url) {
  const fetchImpl = globalThis.fetch || require('undici').fetch;
  const response = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`);
  return response.text();
}

function discoverAppBundleUrl(html) {
  const match = html.match(/<script[^>]+src="([^"]+\/pages\/_app-[^"]+\.js)"/i);
  if (!match) throw new Error('Could not find the Next.js _app bundle');
  return new URL(match[1], OFFICIAL_ROOT).href;
}

function extractOfficialData(bundle) {
  const anchor = '{"config":{"episode":';
  const anchorIndex = bundle.indexOf(anchor);
  if (anchorIndex < 0) throw new Error('Could not find the official locations payload');

  const parseStart = bundle.lastIndexOf('JSON.parse(', anchorIndex);
  const quoteStart = bundle.indexOf("'", parseStart);
  if (parseStart < 0 || quoteStart < 0) throw new Error('Malformed locations payload');

  let quoteEnd = -1;
  for (let i = quoteStart + 1; i < bundle.length; i++) {
    if (bundle[i] !== "'") continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && bundle[j] === '\\'; j--) backslashes++;
    if (backslashes % 2 === 0) {
      quoteEnd = i;
      break;
    }
  }
  if (quoteEnd < 0) throw new Error('Unterminated locations payload');

  const literal = bundle.slice(quoteStart, quoteEnd + 1);
  if (literal.length > 1_000_000) throw new Error('Locations payload is unexpectedly large');
  const jsonText = Function(`"use strict"; return (${literal});`)();
  const data = JSON.parse(jsonText);
  if (!data.locations || typeof data.locations !== 'object') throw new Error('Official payload has no locations object');
  return data;
}

function extractBuildMetadata(pageHtml) {
  if (!pageHtml) return { next_build_id: null, content_build_id: null };
  const nextMatch = pageHtml.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  let nextBuildId = null;
  if (nextMatch) {
    try { nextBuildId = JSON.parse(nextMatch[1]).buildId || null; } catch { /* ignore */ }
  }
  const contentMatch = pageHtml.match(/data-build-id="([^"]+)"/);
  return {
    next_build_id: nextBuildId,
    content_build_id: contentMatch ? contentMatch[1] : null,
  };
}

function absoluteAsset(url) {
  return url ? new URL(url, OFFICIAL_ROOT).href : null;
}

function normalizeAsset(asset) {
  if (!asset) return null;
  return {
    desktop_url: absoluteAsset(asset.url),
    desktop_width: asset.width > 0 ? asset.width : null,
    desktop_height: asset.height > 0 ? asset.height : null,
    mobile_url: absoluteAsset(asset.url_m),
    mobile_width: asset.width_m > 0 ? asset.width_m : null,
    mobile_height: asset.height_m > 0 ? asset.height_m : null,
  };
}

function normalizeOfficialLocation(raw) {
  const meta = LOCATION_META[raw.id];
  if (!meta) throw new Error(`Missing Chinese metadata for official location: ${raw.id}`);
  const aliases = [raw.name, meta.name_zh, ...(meta.aliases || [])].filter(Boolean);
  return {
    location_id: raw.id,
    canonical_name: raw.name || null,
    display_name_zh: meta.name_zh,
    aliases: [...new Set(aliases)],
    kind: meta.kind,
    region_zh: meta.region,
    parent_location_id: raw.parent || null,
    poi_group_id: raw.poi || null,
    related_location_ids: [...new Set((raw.related || []).map(item => item.id).filter(Boolean))],
    first_listed_episode: Number.isFinite(raw.episode) ? `S01E${String(raw.episode).padStart(2, '0')}` : null,
    official_map_entry: true,
    official_tagline_en: raw.desc || null,
    official_tagline_zh: meta.tagline_zh || null,
    official_description_available: Boolean(raw.bio),
    summary_zh: meta.summary_zh || null,
    assets: {
      thumbnail: normalizeAsset(raw._thumb),
      background: normalizeAsset(raw._bg),
      detail: normalizeAsset(raw._large),
    },
    source_class: 'hbo_official_map',
  };
}

function makeKnowledgePoint(location, byId) {
  const parent = location.parent_location_id ? byId.get(location.parent_location_id) : null;
  const fallback = parent
    ? `${location.display_name_zh}是${parent.display_name_zh}下的${location.kind}地点，HBO 官方地图将其列为可识别子地点。`
    : `${location.display_name_zh}是《龙之家族》地点资料中的${location.kind}地点。`;
  return {
    title: `${location.display_name_zh}${location.canonical_name ? `（${location.canonical_name}）` : ''}`,
    type: 'official_location',
    summary: location.summary_zh || fallback,
    safe_hint: location.official_tagline_zh || location.source_note_zh || '地点资料来自 HBO 官方互动地图或已标注的单集补充。',
    related_characters: [],
    related_symbols: [],
    related_locations: [location.location_id, ...(location.aliases || [])],
    importance: location.parent_location_id ? 0.65 : 0.8,
    source_url: OFFICIAL_MAP_PAGE,
    source_class: location.source_class,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let pageHtml = args.pageHtml ? fs.readFileSync(path.resolve(args.pageHtml), 'utf8') : null;
  let bundle;
  let bundleUrl = null;

  if (args.source) {
    bundle = fs.readFileSync(path.resolve(args.source), 'utf8');
  } else {
    pageHtml = pageHtml || await fetchText(OFFICIAL_ROOT);
    bundleUrl = discoverAppBundleUrl(pageHtml);
    bundle = await fetchText(bundleUrl);
  }

  const data = extractOfficialData(bundle);
  const officialLocations = Object.values(data.locations).map(normalizeOfficialLocation);
  const locations = [...officialLocations, ...SUPPLEMENTAL_LOCATIONS.map(item => ({
    ...item,
    aliases: [...new Set([item.canonical_name, item.display_name_zh, ...(item.aliases || [])].filter(Boolean))],
    poi_group_id: null,
    related_location_ids: [],
    first_listed_episode: 'S03E01',
    official_map_entry: false,
    official_tagline_en: null,
    official_tagline_zh: null,
    official_description_available: false,
    assets: { thumbnail: null, background: null, detail: null },
  }))];

  const build = extractBuildMetadata(pageHtml);
  const syncedAt = new Date().toISOString();
  const sourceHash = crypto.createHash('sha256').update(bundle).digest('hex');
  const db = {
    _schema_version: 1,
    show_id: 'house-of-the-dragon',
    source: {
      publisher: 'HBO',
      official_map_page: OFFICIAL_MAP_PAGE,
      interactive_app: OFFICIAL_ROOT,
      next_build_id: build.next_build_id,
      content_build_id: build.content_build_id,
      bundle_url: bundleUrl,
      bundle_sha256: sourceHash,
      synced_at: syncedAt,
      scope_note_zh: '官方地图数据覆盖第一季第 1-10 集；S03E01 所需但地图未单列的地点以 source_class=episode_extension 明确区分。',
    },
    official_location_count: officialLocations.length,
    supplemental_location_count: SUPPLEMENTAL_LOCATIONS.length,
    locations,
  };

  const byId = new Map(locations.map(location => [location.location_id, location]));
  const knowledge = {
    source: 'HBO House of the Dragon Map of Westeros & Essos',
    source_url: OFFICIAL_MAP_PAGE,
    generated_at: syncedAt,
    knowledge_points: locations
      .filter(location => location.canonical_name || location.source_class !== 'hbo_official_map')
      .map(location => makeKnowledgePoint(location, byId)),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  fs.writeFileSync(KNOWLEDGE_PATH, `${JSON.stringify(knowledge, null, 2)}\n`, 'utf8');
  console.log(`Official locations=${officialLocations.length}`);
  console.log(`Supplemental locations=${SUPPLEMENTAL_LOCATIONS.length}`);
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Wrote ${KNOWLEDGE_PATH}`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
