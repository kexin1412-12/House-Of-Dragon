// Pre-renders the relationship-graph data for the family-tree UI and copies
// the portrait images it references into client/public, so the Vercel build
// can render the graph without a running backend.
//
//   node server/scripts/build-graph-snapshots.js
//
// Re-run whenever character DB or portraits change. Output is a single
// client/public/relationship-graph/_family-tree.json (replaces the old
// per-hero snapshot files).

const fs = require('fs');
const path = require('path');
const charactersLib = require('../lib/characters');

const SHOW_ID = 'house-of-the-dragon';
// End-of-S1 cursor. The demo video is a full-season recap so we want the
// final state surfaced (Joffrey/Rhea/Aemma already dead, Rhaenyra played by
// the adult actor, etc.). lookupCharacter() deliberately returns
// `current: null` when cursor is null — that's spoiler-safety for the live
// per-episode flow, but the family-tree poster wants the canonical end view.
const CURSOR = 'S01E10';

const SERVER_DIR = path.join(__dirname, '..');
const CLIENT_PUBLIC = path.join(SERVER_DIR, '..', 'client', 'public');
const SNAPSHOT_DIR = path.join(CLIENT_PUBLIC, 'relationship-graph');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, '_family-tree.json');
const FACE_SRC = path.join(SERVER_DIR, 'kb', 'characters', 'face_refs');
const FACE_DST = path.join(CLIENT_PUBLIC, 'kb', 'characters', 'face_refs');
const DRAGON_SRC = path.join(SERVER_DIR, 'kb', 'characters', 'dragon_refs');
const DRAGON_DST = path.join(CLIENT_PUBLIC, 'kb', 'characters', 'dragon_refs');

const IMG_RE = /\.(jpg|jpeg|png|webp)$/i;

// ─── Hand-curated layout / metadata ─────────────────────────────────
//
// generation: 0 = elder couple row, 1 = Rhaenyra's row.
// lineage_x: integer column index inside the row (left-to-right).
// Tuning these is how we keep parents above their kids and couples adjacent.
//
// Per the user's choice "merge Otto/Lyonel into row 0 even though they are
// strictly the parent generation of Alicent / Harwin-Larys": Otto's edge to
// Alicent and Lyonel's lateral position relative to his sons are dropped in
// the family tree (they remain implicit). Lyonel's parent edges to Harwin /
// Larys still render vertically because the kids are in row 1.
//
// The 7 dragons stay attached as `companion` on their riders — same model as
// the previous radial graph — so they don't get a row in this map.
const LAYOUT = {
  // Row 0 — eldest visible row (royalty + their elders, merged)
  rhea_royce:        { generation: 0, lineage_x: 0 },
  daemon_targaryen:  { generation: 0, lineage_x: 1 },
  viserys_targaryen: { generation: 0, lineage_x: 2 },
  alicent_hightower: { generation: 0, lineage_x: 3 },
  otto_hightower:    { generation: 0, lineage_x: 4 },
  lyonel_strong:     { generation: 0, lineage_x: 5 },
  corlys_velaryon:   { generation: 0, lineage_x: 6 },
  rhaenys_targaryen: { generation: 0, lineage_x: 7 },

  // Row 1 — Rhaenyra's generation (incl. her half-siblings Aegon brood)
  mysaria:             { generation: 1, lineage_x: 0 },
  criston_cole:        { generation: 1, lineage_x: 1 },
  rhaenyra_targaryen:  { generation: 1, lineage_x: 2 },
  aegon_targaryen_ii:  { generation: 1, lineage_x: 3 },
  helaena_targaryen:   { generation: 1, lineage_x: 4 },
  aemond_targaryen:    { generation: 1, lineage_x: 5 },
  harwin_strong:       { generation: 1, lineage_x: 6 },
  larys_strong:        { generation: 1, lineage_x: 7 },
  laenor_velaryon:     { generation: 1, lineage_x: 8 },
  joffrey_lonmouth:    { generation: 1, lineage_x: 9 },
};

// Show-canon nicknames that appear as red epithet badges on the portrait.
const EPITHETS = {
  daemon_targaryen:   '浪荡王子',
  viserys_targaryen:  '少壮王',
  rhaenyra_targaryen: '王国之光',
  aemond_targaryen:   '弑亲者',
  corlys_velaryon:    '潮汐之主',
  rhaenys_targaryen:  '无冕女王',
};

