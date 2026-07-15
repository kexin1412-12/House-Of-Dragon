#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const locationsLib = require('../lib/locations');

const SERVER_DIR = path.join(__dirname, '..');

const SCENE_OVERRIDES = {
  s013: { ids: ['the-gullet', 'riverlands'], confidence: 'low', method: 'montage_context' },
  s014: { ids: ['riverlands'], confidence: 'medium', method: 'plot_context' },
  s015: { ids: ['riverlands'], confidence: 'medium', method: 'plot_context' },
  s016: { ids: ['riverlands'], confidence: 'medium', method: 'plot_context' },
  s017: { ids: ['riverlands'], confidence: 'medium', method: 'plot_context' },
  s025: { ids: ['red-keep'], confidence: 'medium', method: 'character_and_plot_context' },
  s026: { ids: ['red-keep'], confidence: 'medium', method: 'character_and_plot_context' },
  s027: { ids: ['the-gullet'], confidence: 'medium', method: 'adjacent_naval_sequence' },
  s028: { ids: ['the-gullet'], confidence: 'medium', method: 'adjacent_naval_sequence' },
  s029: { ids: ['the-gullet'], confidence: 'medium', method: 'adjacent_naval_sequence' },
  s030: { ids: ['the-gullet'], confidence: 'high', method: 'naval_battle_context' },
  s032: { ids: ['riverlands'], confidence: 'medium', method: 'plot_context' },
  s033: { ids: ['riverlands'], confidence: 'medium', method: 'plot_context' },
  s034: { ids: ['riverlands'], confidence: 'medium', method: 'plot_context' },
  s035: { ids: ['red-keep'], confidence: 'medium', method: 'adjacent_red_keep_sequence' },
  s080: { ids: ['the-gullet'], confidence: 'high', method: 'adjacent_naval_sequence' },
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function resolveFromLabel(db, label) {
  if (!label) return [];
  const parts = String(label).split(/\s*\/\s*/).filter(Boolean);
  const matches = [];
  for (const part of parts) {
    const resolved = locationsLib.resolveLocation(db, part);
    if (resolved) matches.push(resolved);
  }
  return matches;
}

function main() {
  const videoId = process.argv[2] || 'house_of_dragon_s03e01';
  if (!/^[a-zA-Z0-9_-]+$/.test(videoId)) throw new Error(`Invalid video id: ${videoId}`);

  const kbPath = path.join(SERVER_DIR, 'kb', `${videoId}.json`);
  if (!fs.existsSync(kbPath)) throw new Error(`KB not found: ${kbPath}`);
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const db = locationsLib.loadLocationDb(kb.show_id || 'house-of-the-dragon');
  if (!db) throw new Error(`Location DB not found for show: ${kb.show_id}`);

  let resolvedCount = 0;
  let officialSceneCount = 0;
  let extensionSceneCount = 0;
  const unresolved = [];

  for (const scene of kb.scenes || []) {
    const labelMatches = resolveFromLabel(db, scene.location);
    const override = SCENE_OVERRIDES[scene.scene_id] || null;
    const ids = unique(labelMatches.map(match => match.location.location_id));
    if (!ids.length && override) ids.push(...override.ids);

    if (!ids.length) {
      delete scene.location_id;
      delete scene.location_ids;
      delete scene.location_match;
      unresolved.push({ scene_id: scene.scene_id, location: scene.location || null });
      continue;
    }

    const records = ids.map(id => locationsLib.findLocation(db, id)).filter(Boolean);
    scene.location_id = ids[0];
    scene.location_ids = ids;
    scene.location_match = {
      confidence: override && !labelMatches.length
        ? override.confidence
        : (labelMatches.every(match => match.confidence === 'high') ? 'high' : 'medium'),
      method: override && !labelMatches.length
        ? override.method
        : (labelMatches.length > 1 ? 'split_label_aliases' : labelMatches[0].method),
      raw_label: scene.location || null,
      source_classes: unique(records.map(record => record.source_class)),
    };

    resolvedCount++;
    if (records.some(record => record.official_map_entry)) officialSceneCount++;
    if (records.some(record => !record.official_map_entry)) extensionSceneCount++;
  }

  kb.locations_bound_at = new Date().toISOString();
  kb.location_db_show_id = db.show_id;
  fs.writeFileSync(kbPath, `${JSON.stringify(kb, null, 2)}\n`, 'utf8');

  console.log(`Scenes resolved=${resolvedCount}/${(kb.scenes || []).length}`);
  console.log(`Scenes using official map entries=${officialSceneCount}`);
  console.log(`Scenes using episode extensions=${extensionSceneCount}`);
  console.log(`Unresolved scenes=${unresolved.length}`);
  for (const item of unresolved) console.log(`  ${item.scene_id}: ${item.location || '(none)'}`);
}

main();
