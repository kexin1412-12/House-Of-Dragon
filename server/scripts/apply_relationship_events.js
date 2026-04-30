#!/usr/bin/env node
/**
 * apply_relationship_events.js
 *
 * 把 character-graph-agent 产出的事件文件（_suggestions/<video>.relationship_events.json）
 * 合并到 kb/characters/<show>.json。
 *
 * 事件粒度是 scene_id（细粒度审计），但合并后 timeline 仍按 episode 级 cursor (S01E0N)
 * 工作——这跟现有 lookupCharacter / lookupRelationships 的语义保持一致。
 *
 * 三类合并：
 *   - character_creations：character_id 不存在则添加；已存在跳过
 *   - state_events       ：写入 character.state_timeline；关闭上一条的 to
 *   - motivation_events  ：写入 character.motivations_timeline（字段不存在则创建）
 *   - relationship_events：写入 (source,target) pair 的 timeline；关闭上一条的 to
 *
 * 默认 --dry-run：只打 diff，不写盘。--apply 才真合并；合并前自动备份原 DB。
 *
 * 用法：
 *   node scripts/apply_relationship_events.js \
 *     --events kb/characters/_suggestions/house_of_dragon_05.relationship_events.json \
 *     [--db kb/characters/house-of-the-dragon.json] \
 *     [--dry-run | --apply]
 */

const fs = require('fs');
const path = require('path');

// ───────── CLI ──────────────────────────────────────────────
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

const eventsPath = path.resolve(
  SERVER_ROOT,
  args.events || 'kb/characters/_suggestions/house_of_dragon_05.relationship_events.json',
);
const dbPath = path.resolve(
  SERVER_ROOT,
  args.db || 'kb/characters/house-of-the-dragon.json',
);
const APPLY = !!args.apply;
const DRY = !APPLY; // default dry-run

if (!fs.existsSync(eventsPath)) {
  console.error('events file not found:', eventsPath);
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error('character DB not found:', dbPath);
  process.exit(1);
}

const events = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

const EPISODE = events.episode;
if (!/^S\d{2}E\d{2}$/.test(EPISODE)) {
  console.error('events.episode must be S01E0N format, got:', EPISODE);
  process.exit(1);
}

// ───────── helpers ──────────────────────────────────────────
function prevEpisode(ep) {
  // S01E05 → S01E04
  const m = ep.match(/^S(\d{2})E(\d{2})$/);
  if (!m) return null;
  const season = m[1];
  const epNum = parseInt(m[2], 10);
  if (epNum <= 1) return null;
  return `S${season}E${String(epNum - 1).padStart(2, '0')}`;
}

function findChar(id) {
  return db.characters.find(c => c.character_id === id);
}

function findRelPair(source, target) {
  return (db.relationships || []).find(
    r => r.source === source && r.target === target,
  );
}

const RELATION_KIND_ENUM = new Set([
  'parent-child', 'sibling', 'spouse', 'kin-other',
  'close-friend', 'estranged',
  'political-ally', 'political-rival', 'political-fallout',
  'lover', 'lover-killer', 'killer-of-kin',
  'mentor', 'patron-client', 'hostile', 'guardian',
  'political-marriage', 'dance-partner-of-pretender',
]);

const VALID_STATE_CHANGES = new Set([
  'death', 'title_revoked', 'title_added', 'political_realignment',
  'moral_breakdown', 'rebirth',
]);

const VALID_REL_CHANGES = new Set([
  'relation_created', 'relation_inverted', 'relation_intensified',
  'relation_strained', 'relation_reaffirmed', 'relation_terminated',
]);

// ───────── validate events ─────────────────────────────────
const errors = [];
for (const e of events.relationship_events || []) {
  if (!RELATION_KIND_ENUM.has(e.new_relation_kind)) {
    errors.push(`unknown relation_kind '${e.new_relation_kind}' at scene ${e.scene_id}`);
  }
  if (!VALID_REL_CHANGES.has(e.change)) {
    errors.push(`unknown change '${e.change}' at scene ${e.scene_id}`);
  }
  if (!e.scene_id || !e.source || !e.target) {
    errors.push(`missing scene_id/source/target in event: ${JSON.stringify(e)}`);
  }
}
for (const e of events.state_events || []) {
  if (!VALID_STATE_CHANGES.has(e.change)) {
    errors.push(`unknown state change '${e.change}' at scene ${e.scene_id}`);
  }
}
if (errors.length) {
  console.error('VALIDATION FAILED:');
  for (const er of errors) console.error('  -', er);
  process.exit(1);
}
console.log('✓ validation passed');

// ───────── merge plan (collect, then either dry-run or apply) ─────────
const plan = { creations: [], state: [], motivation: [], relationship: [] };

// 1) character_creations
for (const cc of events.character_creations || []) {
  if (findChar(cc.character_id)) {
    console.log(`  skip creation ${cc.character_id} (already exists)`);
    continue;
  }
  plan.creations.push(cc);
}

// 2) state_events
for (const e of events.state_events || []) {
  const ch = findChar(e.character_id);
  if (!ch) {
    // may be a freshly-created char from this batch → look in plan
    const inPlan = plan.creations.find(c => c.character_id === e.character_id);
    if (!inPlan) {
      console.warn(`  WARN: state_event for unknown character ${e.character_id}`);
      continue;
    }
  }
  plan.state.push(e);
}