// English uppercase line drawn under the Chinese name (matches the reference
// poster's bilingual styling). Falls back to `display_name` upper-cased if
// the entry is missing.
const NAME_EN = {
  daemon_targaryen:   'DAEMON TARGARYEN',
  viserys_targaryen:  'VISERYS I TARGARYEN',
  alicent_hightower:  'ALICENT HIGHTOWER',
  otto_hightower:     'OTTO HIGHTOWER',
  rhea_royce:         'RHEA ROYCE',
  corlys_velaryon:    'CORLYS VELARYON',
  rhaenys_targaryen:  'RHAENYS TARGARYEN',
  lyonel_strong:      'LYONEL STRONG',
  rhaenyra_targaryen: 'RHAENYRA TARGARYEN',
  aegon_targaryen_ii: 'AEGON II TARGARYEN',
  helaena_targaryen:  'HELAENA TARGARYEN',
  aemond_targaryen:   'AEMOND TARGARYEN',
  harwin_strong:      'HARWIN STRONG',
  larys_strong:       'LARYS STRONG',
  laenor_velaryon:    'LAENOR VELARYON',
  joffrey_lonmouth:   'JOFFREY LONMOUTH',
  criston_cole:       'CRISTON COLE',
  mysaria:            'MYSARIA',
};

// Show-canonical kin edges that the DB happens to be missing. Each entry is
// already in the final shape that ends up in kin_edges (kind="marriage" |
// "parent_child" | "parent_couple"); injected after the DB-derived merge so
// they don't compete with the auto-pairing logic.
const KIN_OVERRIDES = [
  // Daemon × Rhaenyra wed at end of S1; DB only carries 叔侄 + 暧昧.
  { kind: 'marriage', from: 'daemon_targaryen', to: 'rhaenyra_targaryen', label: '夫妻' },
  // Corlys + Rhaenys → Laenor: DB has no parent edges here at all.
  {
    kind: 'parent_couple',
    parents: ['corlys_velaryon', 'rhaenys_targaryen'],
    to: 'laenor_velaryon',
    label: '子女',
  },
];

// Which kin edges to draw, derived from the relationship DB. The frontend
// only renders three kinds: marriage (horizontal bar), sibling (horizontal
// bar above), parent_child (vertical bracket). Cousins / aunt-niece /
// half-sibling are conveyed implicitly by shared parent edges and dropped
// from the explicit kin layer to keep the picture readable.
function classifyKin(relZh, relKind) {
  if (!relZh && !relKind) return null;
  // marriage: any spousal label, regardless of duration
  if (/夫妻|婚约|婚姻/.test(relZh || '')) return 'marriage';
  if (relKind === 'marriage') return 'marriage';
  // sibling: full siblings (drop "同父异母" — implied by shared parent)
  if (/^(兄弟|姐妹|兄妹)$/.test(relZh || '')) return 'sibling';
  // parent-child: include both directions
  if (/父女|父子|母女|母子/.test(relZh || '')) return 'parent_child';
  return null;
}

function relationLabel(kind) {
  if (kind === 'marriage')     return '夫妻';
  if (kind === 'sibling')      return '兄弟';
  if (kind === 'parent_child') return '子女';
  return '';
}

// Direction matters for parent_child rendering: we always want `from` = parent,
// `to` = child. The DB convention is source = child, target = elder
// (e.g. "rhaenyra 父女 viserys" — Viserys is the father), so we flip when
// the label starts with 父|母 and trust the original orientation otherwise.
function orientParentChild(rel, relZh) {
  if (/^父|^母/.test(relZh)) {
    return { parent: rel.target, child: rel.source };
  }
  return { parent: rel.source, child: rel.target };
}

const IMG_CACHE_BY_PATH = new Set();
function copyFaceFile(charId, version) {
  if (!charId || !version) return null;
  const srcDir = path.join(FACE_SRC, charId, version);
  if (!fs.existsSync(srcDir)) return null;
  const files = fs.readdirSync(srcDir).filter(f => IMG_RE.test(f)).sort();
  if (files.length === 0) return null;
  const first = files[0];
  const dstDir = path.join(FACE_DST, charId, version);
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(path.join(srcDir, first), path.join(dstDir, first));
  IMG_CACHE_BY_PATH.add(`${charId}/${version}/${first}`);
  return `/kb/characters/face_refs/${encodeURIComponent(charId)}/${encodeURIComponent(version)}/${encodeURIComponent(first)}`;
}

