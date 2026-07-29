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

module.exports = { hashContent, episodeForScene, chunkScenes, makeChunk, sceneIdNum, epToNum };
