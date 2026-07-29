#!/usr/bin/env node
// Usage: node scripts/eval_retrieval.js
// Runs the current retrieve() over kb/retrieval/eval.json and prints recall + leak gate.
const fs = require('fs');
const path = require('path');
const { evaluate } = require('../lib/retrieval/eval');
const { retrieve } = require('../lib/retrieval');
const { cursorAtTime } = require('../lib/characters');

async function main() {
  const SERVER = path.join(__dirname, '..');
  const spec = JSON.parse(fs.readFileSync(path.join(SERVER, 'kb', 'retrieval', 'eval.json'), 'utf8'));
  const retrieveFn = async (q) => {
    const kb = JSON.parse(fs.readFileSync(path.join(SERVER, 'kb', `${q.videoId}.json`), 'utf8'));
    const cursor = {
      show_id: kb.show_id, video_id: q.videoId, season: kb.season,
      episode: cursorAtTime(kb, q.cursorTime), cursorTime: q.cursorTime, allowedSpoilerLevel: 0,
    };
    const out = await retrieve({ query: q.query, cursor });
    return out.map(c => c.id);
  };
  const r = await evaluate(spec.questions, retrieveFn, spec.k || 8);
  console.log(JSON.stringify({ recall: r.recall, leaks: r.leaks, perQuestion: r.perQuestion }, null, 2));
  if (r.leaks > 0) { console.error('LEAK GATE FAILED'); process.exit(2); }
}
main();
