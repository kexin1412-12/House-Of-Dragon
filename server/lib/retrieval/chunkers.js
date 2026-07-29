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
    content_hash: hashContent(content), embedding: null,
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

function charChunk({ meta, id, knowledge_type, content, episode, character_ids, confidence }) {
  return {
    id, knowledge_type, content, retrieval_text: content,
    show_id: meta.show_id, video_id: meta.video_id, season: meta.season,
    episode, scene_id: null, start_time: null, end_time: null,
    available_from_episode: episode, available_from_time: null,
    character_ids, location_ids: [], symbol_ids: [],
    source_type: 'character_kb', canonicality: 'episode_verified',
    confidence: confidence == null ? 0.85 : confidence, spoiler_level: 0,
    embedding_model: null, schema_version: 1,
    content_hash: hashContent(content), embedding: null,
  };
}

function chunkCharacters(charDb, meta) {
  const out = [];
  for (const ch of (charDb && charDb.characters) || []) {
    const cid = ch.character_id;
    for (const [i, st] of (ch.state_timeline || []).entries()) {
      const content = [st.title_zh, st.political_role_zh, st.safe_summary_zh].filter(Boolean).join(' / ');
      if (!content) continue;
      out.push(charChunk({ meta, id: `${meta.show_id}:char:${cid}:state:${i}`, knowledge_type: 'character_state', content, episode: st.from || 'S01E01', character_ids: [cid] }));
    }
    for (const [i, mo] of (ch.motivations_timeline || []).entries()) {
      const content = [mo.motivation_zh, mo.evidence_zh].filter(Boolean).join(' — ');
      if (!content) continue;
      out.push(charChunk({ meta, id: `${meta.show_id}:char:${cid}:motive:${i}`, knowledge_type: 'character_motivation', content, episode: mo.from || 'S01E01', character_ids: [cid] }));
    }
  }
  for (const [i, rel] of ((charDb && charDb.relationships) || []).entries()) {
    for (const [j, t] of (rel.timeline || []).entries()) {
      const content = [t.relation_zh || t.relation_en, t.summary_zh, t.evidence_zh].filter(Boolean).join(' — ');
      if (!content) continue;
      out.push(charChunk({ meta, id: `${meta.show_id}:rel:${i}:${j}`, knowledge_type: 'character_relationship', content, episode: t.from || 'S01E01', character_ids: [rel.source, rel.target].filter(Boolean) }));
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
