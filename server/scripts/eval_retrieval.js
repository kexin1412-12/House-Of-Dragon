#!/usr/bin/env node
// Usage: node scripts/eval_retrieval.js
// Runs the current retrieve() over kb/retrieval/eval.json and prints recall + leak gate.
const fs = require('fs');
const path = require('path');
const kbPaths = require('../lib/kb-paths');
const { evaluate } = require('../lib/retrieval/eval');
const { retrieve } = require('../lib/retrieval');
const { cursorAtTime } = require('../lib/characters');

async function main() {
  const SERVER = path.join(__dirname, '..');
  const spec = JSON.parse(fs.readFileSync(path.join(SERVER, 'kb', 'retrieval', 'eval.json'), 'utf8'));

  const currentScene = (kb, t) => (kb.scenes || []).find(s => s.start_time <= t && t < s.end_time) || null;
  const charDbCache = {};
  const loadCharDb = (showId) => {
    if (!(showId in charDbCache)) {
      const p = kbPaths.charactersDb(showId);
      charDbCache[showId] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { characters: [] };
    }
    return charDbCache[showId];
  };

  const retrieveFn = async (q) => {
    const kb = JSON.parse(fs.readFileSync(kbPaths.sceneKb(q.videoId), 'utf8'));
    const cursor = {
      show_id: kb.show_id, video_id: q.videoId, season: kb.season,
      episode: cursorAtTime(kb, q.cursorTime), cursorTime: q.cursorTime, allowedSpoilerLevel: 0,
    };
    // Mirror agent.js: seed retrieval with the on-screen characters' names/aliases.
    const scene = currentScene(kb, q.cursorTime);
    const db = loadCharDb(kb.show_id);
    const charNames = [], charAliases = [];
    for (const cid of (scene && scene.characters) || []) {
      const entry = (db.characters || []).find(c => c.character_id === cid);
      if (!entry) continue;
      if (entry.display_name_zh) charNames.push(entry.display_name_zh);
      if (entry.canonical_name) charAliases.push(entry.canonical_name);
      if (Array.isArray(entry.aliases)) charAliases.push(...entry.aliases);
      if (entry.house) charAliases.push(entry.house);
      if (entry.short_identity_zh) charAliases.push(entry.short_identity_zh);
    }
    const out = await retrieve({
      query: q.query, characterNames: charNames, characterAliases: charAliases,
      cursor, currentScene: scene, characterIds: (scene && scene.characters) || [],
    });
    return out.map(c => c.id);
  };
  const r = await evaluate(spec.questions, retrieveFn, spec.k || 8);
  console.log(JSON.stringify({ recall: r.recall, leaks: r.leaks, perQuestion: r.perQuestion }, null, 2));
  if (r.leaks > 0) { console.error('LEAK GATE FAILED'); process.exit(2); }
}
main();
