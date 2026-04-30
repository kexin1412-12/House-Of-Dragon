#!/usr/bin/env node
/**
 * merge_extracted_relationships.js
 *
 * 把 extract_relationships_from_book.js 产出的中间 JSON 合并到
 * kb/characters/house-of-the-dragon.json。
 *
 * 默认 --dry-run：只打印 diff，不写盘。
 * 加 --apply 才会真合并；合并前自动备份原 DB 到 .backup-<ts>.json。
 *
 * 合并策略：
 * - characters：character_id 已存在 → 仅补全空白字段，不覆盖人工填的内容
 * - relationships：(source, target) pair 已存在 → 把 timeline 条目拼进去，按 from 去重
 *                   pair 不存在 → 整条加进去
 *
 * 用法：
 *   node scripts/merge_extracted_relationships.js [--dry-run|--apply]
 *     [--extracted kb/characters/extracted/blood-and-fire.relationships.json]
 *     [--db kb/characters/house-of-the-dragon.json]
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv);
const SERVER_ROOT = path.join(__dirname, '..');
const extractedPath = path.resolve(SERVER_ROOT,
  args.extracted || 'kb/characters/extracted/blood-and-fire.relationships.json');
const dbPath = path.resolve(SERVER_ROOT,
  args.db || 'kb/characters/house-of-the-dragon.json');
const apply = !!args.apply;
const dryRun = !apply || !!args['dry-run'];

if (!fs.existsSync(extractedPath)) {
  console.error(`[err] extracted file not found: ${extractedPath}`);
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`[err] db not found: ${dbPath}`);
  process.exit(1);
}

const extracted = JSON.parse(fs.readFileSync(extractedPath, 'utf8'));
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

console.log(`[merge] extracted: ${args.extracted || 'kb/characters/extracted/blood-and-fire.relationships.json'}`);
console.log(`[merge] db: ${args.db || 'kb/characters/house-of-the-dragon.json'}`);
console.log(`[merge] mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
console.log('');

// ─── characters ───────────────────────────────────────────────
const dbCharsById = new Map((db.characters || []).map(c => [c.character_id, c]));
const charDiffs = { added: [], filled: [], unchanged: [] };

for (const ec of (extracted.characters || [])) {
  if (!ec.character_id) continue;
  const existing = dbCharsById.get(ec.character_id);
  if (!existing) {
    charDiffs.added.push(ec);
    continue;
  }
  // 仅补空白
  const filled = {};
  if (!existing.canonical_name && ec.canonical_name) filled.canonical_name = ec.canonical_name;
  if (!existing.display_name_zh && ec.display_name_zh) filled.display_name_zh = ec.display_name_zh;
  if (!existing.short_identity_zh && ec.short_identity_zh) filled.short_identity_zh = ec.short_identity_zh;
  if (!existing.house && ec.house) filled.house = ec.house;
  if (Object.keys(filled).length) charDiffs.filled.push({ character_id: ec.character_id, filled });
  else charDiffs.unchanged.push(ec.character_id);
}

// ─── relationships ────────────────────────────────────────────
function relPairKey(s, t) { return `${s}|${t}`; }
const dbRelsByPair = new Map((db.relationships || []).map(r => [relPairKey(r.source, r.target), r]));
const relDiffs = { added: [], extended: [], unchanged: [] };

for (const er of (extracted.relationships || [])) {
  if (!er.source || !er.target || !Array.isArray(er.timeline)) continue;
  const key = relPairKey(er.source, er.target);
  const existing = dbRelsByPair.get(key);
  if (!existing) {
    relDiffs.added.push(er);
    continue;
  }
  // 时间线合并：按 (from, relation_en) 去重；新条目 push
  const seen = new Set((existing.timeline || []).map(e => `${e.from}|${e.relation_en || ''}`));
  const newEntries = (er.timeline || []).filter(e => !seen.has(`${e.from}|${e.relation_en || ''}`));
  if (newEntries.length) relDiffs.extended.push({ key, source: er.source, target: er.target, newEntries });
  else relDiffs.unchanged.push(key);
}

// ─── 打印 diff ────────────────────────────────────────────────
console.log('═══ characters ═══');
console.log(`  + add ${charDiffs.added.length}：`);
charDiffs.added.forEach(c => console.log(`      ${c.character_id} (${c.display_name_zh || c.canonical_name})${c.house ? ' / ' + c.house : ''}`));
console.log(`  ~ fill empty fields on ${charDiffs.filled.length}：`);
charDiffs.filled.forEach(d => console.log(`      ${d.character_id}: +${Object.keys(d.filled).join(', ')}`));
console.log(`  = unchanged ${charDiffs.unchanged.length}`);

console.log('\n═══ relationships ═══');
console.log(`  + add ${relDiffs.added.length} pairs：`);
relDiffs.added.forEach(r => {
  const tlines = (r.timeline || []).map(e => `[${e.from}→${e.to || 'now'}] ${e.relation_zh}: ${e.summary_zh || ''}`).join(' / ');
  console.log(`      ${r.source} → ${r.target}: ${tlines}`);
});
console.log(`  ~ extend timeline on ${relDiffs.extended.length} pairs：`);
relDiffs.extended.forEach(d => {
  const tlines = d.newEntries.map(e => `[${e.from}→${e.to || 'now'}] ${e.relation_zh}: ${e.summary_zh || ''}`).join(' / ');
  console.log(`      ${d.source} → ${d.target}: +${d.newEntries.length} entries | ${tlines}`);
});
console.log(`  = unchanged ${relDiffs.unchanged.length}`);

if (dryRun) {
  console.log('\n[dry-run] no files written. Add --apply to merge.');
  return;
}

// ─── apply ───────────────────────────────────────────────────
const ts = Date.now();
const backup = `${dbPath}.backup-${ts}.json`;
fs.copyFileSync(dbPath, backup);
console.log(`\n[apply] backed up → ${backup}`);

// 应用 character 变更
const newChars = [...(db.characters || [])];
for (const c of charDiffs.added) newChars.push(c);
for (const d of charDiffs.filled) {
  const idx = newChars.findIndex(x => x.character_id === d.character_id);
  if (idx >= 0) newChars[idx] = { ...newChars[idx], ...d.filled };
}
db.characters = newChars;

// 应用 relationship 变更
const newRels = [...(db.relationships || [])];
for (const r of relDiffs.added) newRels.push({ source: r.source, target: r.target, timeline: r.timeline });
for (const d of relDiffs.extended) {
  const idx = newRels.findIndex(x => x.source === d.source && x.target === d.target);
  if (idx >= 0) newRels[idx].timeline = [...newRels[idx].timeline, ...d.newEntries].sort((a, b) => (a.from || '').localeCompare(b.from || ''));
}
db.relationships = newRels;

fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log(`[apply] db updated → ${args.db || 'kb/characters/house-of-the-dragon.json'}`);
console.log(`[apply] characters: ${db.characters.length} | relationships: ${db.relationships.length}`);
