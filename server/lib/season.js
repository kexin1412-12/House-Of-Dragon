/**
 * 季级时间轴 rollup：把 season 元数据 + 角色 DB(关系/动机) + scene KB 的 deep_reading
 * 聚合成"宏观时间轴卡"需要的形状。
 *
 * 核心责任：
 *   1) spoiler-safe filter：cursor < ep 的集只暴露 locked 占位，不下发 synopsis/key_events
 *   2) faction state 计算：把 relationships timeline 在某个 cursor 下的 intensity_delta
 *      按 faction_membership 聚合成 0-100 的对比强度
 *   3) episode events enrich：如果某集有 video_id，叠加 KB 里的 plot.fact / 高价值 narrative
 *   4) causal_links spoiler filter：from 或 to 在 cursor 之后 → 整条 mask
 */

const fs = require('fs');
const path = require('path');
const charactersLib = require('./characters');
const kbPaths = require('./kb-paths');

const SEASONS_DIR = kbPaths.seasonsDir();

const _seasonCache = new Map();
function loadSeason(showId, season) {
  const key = `${showId}.season-${season}`;
  if (_seasonCache.has(key)) return _seasonCache.get(key);
  const p = path.join(SEASONS_DIR, `${showId}.season-${season}.json`);
  if (!fs.existsSync(p)) {
    _seasonCache.set(key, null);
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    _seasonCache.set(key, data);
    return data;
  } catch {
    _seasonCache.set(key, null);
    return null;
  }
}

const _kbCache = new Map();
function loadKBSafe(videoId) {
  if (!videoId) return null;
  if (_kbCache.has(videoId)) return _kbCache.get(videoId);
  const p = kbPaths.sceneKb(videoId);
  if (!fs.existsSync(p)) { _kbCache.set(videoId, null); return null; }
  try {
    const kb = JSON.parse(fs.readFileSync(p, 'utf8'));
    _kbCache.set(videoId, kb);
    return kb;
  } catch {
    _kbCache.set(videoId, null);
    return null;
  }
}

