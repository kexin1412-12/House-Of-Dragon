#!/usr/bin/env node
/**
 * Pre-renders the deep-reading character profiles that the relationship-graph
 * sidebar shows.
 *
 *   node server/scripts/build-character-profiles.js
 *
 * Reads:
 *   - client/public/relationship-graph/_family-tree.json   (which characters)
 *   - server/kb/house_of_dragon_05.json                    (scene fact)
 *   - server/kb/characters/house-of-the-dragon.json        (state + relationships)
 *   - server/references/wiki-gameofthrones.knowledge.json  (house lore)
 *
 * Calls the LLM once per character (Gemini Flash via task=character_profile)
 * and writes the result to:
 *
 *   client/public/relationship-graph/_profiles-house_of_dragon_05.json
 *
 * The frontend reads that static file first; it only falls back to the live
 * /api/agent/character/profile endpoint if the static file is missing.
 *
 * Re-run when the character DB, scene KB, or the LLM prompt changes.
 *
 * Spoiler safety: we use the same end-of-season cursor (S01E10) as
 * build-graph-snapshots.js, since the demo video is a full-season recap.
 * The LLM prompt still bans events past the cursor — at S01E10 that means
 * the entire first season is fair game but nothing from book ch. that
 * follow Lucerys's death.
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const charactersLib = require('../lib/characters');
const ai = require('../lib/ai');

const SHOW_ID = 'house-of-the-dragon';
const VIDEO_ID = 'house_of_dragon_05';
const CURSOR = 'S01E10';

const SERVER_DIR = path.join(__dirname, '..');
const KB_PATH = path.join(SERVER_DIR, 'kb', `${VIDEO_ID}.json`);
const WIKI_PATH = path.join(SERVER_DIR, 'references', 'wiki-gameofthrones.knowledge.json');

const CLIENT_PUBLIC = path.join(SERVER_DIR, '..', 'client', 'public');
const TREE_PATH = path.join(CLIENT_PUBLIC, 'relationship-graph', '_family-tree.json');
const OUT_PATH = path.join(CLIENT_PUBLIC, 'relationship-graph', `_profiles-${VIDEO_ID}.json`);

// ─── Helpers (mirroring the live endpoint) ───────────────────────────
function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function buildSystemPrompt(cursor) {
  return `你是 HBO 政治剧《龙之家族》的"人物档案"写作 agent。任务：把已经按 cursor 过滤好的角色数据写成一段史官式克制的人物解读，配合关系图侧栏展示。

═══ 数据是事实，不是创作素材 ═══
我会给你这个角色截至「${cursor}」（含）为止的安全数据：身份、家族、past states、关系、近期事件、家族 lore。
你的工作是**重新组织+解读**，不要编造材料里没有的事。
材料缺失时写"暂未明朗"或类似克制表达，绝不补全。

═══ 绝对不剧透 ═══
**禁止**：cursor「${cursor}」之后才发生的剧情、未来死亡、未来阵营、未来婚事、龙舞、绿党/黑党正式分裂、阿莉森特/雷尼拉决裂等只在后续集才公开的事件。
**允许**：cursor 当前及之前已经发生的事，包括人物预告（铺垫、动机、矛盾）。
如果你怀疑某条信息是剧透，宁可不写。

═══ 风格 ═══
- 史官式克制（贴合 *Fire & Blood* 历史档案口吻），不是诗化旁白
- 抓政治、家族、继承、矛盾、代价
- 第三人称（"她"/"他"），不写"我"也不写"你"
- 现代汉语，HBO 政治剧译制语气

═══ 绝对禁止用词 ═══
- 古风：执笔、卷宗、史册、羊皮纸、汝、吾、岂、毋、由是
- 仙侠：苍生、天道、轮回、红尘、众生、宿命
- 抒情套话：此刻、命运、改写历史、抉择、宿命、命运之门
- "另一卷"、"书页"、"篇章" 这种自指式书面语

═══ 输出严格 JSON ═══
{
  "headline": "（≤30 字，TA 当前的政治定位 / 家族角色 / 关键张力，一句点睛）",
  "analysis": "（120-200 字，2-3 段，详细解读：身份、家族、动机、当前矛盾。可以引用 past states 显出"角色弧"。不剧透。）",
  "arc_so_far": ["（≤25 字 · 关键节点 1）", "（≤25 字 · 节点 2）", "（≤25 字 · 节点 3）", "..."],
  "book_note": "（≤40 字，可空。如果家族 lore 与 TA 直接相关，写一句"在《血与火》里 House X 是…"的背景注。无关时返回 null）"
}

arc_so_far：3-5 条，按时间顺序，每条是 cursor 之前一个真实发生过的剧情节点（来自 past states / recent_fact）。`;
}

function parseProfileJson(txt) {
  try {
    const m = txt.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function buildOneProfile({ characterId, db, kb, cursor, wiki }) {
  const safe = charactersLib.lookupCharacter(db, characterId, cursor);
  if (!safe) return null;

  const ch = (db.characters || []).find(c => c.character_id === characterId);
  const pastStates = (ch?.state_timeline || []).filter(s => !s.from || s.from <= cursor);
  const arcRaw = pastStates.map(s => ({
    from: s.from, to: s.to,
    title: s.title_zh || s.title_en || null,
    role: s.political_role_zh || null,
    summary: s.safe_summary_zh || null,
  }));

  const allRels = charactersLib.lookupRelationships(db, characterId, cursor);
  const relsWithNames = allRels.map(r => {
    const other = charactersLib.findCharacter(db, r.with);
    return {
      ...r,
      with_name: other?.display_name_zh || other?.canonical_name || r.with,
    };
  }).sort((a, b) => Math.abs(b.intensity_delta || 0) - Math.abs(a.intensity_delta || 0));
  const topRels = relsWithNames.slice(0, 4);

  // No specific scene at this cursor — recap-mode, take the most recent fact
  const lastScene = (kb?.scenes || []).filter(s => s.plot?.fact).slice(-1)[0];
  const recentFact = lastScene?.plot?.fact || null;

  let houseLore = null;
  if (wiki && safe.house) {
    const points = (wiki.knowledge_points || []).filter(p =>
      p.title?.includes(safe.house) || p.source_entity === `House ${safe.house}`
    );
    if (points.length) {
      houseLore = points.slice(0, 2).map(p => p.summary).filter(Boolean).join(' ');
    }
  }

  const fallback = {
    character_id: characterId,
    display_name: safe.display_name,
    headline: safe.short_identity || safe.current?.title || '',
    analysis: safe.current?.summary || '',
    arc_so_far: arcRaw.map(a => a.summary).filter(Boolean).slice(0, 5),
    book_note: null,
    cursor_used: cursor,
    source: 'fallback_no_llm',
  };

  if (!ai.isAvailable('character_profile')) {
    return fallback;
  }

  const system = buildSystemPrompt(cursor);
  const userPayload = {
    cursor_used: cursor,
    character: {
      display_name: safe.display_name,
      canonical_name: safe.canonical_name,
      short_identity: safe.short_identity,
      house: safe.house,
      tags: safe.tags,
      current: safe.current,
    },
    past_states: arcRaw,
    relationships_top: topRels.map(r => ({
      with: r.with_name,
      relation: r.relation,
      kind: r.relation_kind,
      summary: r.summary,
    })),
    recent_event: recentFact ? { fact: recentFact } : null,
    house_lore: houseLore,
  };

  try {
    const result = await ai.chat({
      task: 'character_profile',
      system,
      messages: [{
        role: 'user',
        content: '以下是该角色的安全数据（cursor-filtered），请写档案：\n\n' +
          JSON.stringify(userPayload, null, 2),
      }],
      maxTokens: 900,
      temperature: 0.55,
    });
    const parsed = parseProfileJson(String(result?.text || ''));
    if (!parsed) return { ...fallback, source: 'fallback_parse_fail' };
    return {
      character_id: characterId,
      display_name: safe.display_name,
      headline: parsed.headline || fallback.headline,
      analysis: parsed.analysis || fallback.analysis,
      arc_so_far: Array.isArray(parsed.arc_so_far) ? parsed.arc_so_far.slice(0, 5) : fallback.arc_so_far,
      book_note: parsed.book_note || null,
      cursor_used: cursor,
      source: 'llm',
    };
  } catch (err) {
    console.warn(`[${characterId}] LLM error: ${err.message}`);
    return { ...fallback, source: 'fallback_error', error: err.message };
  }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const tree = loadJson(TREE_PATH);
  if (!tree) { console.error(`[err] tree not found at ${TREE_PATH}`); process.exit(1); }
  const db = charactersLib.loadCharacterDb(SHOW_ID);
  if (!db) { console.error(`[err] character db not loadable for ${SHOW_ID}`); process.exit(1); }
  const kb = loadJson(KB_PATH);
  const wiki = loadJson(WIKI_PATH);

  console.log(`[build] characters=${tree.characters.length} cursor=${CURSOR} ai=${ai.isAvailable('character_profile') ? 'on' : 'off (will use fallback)'}`);

  const profiles = {};
  for (const c of tree.characters) {
    if (!c.character_id) continue;
    process.stdout.write(`  · ${c.character_id} ... `);
    const t0 = Date.now();
    const p = await buildOneProfile({
      characterId: c.character_id,
      db, kb, cursor: CURSOR, wiki,
    });
    if (p) {
      profiles[c.character_id] = p;
      console.log(`${p.source} (${Date.now() - t0}ms)`);
    } else {
      console.log('skipped (not in db)');
    }
  }

  const out = {
    video_id: VIDEO_ID,
    cursor_used: CURSOR,
    generated_at: new Date().toISOString(),
    profiles,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`[ok] wrote ${OUT_PATH}  (${Object.keys(profiles).length} profiles)`);
}

main().catch(err => { console.error('[fatal]', err); process.exit(1); });