function copyAllDragons() {
  if (!fs.existsSync(DRAGON_SRC)) return 0;
  fs.mkdirSync(DRAGON_DST, { recursive: true });
  let count = 0;
  for (const f of fs.readdirSync(DRAGON_SRC)) {
    if (!IMG_RE.test(f)) continue;
    fs.copyFileSync(path.join(DRAGON_SRC, f), path.join(DRAGON_DST, f));
    count++;
  }
  return count;
}

// Wipe stale per-hero JSONs from the previous radial layout so the directory
// only contains the new tree file. Keeps git diffs clean and avoids confusing
// orphaned files in the bundle.
function purgeStaleSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return 0;
  let removed = 0;
  for (const f of fs.readdirSync(SNAPSHOT_DIR)) {
    if (f === '_family-tree.json') continue;
    if (f.startsWith('_scene-focus-')) continue;     // managed by buildSceneFocus
    if (f.startsWith('_char-events-')) continue;     // managed by buildCharEvents
    if (!f.endsWith('.json')) continue;
    fs.unlinkSync(path.join(SNAPSHOT_DIR, f));
    removed++;
  }
  return removed;
}

function buildCompanion(db, charId) {
  return charactersLib.findCompanionByTag(db, charId, CURSOR, 'dragon');
}

function buildCharacterEntry(db, charId) {
  const layout = LAYOUT[charId];
  if (!layout) return null;     // skip dragons + anyone outside the curated set
  const card = charactersLib.lookupCharacter(db, charId, CURSOR);
  if (!card) return null;
  const version = card.current_actor?.version || null;
  // copyFaceFile both returns the relative URL and copies the underlying
  // file into client/public so the static bundle can serve it.
  return {
    character_id: charId,
    display_name: card.display_name,
    name_en: NAME_EN[charId] || (card.canonical_name || charId).toUpperCase(),
    short_identity: card.short_identity || null,
    epithet: EPITHETS[charId] || null,
    house: card.house || null,
    actor_version: version,
    portrait_url: copyFaceFile(charId, version),
    alive: card.current?.alive !== false,
    generation: layout.generation,
    lineage_x: layout.lineage_x,
    companion: buildCompanion(db, charId),
  };
}