function epToNum(ep) {
  // 'S01E05' → 5
  const m = String(ep || '').match(/^S\d{2}E(\d{2})$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 给 cursor (S01E0N) 后的集打 mask。返回 { episodes, lock_at }。
 * unlocked 集保留全部内容；locked 集只保留 ep_num + locked:true。
 */
function applyEpisodeSpoilerMask(episodes, cursor) {
  const cursorNum = epToNum(cursor);
  return episodes.map(ep => {
    const epNum = ep.ep_num;
    // fail-closed: 没 cursor 时全屏蔽（与 lookupCharacter 的 spoiler-safety 约定一致）
    const locked = cursorNum == null ? true : epNum > cursorNum;
    if (locked) {
      return {
        episode: ep.episode,
        ep_num: ep.ep_num,
        title: null,
        title_zh: null,
        tag: null,
        synopsis: null,
        key_events: [],
        video_id: null,
        locked: true,
      };
    }
    return { ...ep, locked: false };
  });
}

/**
 * 章节弧的 spoiler mask：未进入的弧只露骨架，不下发 label / subtitle，
 * 避免"血龙狂舞"这类弧名直接剧透 E9-E10 走向。
 */
function applyArcsSpoilerMask(arcs, cursor) {
  const cursorNum = epToNum(cursor);
  return (arcs || []).map((arc, i) => {
    const [start, end] = arc.ep_range || [0, 0];
    const entered = cursorNum != null && cursorNum >= start;
    if (!entered) {
      return {
        id: arc.id,
        label_zh: `第 ${i + 1} 章`,
        subtitle_zh: null,
        ep_range: arc.ep_range,
        locked: true,
      };
    }
    return { ...arc, locked: false };
  });
}

function applyCausalSpoilerMask(links, cursor) {
  const cursorNum = epToNum(cursor);
  if (cursorNum == null) return [];
  return links.filter(l => {
    const fn = epToNum(l.from_episode);
    const tn = epToNum(l.to_episode);
    if (fn == null || tn == null) return false;
    // 只暴露起点和终点都已被看过的因果链；任一在未来 → 整条藏起来
    return fn <= cursorNum && tn <= cursorNum;
  });
}

/**
 * 给一集 + cursor 计算阵营势力强度（0-100，相对值）。
 *
 * 算法：
 *   - 拉取 character DB 的 relationships，过滤到 cursor active 的条目
 *   - 对每条 active 关系：把 intensity_delta（-3..+3）按 source 的 faction 归类
 *     · faction = black/green：+intensity_delta 计入该派
 *     · 跨派关系（如 alicent_hightower → rhaenyra_targaryen 是 -3）：
 *       负向计入 source 派的"凝聚力"分数（敌意把己方拉紧）
 *   - 同时统计每派死亡人数（alive=false 的成员）扣分
 *   - 归一化到 0-100，主要展示"哪边更壮"
 *
 * 没有 character DB 时返回 null。
 */
function computeFactionState(showId, cursor, factionMembership) {
  const db = (() => {
    try { return charactersLib.loadCharacterDb(showId); } catch { return null; }
  })();
  if (!db || !cursor) return null;

  const score = { black: 0, green: 0, neutral: 0 };
  const memberCount = { black: 0, green: 0, neutral: 0 };
  const deaths = { black: 0, green: 0, neutral: 0 };

  // 成员 baseline：每个活着的成员给己方 +10 分
  for (const [charId, faction] of Object.entries(factionMembership || {})) {
    if (!score.hasOwnProperty(faction)) continue;
    const card = charactersLib.lookupCharacter(db, charId, cursor);
    if (!card) continue;
    if (card.current && card.current.alive === false) {
      deaths[faction] += 1;
      score[faction] -= 10; // 死亡扣分
      continue;
    }
    memberCount[faction] += 1;
    score[faction] += 10;
  }

  // 关系动量：active relationships 的 intensity_delta 按 source 的派归
  for (const rel of (db.relationships || [])) {
    const active = charactersLib.currentEntry(rel.timeline, cursor);
    if (!active) continue;
    const delta = typeof active.intensity_delta === 'number' ? active.intensity_delta : 0;
    if (delta === 0) continue;
    const sourceFaction = factionMembership[rel.source];
    if (!sourceFaction || !score.hasOwnProperty(sourceFaction)) continue;
    if (delta > 0) {
      score[sourceFaction] += delta * 2; // 友好/盟友关系是凝聚力
    } else {
      // 敌意：黑党对绿党的敌意 = 黑党凝聚力，反过来同理
      score[sourceFaction] += Math.abs(delta);
    }
  }

  // 归一化到 0-100：取 black + green 总和为基线
  const sum = Math.max(1, score.black + score.green);
  const blackPct = Math.round((score.black / sum) * 100);
  const greenPct = 100 - blackPct;

  return {
    black: blackPct,
    green: greenPct,
    raw: { score, memberCount, deaths },
    note: blackPct > greenPct + 10
      ? '黑党明显占优'
      : greenPct > blackPct + 10
        ? '绿党明显占优'
        : '势均力敌 / 形势胶着',
  };
}

/**
 * 用 KB 的 plot.fact + 高价值 narrative 来 enrich 季元数据里写的 key_events。
 *
 * 合并策略（按"同时间戳即同事件"判重，避免 manual 简短事实节点与 KB 富文本叙述
 * 在 UI 上各自占一行重复显示）：
 *   1) 先把 manual key_events 按 t（"MM:SS"）建索引；t 为 null 的另存一份用于
 *      文本前缀兜底匹配。
 *   2) 遍历 KB 中 deep_reading > 200 的高价值 scene：把 start_time 折算成 "MM:SS"。
 *      - 若该 t 在 ±2 秒内命中某条 manual：用 KB 的 narrative 替换该 manual 的
 *        text，但继承 manual 的 crit 标记（manual 才知道哪条是后续剧情的关键节点），
 *        并打上 from_kb: true、scene_id 角标。
 *      - 若没命中 t 但 narrative 头部 12 字与 manual 文本前缀重合（兜底语义判重）：
 *        同样按合并处理。
 *      - 都没命中：作为新条目追加到尾部。
 *   3) 已经被 KB 合并掉的 manual 条目从最终列表里去掉，避免"manual 一条 + KB 一条"
 *      讲同一镜头的双胞现象（典型例子：S01E05 的 56:45 老鼠空镜）。
 */
function enrichEpisodeFromKB(ep, kb) {
  if (!kb || !Array.isArray(kb.scenes)) return ep;
  const richScenes = kb.scenes.filter(s => {
    const dr = (s.plot && s.plot.deep_reading) || '';
    return dr.length > 200;
  });

  const manualEvents = (ep.key_events || []).map(e => ({ ...e }));

  // 把 "MM:SS" 解析成秒数；非法/null → null
  const parseTs = (t) => {
    if (!t || typeof t !== 'string') return null;
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };
  const manualSecs = manualEvents.map(e => parseTs(e.t));
  const consumed = new Set(); // 已被 KB 合并掉的 manual 索引
  const extras = []; // 没命中任何 manual 的纯 KB 条目

  const TS_TOLERANCE_SEC = 2; // 同一镜头的 manual / KB 时间戳常差 1-2 秒

  for (const sc of richScenes) {
    const narr = sc.narrative;
    if (!narr) continue;
    const sec = Math.floor(sc.start_time);
    const ts = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

    // 1) 时间戳匹配（首选）：找一个未被消耗的、t 在容忍内的 manual
    let mergedIdx = -1;
    for (let i = 0; i < manualEvents.length; i++) {
      if (consumed.has(i)) continue;
      const ms = manualSecs[i];
      if (ms == null) continue;
      if (Math.abs(ms - sec) <= TS_TOLERANCE_SEC) { mergedIdx = i; break; }
    }

    // 2) 兜底：仅对 t 为 null 的 manual 条目做文本相似度判重——
    //    早期手写的 key_events（E1-E4 / E6-E10）都没填时间戳，将来若给它们
    //    所在集补 video_id 也要能正确合并。
    //    对已有 t 的 manual 不做文本兜底：因为整集里"韦赛里斯"、"婚宴"这种
    //    主语会在很多 narrative 里复用，会产生大量误判。
    if (mergedIdx === -1) {
      const headSeg = narr.split(/[:：—，。,\.]/)[0] || narr.slice(0, 12);
      for (let i = 0; i < manualEvents.length; i++) {
        if (consumed.has(i)) continue;
        if (manualEvents[i].t) continue; // 有时间戳的 manual 只走 t 匹配
        const mtext = manualEvents[i].text || '';
        if (!mtext) continue;
        let hit = false;
        // 滑窗 5 字子串：5 个连续中文字符在 narrative 与 manual 中同时出现，
        // 误判率足够低（"在赫伦堡死于大火"、"骑瓦格哈尔成功"这类长 phrase）。
        for (let k = 0; k + 5 <= headSeg.length; k++) {
          const sub = headSeg.slice(k, k + 5);
          if (/^[\s,，。:：—、]+$/.test(sub)) continue;
          if (mtext.includes(sub)) { hit = true; break; }
        }
        if (hit) { mergedIdx = i; break; }
      }
    }

    if (mergedIdx !== -1) {
      const m = manualEvents[mergedIdx];
      manualEvents[mergedIdx] = {
        // KB 的富文本叙述胜出（这是 enrich 的差异化价值）
        t: m.t || ts,
        text: narr,
        // 但 crit 由 manual 决定——只有人类编辑知道哪条真的影响后续剧情
        crit: !!m.crit,
        from_kb: true,
        scene_id: sc.scene_id,
        merged_from_manual: true,
      };
      consumed.add(mergedIdx);
      continue;
    }

    extras.push({
      t: ts,
      crit: false,
      text: narr,
      from_kb: true,
      scene_id: sc.scene_id,
    });
  }

  return {
    ...ep,
    key_events: [...manualEvents, ...extras],
  };
}

/**
 * 主入口：组装 timeline 响应。
 * @param {string} showId
 * @param {number} season
 * @param {string|null} cursor   — 'S01E0N' 形式；null = 全 spoiler 屏蔽（只显示骨架）
 * @returns {object|null} 形如 {
 *   show_id, season, season_label,
 *   factions, episodes:[{ep_num, title, tag, synopsis, key_events, factions:{black,green,note}, locked}],
 *   causal_links: [{from_episode, to_episode, kind, label}],
 *   cursor_used,
 *   has_character_db,
 * }
 */
function getSeasonTimeline(showId, season, cursor) {
  const meta = loadSeason(showId, season);
  if (!meta) return null;

  const cursorNum = epToNum(cursor);
  const epsMasked = applyEpisodeSpoilerMask(meta.episodes || [], cursor);

  // 对每个 unlocked 集：计算 faction state、enrich KB
  const epsEnriched = epsMasked.map(ep => {
    if (ep.locked) {
      return { ...ep, factions: null };
    }
    let enriched = ep;
    if (ep.video_id) {
      const kb = loadKBSafe(ep.video_id);
      enriched = enrichEpisodeFromKB(ep, kb);
    }
    // faction state 是"在这一集结束时"的快照
    const factionState = computeFactionState(showId, ep.episode, meta.faction_membership || {});
    return { ...enriched, factions: factionState };
  });

  const causalMasked = applyCausalSpoilerMask(meta.causal_links || [], cursor);
  const arcsMasked = applyArcsSpoilerMask(meta.arcs || [], cursor);

  return {
    show_id: showId,
    season,
    season_label: meta.season_label_zh || `Season ${season}`,
    factions_def: meta.factions || [],
    arcs: arcsMasked,
    episodes: epsEnriched,
    causal_links: causalMasked,
    cursor_used: cursor || null,
    has_character_db: !!charactersLib.loadCharacterDb && !!(() => {
      try { return charactersLib.loadCharacterDb(showId); } catch { return null; }
    })(),
  };
}

module.exports = {
  loadSeason,
  getSeasonTimeline,
  computeFactionState,
  epToNum,
};
