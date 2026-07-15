#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');

const CHARACTER_TERMS = [
  { id: 'rhaenyra_targaryen', display_name: '雷妮拉·坦格利安', terms: ['雷妮拉'] },
  { id: 'daemon_targaryen', display_name: '戴蒙·坦格利安', terms: ['戴蒙'] },
  { id: 'corlys_velaryon', display_name: '科利斯·瓦列利安', terms: ['科利斯', '海蛇'] },
  { id: 'aegon_targaryen_ii', display_name: '伊耿二世·坦格利安', terms: ['伊耿'] },
  { id: 'aemond_targaryen', display_name: '艾蒙德·坦格利安', terms: ['伊蒙德', '艾蒙德'] },
  { id: 'alicent_hightower', display_name: '阿莉森特·海塔尔', terms: ['阿莉森特', '阿莉森'] },
  { id: 'helaena_targaryen', display_name: '海拉娜·坦格利安', terms: ['海拉娜', '海伦娜'] },
  { id: 'criston_cole', display_name: '克里斯顿·科尔', terms: ['克里斯顿', '科尔'] },
  { id: 'rhaena_targaryen', display_name: '雷妮亚·坦格利安', terms: ['雷妮亚'] },
  { id: 'baela_targaryen', display_name: '贝妮拉·坦格利安', terms: ['贝妮拉', '贝拉', 'Baela'] },
  { id: 'jacaerys_velaryon', display_name: '杰卡里斯·瓦列利安', terms: ['杰卡里斯', '杰斯'] },
  { id: 'ulf_white', display_name: '乌尔夫·怀特', terms: ['乌尔夫'] },
  { id: 'hugh_hammer', display_name: '休·锤', terms: ['休·锤'] },
  { id: 'alys_rivers', display_name: '亚莉·河文', terms: ['亚莉·河文', '亚莉'] },
];

function parseArgs(argv) {
  const opts = { videoId: null, dryRun: false, append: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--append') { opts.append = true; continue; }
    if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
    if (!opts.videoId && !arg.startsWith('--')) opts.videoId = arg;
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/backfill_scene_characters_from_text.js <video_id> [options]

Options:
  --dry-run   Print planned changes without writing.
  --append    Add inferred characters even when characters[] already has entries.

By default, only scenes with empty characters[] are modified.
`);
}

function collectSceneText(scene) {
  const parts = [];
  const push = value => {
    if (value == null) return;
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) value.forEach(push);
    else if (typeof value === 'object') Object.values(value).forEach(push);
  };

  push(scene.title);
  push(scene.location);
  push(scene.plot);
  push(scene.narrative);
  push(scene.tags);
  return parts.join('\n');
}

function inferCharacters(scene) {
  const text = collectSceneText(scene);
  const found = [];
  const seen = new Set();
  for (const entry of CHARACTER_TERMS) {
    if (entry.terms.some(term => text.includes(term)) && !seen.has(entry.id)) {
      seen.add(entry.id);
      found.push({
        id: entry.id,
        display_name: entry.display_name,
        emotion: '未明确',
        motivation_shift: '未明确',
        dramatic_position: 'participant',
        inferred_from_text: true,
      });
    }
  }
  return found;
}

function mergeCharacters(existing, inferred) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const ids = new Set(out.map(c => c && c.id).filter(Boolean));
  for (const c of inferred) {
    if (!ids.has(c.id)) {
      out.push(c);
      ids.add(c.id);
    }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();
  if (!opts.videoId) throw new Error('Usage: node scripts/backfill_scene_characters_from_text.js <video_id>');

  const kbPath = path.join(SERVER_DIR, 'kb', `${opts.videoId}.json`);
  if (!fs.existsSync(kbPath)) throw new Error(`KB not found: ${kbPath}`);
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const changes = [];

  for (const scene of kb.scenes || []) {
    const existing = Array.isArray(scene.characters) ? scene.characters : [];
    if (!opts.append && existing.length > 0) continue;
    const inferred = inferCharacters(scene);
    if (inferred.length === 0) continue;
    scene.characters = mergeCharacters(existing, inferred);
    changes.push({
      scene_id: scene.scene_id,
      added: inferred.map(c => c.id),
    });
  }

  if (opts.dryRun) {
    for (const change of changes) {
      console.log(`${change.scene_id}: ${change.added.join(', ')}`);
    }
    console.log(`Planned changes: ${changes.length}`);
    return;
  }

  kb.characters_text_backfilled_at = new Date().toISOString();
  fs.writeFileSync(kbPath, `${JSON.stringify(kb, null, 2)}\n`, 'utf8');
  console.log(`Backfilled ${changes.length} scenes in ${path.relative(process.cwd(), kbPath)}`);
  for (const change of changes) {
    console.log(`  ${change.scene_id}: ${change.added.join(', ')}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