function buildEdges(db, characterIds) {
  const charSet = new Set(characterIds);
  const kin = [];
  const conflict = [];

  for (const rel of db.relationships || []) {
    if (!charSet.has(rel.source) || !charSet.has(rel.target)) continue;
    const active = charactersLib.currentEntry(rel.timeline, CURSOR);
    if (!active) continue;
    const relZh = active.relation_zh || active.relation_en || '';
    const kind = classifyKin(relZh, active.relation_kind);

    if (kind) {
      const edge = { kind, label: relationLabel(kind), relation_zh: relZh };
      if (kind === 'parent_child') {
        const { parent, child } = orientParentChild(rel, relZh);
        edge.from = parent;
        edge.to = child;
      } else {
        edge.from = rel.source;
        edge.to = rel.target;
      }
      kin.push(edge);
    } else {
      // Anything that is not blood/marriage backbone — political / emotional
      // edges that drive the click-to-highlight overlay.
      conflict.push({
        from: rel.source,
        to: rel.target,
        kind: active.relation_kind || 'enemy',  // null kind defaults to enemy
        relation: relZh,
        summary: active.summary_zh || active.summary || null,
      });
    }
  }

  // Couple-merge: if we have parent_child edges from both members of a married
  // pair to the same child, fold them into one parent_couple edge so the front
  // can render the bracket from the couple's midpoint.
  const coupleByPair = new Map();
  for (const e of kin) {
    if (e.kind !== 'marriage') continue;
    const key = [e.from, e.to].sort().join('|');
    coupleByPair.set(key, [e.from, e.to]);
  }
  const mergedKin = [];
  const seenParentChild = new Map();
  for (const e of kin) {
    if (e.kind !== 'parent_child') {
      mergedKin.push(e);
      continue;
    }
    const child = e.to;
    const otherParent = mergedKin.find(p =>
      p.kind === 'parent_child' &&
      p.to === child &&
      coupleByPair.has([p.from, e.from].sort().join('|')),
    );
    if (otherParent) {
      // upgrade existing entry to parent_couple
      otherParent.kind = 'parent_couple';
      otherParent.parents = [otherParent.from, e.from].sort();
      otherParent.from = undefined;
      delete otherParent.from;
    } else if (seenParentChild.has(`${e.from}->${child}`)) {
      // exact duplicate (DB has bidirectional row), skip
      continue;
    } else {
      seenParentChild.set(`${e.from}->${child}`, true);
      mergedKin.push(e);
    }
  }

  // Inject canonical-but-missing kin edges. Kept out of the auto-merge so
  // each override goes in exactly as written.
  for (const ov of KIN_OVERRIDES) {
    if (ov.kind === 'parent_couple') {
      if (!ov.parents.every(p => charSet.has(p)) || !charSet.has(ov.to)) continue;
      const dupe = mergedKin.some(e =>
        e.kind === 'parent_couple' &&
        e.to === ov.to &&
        e.parents.length === ov.parents.length &&
        e.parents.every(p => ov.parents.includes(p))
      );
      if (dupe) continue;
      mergedKin.push({ kind: 'parent_couple', parents: ov.parents.slice().sort(), to: ov.to, label: ov.label });
    } else {
      if (!charSet.has(ov.from) || !charSet.has(ov.to)) continue;
      const dupe = mergedKin.some(e =>
        e.kind === ov.kind &&
        ((e.from === ov.from && e.to === ov.to) || (e.from === ov.to && e.to === ov.from))
      );
      if (dupe) continue;
      mergedKin.push({ kind: ov.kind, from: ov.from, to: ov.to, label: ov.label, relation_zh: ov.label });
    }
  }

  // Drop redundant sibling bars when both siblings share a visible parent —
  // the parent bracket already conveys the sibling relationship and an extra
  // sibling pill would just clutter (matches the reference: explicit "兄弟"
  // pill is reserved for siblings whose common parent isn't on the chart).
  const parentsOfChild = new Map(); // child_id -> Set(parent_id)
  for (const e of mergedKin) {
    if (e.kind === 'parent_child') {
      if (!parentsOfChild.has(e.to)) parentsOfChild.set(e.to, new Set());
      parentsOfChild.get(e.to).add(e.from);
    } else if (e.kind === 'parent_couple') {
      if (!parentsOfChild.has(e.to)) parentsOfChild.set(e.to, new Set());
      for (const p of e.parents) parentsOfChild.get(e.to).add(p);
    }
  }
  const filteredKin = mergedKin.filter(e => {
    if (e.kind !== 'sibling') return true;
    const a = parentsOfChild.get(e.from);
    const b = parentsOfChild.get(e.to);
    if (!a || !b) return true;
    for (const p of a) if (b.has(p)) return false;  // shared parent in tree
    return true;
  });

  return { kin_edges: filteredKin, conflict_edges: conflict };
}

