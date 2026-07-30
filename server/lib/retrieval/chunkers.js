const crypto = require('crypto');
const { epToNum } = require('./temporal-filter');

function hashContent(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex');
}

function sceneIdNum(sid) {
  const m = String(sid || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function episodeForScene(kb, sceneId) {
  const n = sceneIdNum(sceneId);
  for (const m of kb.episode_map || []) {
    const from = sceneIdNum(m.from_scene), to = sceneIdNum(m.to_scene);
    if (n != null && from != null && to != null && n >= from && n <= to) return m.episode || null;
  }
  return null;
}

function makeChunk({ kb, id, knowledge_type, content, retrieval_text, scene_id, episode, time, character_ids }) {
  return {
    id, knowledge_type, content,
    retrieval_text: retrieval_text || content,
    show_id: kb.show_id, video_id: kb.video_id,
    season: kb.season, episode, scene_id,
    start_time: null, end_time: null,
    available_from_episode: episode, available_from_time: time,
    character_ids: character_ids || [], location_ids: [], symbol_ids: [],
    source_type: 'scene_kb', canonicality: 'episode_verified',
    confidence: 0.9, spoiler_level: 0,
    embedding_model: null, schema_version: 1,
    // Hash the embedded text (retrieval_text), so re-embed triggers when it changes.
    content_hash: hashContent(retrieval_text || content), embedding: null,
  };
}

function chunkScenes(kb) {
  const out = [];
  for (const scene of kb.scenes || []) {
    const episode = episodeForScene(kb, scene.scene_id);
    for (const beat of scene.visual_beats || []) {
      const parts = [beat.meaning, beat.aesthetic_reading, ...(beat.thematic_mirrors || [])].filter(Boolean);
      if (parts.length === 0) continue;
      const content = parts.join('\n');
      out.push(makeChunk({
        kb, id: `${kb.video_id}:scene:${scene.scene_id}:${beat.beat_id}:reading`,
        knowledge_type: 'scene_reading', content,
        retrieval_text: [content, ...(scene.characters || [])].join(' '),
        scene_id: scene.scene_id, episode,
        time: typeof beat.start_time === 'number' ? beat.start_time : scene.start_time,
        character_ids: scene.characters || [],
      }));
    }
    const tap = scene.tapestry_meta_reading;
    if (tap && typeof tap === 'object') {
      const content = Object.values(tap).filter(v => typeof v === 'string').join('\n');
      if (content) {
        out.push(makeChunk({
          kb, id: `${kb.video_id}:scene:${scene.scene_id}:tapestry:reading`,
          knowledge_type: 'scene_reading', content,
          scene_id: scene.scene_id, episode, time: scene.start_time,
          character_ids: scene.characters || [],
        }));
      }
    }
  }
  return out;
}

function charChunk({ meta, id, knowledge_type, content, episode, character_ids, confidence, retrieval_text }) {
  return {
    id, knowledge_type, content, retrieval_text: retrieval_text || content,
    show_id: meta.show_id, video_id: meta.video_id, season: meta.season,
    episode, scene_id: null, start_time: null, end_time: null,
    available_from_episode: episode, available_from_time: null,
    character_ids, location_ids: [], symbol_ids: [],
    source_type: 'character_kb', canonicality: 'episode_verified',
    confidence: confidence == null ? 0.85 : confidence, spoiler_level: 0,
    embedding_model: null, schema_version: 1,
    content_hash: hashContent(retrieval_text || content), embedding: null,
  };
}

// 名称词：给某个角色 id 拼出中文名/别名/家族/身份，注入 retrieval_text 以便
// 按人名提问（"阿莉森特和雷妮拉的关系"）能命中——content 保持干净不动（spec §4）。
function nameTermsFor(charDb, id) {
  const ch = ((charDb && charDb.characters) || []).find(c => c.character_id === id);
  if (!ch) return '';
  return [ch.display_name_zh, ch.canonical_name, ...(ch.aliases || []), ch.short_identity_zh, ch.house]
    .filter(Boolean).join(' ');
}

function chunkCharacters(charDb, meta) {
  const out = [];
  for (const ch of (charDb && charDb.characters) || []) {
    const cid = ch.character_id;
    const names = nameTermsFor(charDb, cid);
    for (const [i, st] of (ch.state_timeline || []).entries()) {
      const content = [st.title_zh, st.political_role_zh, st.safe_summary_zh].filter(Boolean).join(' / ');
      if (!content) continue;
      out.push(charChunk({ meta, id: `${meta.show_id}:char:${cid}:state:${i}`, knowledge_type: 'character_state', content, retrieval_text: `${content} ${names}`.trim(), episode: st.from || 'S01E01', character_ids: [cid] }));
    }
    for (const [i, mo] of (ch.motivations_timeline || []).entries()) {
      const content = [mo.motivation_zh, mo.evidence_zh].filter(Boolean).join(' — ');
      if (!content) continue;
      out.push(charChunk({ meta, id: `${meta.show_id}:char:${cid}:motive:${i}`, knowledge_type: 'character_motivation', content, retrieval_text: `${content} ${names}`.trim(), episode: mo.from || 'S01E01', character_ids: [cid] }));
    }
  }
  for (const [i, rel] of ((charDb && charDb.relationships) || []).entries()) {
    const relNames = [nameTermsFor(charDb, rel.source), nameTermsFor(charDb, rel.target)].filter(Boolean).join(' ');
    for (const [j, t] of (rel.timeline || []).entries()) {
      const content = [t.relation_zh || t.relation_en, t.summary_zh, t.evidence_zh].filter(Boolean).join(' — ');
      if (!content) continue;
      out.push(charChunk({ meta, id: `${meta.show_id}:rel:${i}:${j}`, knowledge_type: 'character_relationship', content, retrieval_text: `${content} ${relNames}`.trim(), episode: t.from || 'S01E01', character_ids: [rel.source, rel.target].filter(Boolean) }));
    }
  }
  return out;
}

function genericChunk({ meta, id, knowledge_type, content, episode, character_ids, source_type, confidence }) {
  return {
    id, knowledge_type, content, retrieval_text: content,
    show_id: meta.show_id, video_id: meta.video_id, season: meta.season,
    episode, scene_id: null, start_time: null, end_time: null,
    available_from_episode: episode, available_from_time: null,
    character_ids: character_ids || [], location_ids: [], symbol_ids: [],
    source_type, canonicality: source_type === 'wiki' ? 'lore' : 'recap',
    confidence: confidence == null ? 0.6 : confidence, spoiler_level: 0,
    embedding_model: null, schema_version: 1,
    content_hash: hashContent(content), embedding: null,
  };
}

function chunkLore(knowledgeJson, meta) {
  const out = [];
  for (const [i, kp] of ((knowledgeJson && knowledgeJson.knowledge_points) || []).entries()) {
    const content = [kp.title, kp.summary, kp.safe_hint || kp.expanded_explanation].filter(Boolean).join(' — ');
    if (!content) continue;
    out.push(genericChunk({
      meta, id: `${meta.show_id}:lore:${i}`, knowledge_type: 'lore_card', content,
      episode: 'S01E01', character_ids: kp.related_characters || [], source_type: 'wiki',
      confidence: typeof kp.confidence === 'number' ? kp.confidence : (kp.importance || 0.6),
    }));
  }
  return out;
}

function chunkRecap(taggedPoints, meta) {
  const out = [];
  for (const [i, p] of (taggedPoints || []).entries()) {
    if (!p.available_from_episode) continue; // untagged → excluded
    const content = [p.title, p.summary || p.point, p.safe_hint || p.agent_answer].filter(Boolean).join(' — ');
    if (!content) continue;
    out.push(genericChunk({
      meta, id: `${meta.show_id}:recap:${i}`, knowledge_type: 'external_knowledge', content,
      episode: p.available_from_episode, character_ids: p.related_characters || p.related_character || [], source_type: 'recap',
      confidence: typeof p.confidence === 'number' ? p.confidence : 0.55,
    }));
  }
  return out;
}

module.exports = { hashContent, episodeForScene, chunkScenes, makeChunk, sceneIdNum, epToNum, chunkCharacters, chunkLore, chunkRecap };
