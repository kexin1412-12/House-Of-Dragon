#!/usr/bin/env node
// Usage: node scripts/tag_recap_knowledge.js <recap.knowledge.json> <showId> > tagged.json
const fs = require('fs');
const path = require('path');
const { tagAll } = require('../lib/retrieval/recap-tagger');

async function main() {
  const [srcPath, showId] = process.argv.slice(2);
  if (!srcPath || !showId) { console.error('args: <recap.knowledge.json> <showId>'); process.exit(1); }
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
  const { createOpenAIClient } = require('../lib/ai/openai-client');
  const client = createOpenAIClient();
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const kb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kb', `${showId}_scene_episodes.json`), 'utf8'));
  const sceneEpisodes = kb.scene_episodes || []; // [{episode, keywords[]}]
  const points = (JSON.parse(fs.readFileSync(srcPath, 'utf8')).knowledge_points) || [];

  const llmFn = async (prompt) => {
    const r = await client.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 });
    return r.choices[0].message.content || 'UNKNOWN';
  };
  const tagged = await tagAll(points, { sceneEpisodes, llmFn });
  process.stdout.write(JSON.stringify(tagged, null, 2));
  console.error(`tagged ${tagged.length}/${points.length}`);
}
main();