// Scene-focus: per-video [{start, end, hero_id}] giving the dominant
// on-screen character at each second of the demo video. Lets the front-end
// auto-center the family tree on whoever is being shown right now.
function buildSceneFocus(videoId, eligibleIds) {
  const kbFile = path.join(SERVER_DIR, 'kb', `${videoId}.json`);
  if (!fs.existsSync(kbFile)) return null;
  const kb = JSON.parse(fs.readFileSync(kbFile, 'utf8'));
  const eligible = new Set(eligibleIds);
  const raw = [];
  for (const sc of kb.scenes || []) {
    if (!Array.isArray(sc.characters) || sc.characters.length === 0) continue;
    // Pick the character with most screen time in this scene that we know
    // how to render in the family tree.
    const top = sc.characters
      .filter(c => c && c.id && eligible.has(c.id))
      .sort((a, b) => (b.screen_time_s || 0) - (a.screen_time_s || 0))[0];
    if (!top) continue;
    raw.push({ start: sc.start_time, end: sc.end_time, hero_id: top.id });
  }
  // Merge consecutive scenes with the same hero so the file stays small
  // (711 scenes → ~100s of merged ranges).
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && last.hero_id === r.hero_id && Math.abs(last.end - r.start) < 0.1) {
      last.end = r.end;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

// Per-video character events keyed off scene_ids in the KB. Right now we
// only resolve "death moments" (state entries flagged alive=false with a
// triggered_by_scene_id pointing at a scene in this video). The frontend
// uses death_at to gate the "已故" badge on currentTime — so the badge only
// appears once the recap actually shows the death scene, instead of being
// present from t=0 just because the character is dead by S01E10.
function buildCharEvents(videoId, db, eligibleIds) {
  const kbFile = path.join(SERVER_DIR, 'kb', `${videoId}.json`);
  if (!fs.existsSync(kbFile)) return null;
  const kb = JSON.parse(fs.readFileSync(kbFile, 'utf8'));
  const sceneById = new Map();
  for (const sc of kb.scenes || []) sceneById.set(sc.scene_id, sc);
  const eligible = new Set(eligibleIds);
  const out = {};
  for (const ch of db.characters || []) {
    if (!eligible.has(ch.character_id)) continue;
    for (const entry of ch.state_timeline || []) {
      if (entry.alive !== false || !entry.triggered_by_scene_id) continue;
      const sc = sceneById.get(entry.triggered_by_scene_id);
      if (!sc || typeof sc.start_time !== 'number') continue;
      out[ch.character_id] = { death_at: sc.start_time };
      break;  // one death per character is enough
    }
  }
  return out;
}

function main() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const db = charactersLib.loadCharacterDb(SHOW_ID);

  const charIds = Object.keys(LAYOUT);
  const characters = [];
  for (const id of charIds) {
    const entry = buildCharacterEntry(db, id);
    if (entry) characters.push(entry);
  }

  const { kin_edges, conflict_edges } = buildEdges(db, characters.map(c => c.character_id));

  const out = {
    show_id: SHOW_ID,
    cursor_used: CURSOR,
    // Title only carries the show name now — the tree spans Targaryens,
    // Velaryons, Hightowers, Strongs, Cole, Royce and Lonmouth, so calling
    // the whole thing "坦格利安家族" was misleading.
    title_zh: '《龙之家族》',
    title_en: 'HOUSE OF THE DRAGON',
    subtitle_zh: '',
    subtitle_en: '',
    characters,
    kin_edges,
    conflict_edges,
  };

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(out, null, 2));

  // Build per-video scene-focus map for every KB we ship.
  const eligible = characters.map(c => c.character_id);
  const kbDir = path.join(SERVER_DIR, 'kb');
  const videoIds = fs.readdirSync(kbDir)
    .filter(f => f.endsWith('.json') && !f.includes('backup'))
    .map(f => f.replace(/\.json$/, ''));
  let focusFiles = 0;
  let eventFiles = 0;
  for (const vid of videoIds) {
    const focus = buildSceneFocus(vid, eligible);
    if (focus && focus.length > 0) {
      fs.writeFileSync(path.join(SNAPSHOT_DIR, `_scene-focus-${vid}.json`), JSON.stringify(focus));
      focusFiles++;
    }
    const events = buildCharEvents(vid, db, eligible);
    if (events && Object.keys(events).length > 0) {
      fs.writeFileSync(path.join(SNAPSHOT_DIR, `_char-events-${vid}.json`), JSON.stringify(events));
      eventFiles++;
    }
  }

  const purged = purgeStaleSnapshots();
  const dragonCount = copyAllDragons();

  console.log(`✓ family tree: ${characters.length} characters, ${kin_edges.length} kin, ${conflict_edges.length} conflict → ${path.relative(process.cwd(), SNAPSHOT_FILE)}`);
  console.log(`✓ ${focusFiles} scene-focus map(s) → client/public/relationship-graph/_scene-focus-*.json`);
  console.log(`✓ ${eventFiles} char-events map(s) → client/public/relationship-graph/_char-events-*.json`);
  console.log(`✓ ${IMG_CACHE_BY_PATH.size} face portraits → client/public/kb/characters/face_refs/`);
  console.log(`✓ ${dragonCount} dragon portraits → client/public/kb/characters/dragon_refs/`);
  if (purged > 0) console.log(`✓ removed ${purged} stale per-hero snapshot file(s)`);
}

main();