// 3) motivation_events
for (const e of events.motivation_events || []) {
  const ch = findChar(e.character_id);
  if (!ch && !plan.creations.find(c => c.character_id === e.character_id)) {
    console.warn(`  WARN: motivation_event for unknown character ${e.character_id}`);
    continue;
  }
  plan.motivation.push(e);
}

// 4) relationship_events
for (const e of events.relationship_events || []) {
  // both endpoints must exist (in DB or plan)
  for (const id of [e.source, e.target]) {
    if (!findChar(id) && !plan.creations.find(c => c.character_id === id)) {
      console.warn(`  WARN: relationship_event references unknown character ${id} (scene ${e.scene_id})`);
    }
  }
  plan.relationship.push(e);
}

// ───────── pretty-print plan ─────────────────────────────────
console.log('');
console.log('============================================================');
console.log(`Merge plan (episode ${EPISODE}):`);
console.log(`  - character_creations: ${plan.creations.length}`);
console.log(`  - state_events:        ${plan.state.length}`);
console.log(`  - motivation_events:   ${plan.motivation.length}`);
console.log(`  - relationship_events: ${plan.relationship.length}`);
console.log('============================================================');

if (plan.creations.length) {
  console.log('\n[CHARACTER CREATIONS]');
  for (const c of plan.creations) console.log(`  + ${c.character_id} (${c.display_name_zh})`);
}
if (plan.state.length) {
  console.log('\n[STATE EVENTS]');
  for (const e of plan.state) {
    const tag = e.new_alive === false ? '已故' : (e.new_title_zh || '');
    console.log(`  ${e.scene_id} ${e.character_id} :: ${e.change} → ${tag}`);
  }
}
if (plan.motivation.length) {
  console.log('\n[MOTIVATION EVENTS]');
  for (const e of plan.motivation)
    console.log(`  ${e.scene_id} ${e.character_id} :: ${e.change}`);
}
if (plan.relationship.length) {
  console.log('\n[RELATIONSHIP EVENTS]');
  for (const e of plan.relationship)
    console.log(`  ${e.scene_id} ${e.source} → ${e.target} :: ${e.change} (Δ${e.intensity_delta >= 0 ? '+' : ''}${e.intensity_delta}) ${e.new_relation_kind}`);
}

if (DRY) {
  console.log('\n--dry-run (default). Re-run with --apply to commit.');
  process.exit(0);
}

// ───────── apply ────────────────────────────────────────────
const backup = dbPath + '.backup-' + Date.now() + '.json';
fs.writeFileSync(backup, JSON.stringify(db, null, 2), 'utf8');
console.log('\n✓ backup →', backup);

// 1. character_creations
for (const cc of plan.creations) {
  db.characters.push(cc);
}

// 2. state_events
for (const e of plan.state) {
  const ch = findChar(e.character_id);
  if (!ch) continue; // shouldn't happen after creation
  ch.state_timeline = ch.state_timeline || [];
  // close previous open entry
  const prev = ch.state_timeline.find(s => s.to == null);
  if (prev) prev.to = prevEpisode(EPISODE) || prev.to;
  ch.state_timeline.push({
    from: EPISODE,
    to: null,
    title_zh: e.new_title_zh || (prev ? prev.title_zh : null),
    title_en: e.new_title_en || (prev ? prev.title_en : null),
    political_role_zh: e.new_political_role_zh || (prev ? prev.political_role_zh : null),
    alive: e.new_alive !== undefined ? e.new_alive : (prev ? prev.alive !== false : true),
    safe_summary_zh: e.new_safe_summary_zh || null,
    triggered_by_scene_id: e.scene_id,
    triggered_by_change: e.change,
    evidence_zh: e.evidence || null,
  });
}

// 3. motivation_events
for (const e of plan.motivation) {
  const ch = findChar(e.character_id);
  if (!ch) continue;
  ch.motivations_timeline = ch.motivations_timeline || [];
  const prev = ch.motivations_timeline.find(m => m.to == null);
  if (prev) prev.to = prevEpisode(EPISODE) || prev.to;
  ch.motivations_timeline.push({
    from: EPISODE,
    to: null,
    motivation_zh: e.new_motivation_zh,
    triggered_by_scene_id: e.scene_id,
    evidence_zh: e.evidence || null,
  });
}

// 4. relationship_events
db.relationships = db.relationships || [];
for (const e of plan.relationship) {
  let pair = findRelPair(e.source, e.target);
  if (!pair) {
    pair = { source: e.source, target: e.target, timeline: [] };
    db.relationships.push(pair);
  }
  pair.timeline = pair.timeline || [];
  const prev = pair.timeline.find(t => t.to == null);
  if (prev) prev.to = prevEpisode(EPISODE) || prev.to;
  pair.timeline.push({
    from: EPISODE,
    to: null,
    relation_zh: e.new_relation_zh,
    relation_en: e.new_relation_en || e.new_relation_kind,
    relation_kind: e.new_relation_kind,
    intensity_delta: e.intensity_delta,
    summary_zh: e.summary_zh,
    triggered_by_scene_id: e.scene_id,
    triggered_by_change: e.change,
    evidence_zh: e.evidence || null,
  });
}

fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
console.log('✓ wrote', dbPath);
console.log('done.');
