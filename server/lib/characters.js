/**
 * 角色库 retrieval：基于时间游标做 spoiler-safe 过滤。
 *
 * 游标格式 'S01E0N'：字符串字典序比较即可（零填充已经保证 S01E04 < S01E10）。
 * to == null 表示开区间（持续到剧集末尾）。
 *
 * 使用：
 *   const db = loadCharacterDb('house-of-the-dragon');
 *   const card = lookupCharacter(db, 'rhaenyra_targaryen', 'S01E03');
 *   const rels = lookupRelationships(db, 'rhaenyra_targaryen', 'S01E03');
 */

const fs = require('fs');
const path = require('path');

function loadCharacterDb(showId) {
  const p = path.join(__dirname, '..', 'kb', 'characters', `${showId}.json`);
  if (!fs.existsSync(p)) throw new Error(`Character DB not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const _roleplayCache = new Map();
/**
 * Roleplay profiles 用于「角色对谈」模式（共谋者机制 B）。
 * 文件 server/kb/characters/<showId>.roleplay.json 缺失时返回 null（fail-closed）。
 */
function loadRoleplayProfiles(showId) {
  if (!showId) return null;
  if (_roleplayCache.has(showId)) return _roleplayCache.get(showId);
  const p = path.join(__dirname, '..', 'kb', 'characters', `${showId}.roleplay.json`);
  if (!fs.existsSync(p)) {
    _roleplayCache.set(showId, null);
    return null;
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    _roleplayCache.set(showId, j);
    return j;
  } catch {
    _roleplayCache.set(showId, null);
    return null;
  }
}

/** 取某角色在某集的 roleplay profile（若不存在返回 null） */
function lookupRoleplayProfile(showId, characterId, episode) {
  const all = loadRoleplayProfiles(showId);
  if (!all || !all.profiles) return null;
  const profile = all.profiles[characterId];
  if (!profile) return null;
  const boundary = (profile.info_boundary_per_episode || {})[episode] || null;
  return { ...profile, _episode_boundary: boundary, _episode: episode || null };
}

/** 区间命中：from <= cursor && (to == null || cursor <= to) */
function inRange(entry, cursor) {
  if (!cursor) return entry.to == null;
  if (entry.from && entry.from > cursor) return false;
  if (entry.to != null && entry.to < cursor) return false;
  return true;
}

/** 只保留 from <= cursor 的条目（含 to 可超出 cursor 的——身份"持续"）；剔除 from > cursor */
function filterPast(timeline, cursor) {
  if (!Array.isArray(timeline)) return [];
  if (!cursor) return [...timeline];
  return timeline.filter(e => !e.from || e.from <= cursor);
}

/** 当前生效（命中 cursor 区间）的最近一条；没有则取已发生中最晚的一条 */
function currentEntry(timeline, cursor) {
  const past = filterPast(timeline, cursor);
  if (past.length === 0) return null;
  const hit = past.find(e => inRange(e, cursor));
  if (hit) return hit;
  return past.reduce((acc, e) => (acc && acc.from > e.from ? acc : e), null);
}

function findCharacter(db, characterId) {
  return (db.characters || []).find(c => c.character_id === characterId) || null;
}

function currentActorVersion(character, cursor) {
  if (!character || !Array.isArray(character.actor_versions)) return null;
  return character.actor_versions.find(av => inRange(av.active_range || {}, cursor)) || null;
}

/**
 * 当前 cursor 下角色的"安全卡片"：
 *   - 仅含 from <= cursor 的状态（current 用最新生效项）
 *   - alive 默认 true（除非已显式标 false 且时间在 cursor 之前）
 *   - 不暴露未来称号、阵营、死亡
 */
function lookupCharacter(db, characterId, cursor) {
  const ch = findCharacter(db, characterId);
  if (!ch) return null;
  const actor = currentActorVersion(ch, cursor);
  const baseline = {
    character_id: ch.character_id,
    canonical_name: ch.canonical_name,
    display_name: ch.display_name_zh || ch.canonical_name,
    short_identity: ch.short_identity_zh || null,
    house: ch.house || null,
    tags: ch.tags || [],
    current_actor: actor ? { actor_name: actor.actor_name, version: actor.version, face_group_id: actor.face_group_id } : null,
  };

  // 没 cursor → 只暴露 baseline（fail-closed，保 spoiler 安全）
  if (!cursor) {
    return { ...baseline, current: null, history_count: 0, spoiler_safety: 'no_cursor' };
  }

  const state = currentEntry(ch.state_timeline, cursor);
  const pastStates = filterPast(ch.state_timeline, cursor);
  return {
    ...baseline,
    current: state ? {
      title: state.title_zh || state.title_en || null,
      political_role: state.political_role_zh || null,
      alive: state.alive !== false,
      summary: state.safe_summary_zh || null,
    } : null,
    history_count: pastStates.length,
    spoiler_safety: 'cursor_filtered',
  };
}

/**
 * 给定 source character，返回其在 cursor 时的所有有效关系（双向匹配 source/target）。
 * 每条关系返回当前 active 的关系类型 + 简介，便于侧栏展示。
 *
 * 去重：同一对人在 db.relationships[] 里可能有多条（双向 / 分阶段），都同时 active
 * 时保留 from 最晚的那条（最具体 / 最新的状态）。否则关系图会重复出现同一个对手。
 */
function lookupRelationships(db, characterId, cursor) {
  const byOther = new Map();
  for (const rel of db.relationships || []) {
    if (rel.source !== characterId && rel.target !== characterId) continue;
    const otherId = rel.source === characterId ? rel.target : rel.source;
    const direction = rel.source === characterId ? 'outgoing' : 'incoming';
    const active = currentEntry(rel.timeline, cursor);
    if (!active) continue;
    const candidate = {
      with: otherId,
      direction,
      relation: active.relation_zh || active.relation_en,
      relation_kind: active.relation_kind || null,
      intensity_delta: typeof active.intensity_delta === 'number' ? active.intensity_delta : null,
      summary: active.summary_zh || null,
      triggered_by_scene_id: active.triggered_by_scene_id || null,
      evidence: active.evidence_zh || null,
      _from: active.from || 'S01E01', // 用于去重时挑最具体那条
    };
    const prev = byOther.get(otherId);
    if (!prev) { byOther.set(otherId, candidate); continue; }
    // 选 from 更晚的（更具体阶段）；from 相同时偏 incoming（"别人怎么看 hero" 通常更具张力）
    if (candidate._from > prev._from) byOther.set(otherId, candidate);
    else if (candidate._from === prev._from && candidate.direction === 'incoming' && prev.direction !== 'incoming') {
      byOther.set(otherId, candidate);
    }
  }
  return Array.from(byOther.values()).map(({ _from, ...rest }) => rest);
}

/**
 * 取角色当前 active 的驱动力（motivation）。motivations_timeline 是
 * relationship-event-agent 写入的字段；不存在则返回 null。
 * 同 lookupCharacter 一样：cursor 缺失 → 不暴露任何动机（spoiler-safe）。
 */
function lookupMotivation(db, characterId, cursor) {
  if (!cursor) return null;
  const ch = findCharacter(db, characterId);
  if (!ch || !Array.isArray(ch.motivations_timeline)) return null;
  const active = currentEntry(ch.motivations_timeline, cursor);
  if (!active) return null;
  return {
    motivation: active.motivation_zh || null,
    triggered_by_scene_id: active.triggered_by_scene_id || null,
    evidence: active.evidence_zh || null,
  };
}

/**
 * 找一张龙的肖像（kb/characters/dragon_refs/<id>.<ext>）。返回相对 URL 或 null。
 * 与 face_refs（按角色 + actor_version 分目录）不同，dragon_refs 是扁平的。 */
const _dragonPortraitCache = new Map();
function pickDragonPortraitUrl(dragonId) {
  if (!dragonId) return null;
  if (_dragonPortraitCache.has(dragonId)) return _dragonPortraitCache.get(dragonId);
  const dir = path.join(__dirname, '..', 'kb', 'characters', 'dragon_refs');
  let url = null;
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith(dragonId + '.') && /\.(jpg|jpeg|png|webp)$/i.test(f));
      if (files.length > 0) {
        url = `/kb/characters/dragon_refs/${encodeURIComponent(files[0])}`;
      }
    }
  } catch { /* swallow */ }
  _dragonPortraitCache.set(dragonId, url);
  return url;
}

/**
 * 在 character 的所有 active relationships 里，找一个"对方带某 tag"的伙伴。
 * 用于：把"龙骑士"关系从关系图边线降级为节点上的从属伙伴（companion attachment）。
 *
 * - 龙不是 first-class 关系节点，是角色的延伸属性（"骑乘 / 缔结血誓的伙伴"）
 * - 如果角色有多条"对方是龙"的关系（极少），返回最先匹配的一条
 * - 没有则返回 null
 */
function findCompanionByTag(db, characterId, cursor, tag) {
  if (!characterId || !tag) return null;
  for (const rel of db.relationships || []) {
    if (rel.source !== characterId && rel.target !== characterId) continue;
    const otherId = rel.source === characterId ? rel.target : rel.source;
    const otherCard = findCharacter(db, otherId);
    if (!otherCard) continue;
    if (!Array.isArray(otherCard.tags) || !otherCard.tags.includes(tag)) continue;
    const active = currentEntry(rel.timeline, cursor);
    if (!active) continue;
    // tag === 'dragon' 时附上 dragon 肖像；其它 tag 暂未启用图片渠道
    const portrait_url = tag === 'dragon' ? pickDragonPortraitUrl(otherId) : null;
    return {
      character_id: otherId,
      display_name: otherCard.display_name_zh || otherCard.canonical_name || otherId,
      short_identity: otherCard.short_identity_zh || null,
      bond_relation: active.relation_zh || active.relation_en,
      portrait_url,
    };
  }
  return null;
}

/** 判断某个角色是否带某 tag（例：用来在 lookupRelationships 之外过滤龙）。 */
function characterHasTag(db, characterId, tag) {
  const c = findCharacter(db, characterId);
  return !!(c && Array.isArray(c.tags) && c.tags.includes(tag));
}

/**
 * 给定一组 character_id（如 scene.characters[].id），返回每个角色的安全卡片。
 * 用于"当前出场人物面板"。
 */
function lookupOnScreen(db, characterIds, cursor) {
  return (characterIds || [])
    .map(id => lookupCharacter(db, id, cursor))
    .filter(Boolean);
}

/**
 * 把 KB 里的 cursorTime（秒）翻译成角色库的 cursor（如 'S01E04'）。
 * 依赖 kb.episode_map：[{ from_scene: 's01', to_scene: 's14', episode: 'S01E01' }, ...]
 * 找不到映射返回 null（fail-closed）。
 */
function cursorAtTime(kb, cursorTime) {
  if (!kb || !Array.isArray(kb.episode_map) || kb.episode_map.length === 0) return null;
  const scene = (kb.scenes || []).find(s => s.start_time <= cursorTime && cursorTime < s.end_time);
  if (!scene) return null;
  const sceneIdNum = sceneIdToNum(scene.scene_id);
  if (sceneIdNum == null) return null;
  for (const m of kb.episode_map) {
    const from = sceneIdToNum(m.from_scene);
    const to = sceneIdToNum(m.to_scene);
    if (from == null || to == null) continue;
    if (sceneIdNum >= from && sceneIdNum <= to) return m.episode || null;
  }
  return null;
}

function sceneIdToNum(sid) {
  if (!sid) return null;
  const m = String(sid).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 找一张当前 actor version 下的肖像图，返回相对 URL
 *   /kb/characters/face_refs/<characterId>/<version>/<file>
 * 没有可用图片返回 null。文件按字典序取第一张（face_refs 里 fd_01_* 通常就是首选）。
 */
const _portraitCache = new Map();
function pickPortraitUrl(characterId, actorVersion) {
  if (!characterId || !actorVersion) return null;
  const key = `${characterId}/${actorVersion}`;
  if (_portraitCache.has(key)) return _portraitCache.get(key);

  const dir = path.join(__dirname, '..', 'kb', 'characters', 'face_refs', characterId, actorVersion);
  let url = null;
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir)
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .sort();
      if (files.length > 0) {
        // URL 编码以保证空格 / 中文之类不破坏 URL
        url = `/kb/characters/face_refs/${encodeURIComponent(characterId)}/${encodeURIComponent(actorVersion)}/${encodeURIComponent(files[0])}`;
      }
    }
  } catch { /* swallow — 缺图就让前端走文字 fallback */ }

  _portraitCache.set(key, url);
  return url;
}

module.exports = {
  loadCharacterDb,
  loadRoleplayProfiles,
  lookupRoleplayProfile,
  findCharacter,
  currentActorVersion,
  currentEntry,
  filterPast,
  lookupCharacter,
  lookupRelationships,
  lookupMotivation,
  findCompanionByTag,
  characterHasTag,
  lookupOnScreen,
  cursorAtTime,
  pickPortraitUrl,
};
