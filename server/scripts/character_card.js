#!/usr/bin/env node
/**
 * 验证 character DB + retrieval helper 是否正常工作。
 *
 * Usage:
 *   node scripts/character_card.js <character_id> [--show <id>] [--cursor S01E0X]
 *   node scripts/character_card.js rhaenyra_targaryen --cursor S01E03
 *   node scripts/character_card.js --show house-of-the-dragon --cursor S01E02 --all
 */

const path = require('path');
const characters = require('../lib/characters');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { characterId: null, show: 'house-of-the-dragon', cursor: null, all: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--show' && args[i + 1]) { opts.show = args[++i]; continue; }
    if (args[i] === '--cursor' && args[i + 1]) { opts.cursor = args[++i]; continue; }
    if (args[i] === '--all') { opts.all = true; continue; }
    if (args[i] === '-h' || args[i] === '--help') { opts.help = true; continue; }
    if (!opts.characterId && !args[i].startsWith('--')) opts.characterId = args[i];
  }
  return opts;
}

function printCard(db, id, cursor) {
  const card = characters.lookupCharacter(db, id, cursor);
  if (!card) { console.log(`  [${id}] not found`); return; }
  const rels = characters.lookupRelationships(db, id, cursor);
  console.log(`\n${card.display_name}  (${card.character_id})`);
  console.log(`  家族: ${card.house || '—'}`);
  if (card.current_actor) {
    console.log(`  演员: ${card.current_actor.actor_name} (${card.current_actor.version})`);
  }
  if (card.current) {
    console.log(`  当前称号: ${card.current.title || '—'}`);
    console.log(`  政治角色: ${card.current.political_role || '—'}`);
    console.log(`  生存状态: ${card.current.alive ? '在世' : '已故'}`);
    console.log(`  一句话:   ${card.current.summary || '—'}`);
  } else {
    console.log(`  (在 ${cursor || '当前'} 之前未登场)`);
  }
  if (rels.length) {
    console.log(`  关系:`);
    for (const r of rels) {
      console.log(`    - ${r.relation}: ${r.with}${r.summary ? '   — ' + r.summary : ''}`);
    }
  }
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || (!opts.characterId && !opts.all)) {
    console.log(`Usage:\n  node scripts/character_card.js <character_id> [--show <id>] [--cursor S01E0X]\n  node scripts/character_card.js --all --cursor S01E02\n`);
    process.exit(opts.help ? 0 : 1);
  }
  const db = characters.loadCharacterDb(opts.show);
  console.log(`# Character DB: ${db.show}  (${db.characters.length} chars, ${db.relationships?.length || 0} rels)`);
  console.log(`# Cursor: ${opts.cursor || '<未设置 — 视为剧终>'}`);

  const ids = opts.all ? db.characters.map(c => c.character_id) : [opts.characterId];
  for (const id of ids) printCard(db, id, opts.cursor);
}

main();
