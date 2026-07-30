#!/usr/bin/env node
// Usage: node scripts/build_retrieval_index.js <showId> [videoId ...]
// Full rebuild if no existing index; otherwise incremental sync by id+content_hash.
const fs = require('fs');
const path = require('path');
const kbPaths = require('../lib/kb-paths');
const { chunkScenes, chunkCharacters, chunkLore, chunkRecap } = require('../lib/retrieval/chunkers');
const { syncIndex, embedMissing } = require('../lib/retrieval/index-builder');
const { EMBEDDING_MODEL } = require('../lib/retrieval/vector-store');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function main() {
  const [showId, ...videoIds] = process.argv.slice(2);
  if (!showId) { console.error('args: <showId> [videoId ...]'); process.exit(1); }
  const SERVER = path.join(__dirname, '..');
  const fresh = [];

  for (const vid of videoIds) {
    const kb = readJson(kbPaths.sceneKb(vid));
    fresh.push(...chunkScenes(kb));
  }
  const charPath = kbPaths.charactersDb(showId);
  if (fs.existsSync(charPath)) {
    fresh.push(...chunkCharacters(readJson(charPath), { show_id: showId, video_id: null, season: 1 }));
  }
  const refsDir = path.join(SERVER, 'references');
  for (const f of fs.readdirSync(refsDir)) {
    if (f.startsWith('wiki-') && f.endsWith('.knowledge.json')) {
      fresh.push(...chunkLore(readJson(path.join(refsDir, f)), { show_id: showId, video_id: null, season: 1 }));
    }
  }
  const taggedRecap = kbPaths.vectors(showId).replace('.vectors.json', '.recap-tagged.json');
  if (fs.existsSync(taggedRecap)) {
    fresh.push(...chunkRecap(readJson(taggedRecap), { show_id: showId, video_id: null, season: 1 }));
  }

  const outDir = path.dirname(kbPaths.vectors(showId));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = kbPaths.vectors(showId);
  const existing = fs.existsSync(outPath) ? readJson(outPath) : [];

  const { merged, added, updated, deleted } = syncIndex(existing, fresh);

  const { createOpenAIClient } = require('../lib/ai/openai-client');
  const client = createOpenAIClient();
  const embedFn = async (text) => (await client.embeddings.create({ model: EMBEDDING_MODEL, input: text })).data[0].embedding;
  await embedMissing(merged, { embedFn });

  fs.writeFileSync(outPath, JSON.stringify(merged));
  console.error(`index: +${added.length} ~${updated.length} -${deleted.length}, total ${merged.length} → ${outPath}`);
}
main();
