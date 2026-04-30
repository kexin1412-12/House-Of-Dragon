// Pre-renders the relationship-graph JSON for every character in the show DB
// and copies the portrait images they reference into client/public, so the
// Vercel build can serve the graph without a running backend.
//
//   node server/scripts/build-graph-snapshots.js
//
// Re-run whenever character DB or portraits change.

const fs = require('fs');
const path = require('path');
const charactersLib = require('../lib/characters');

const SHOW_ID = 'house-of-the-dragon';
// null cursor = end-of-show "current" entry per timeline; matches what the
// live route returns when the client passes no videoId. Demo is a full-season
// recap, so this is the correct snapshot.
const CURSOR = null;

const SERVER_DIR = path.join(__dirname, '..');
const CLIENT_PUBLIC = path.join(SERVER_DIR, '..', 'client', 'public');
const SNAPSHOT_DIR = path.join(CLIENT_PUBLIC, 'relationship-graph');
const FACE_SRC = path.join(SERVER_DIR, 'kb', 'characters', 'face_refs');
const FACE_DST = path.join(CLIENT_PUBLIC, 'kb', 'characters', 'face_refs');
const DRAGON_SRC = path.join(SERVER_DIR, 'kb', 'characters', 'dragon_refs');
const DRAGON_DST = path.join(CLIENT_PUBLIC, 'kb', 'characters', 'dragon_refs');

const IMG_RE = /\.(jpg|jpeg|png|webp)$/i;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Mirrors pickPortraitUrl: alphabetically first image wins. We copy only that
// one file — saves ~30 MB vs. shipping every reference shot.
function copyPickedFace(charId, version) {
  if (!charId || !version) return false;
  const srcDir = path.join(FACE_SRC, charId, version);
  if (!fs.existsSync(srcDir)) return false;
  const files = fs.readdirSync(srcDir).filter(f => IMG_RE.test(f)).sort();
  if (files.length === 0) return false;
  const dstDir = path.join(FACE_DST, charId, version);
  ensureDir(dstDir);
  fs.copyFileSync(path.join(srcDir, files[0]), path.join(dstDir, files[0]));
  return true;
}

function copyAllDragons() {
  if (!fs.existsSync(DRAGON_SRC)) return 0;
  ensureDir(DRAGON_DST);
  let count = 0;
  for (const f of fs.readdirSync(DRAGON_SRC)) {
    if (!IMG_RE.test(f)) continue;
    fs.copyFileSync(path.join(DRAGON_SRC, f), path.join(DRAGON_DST, f));
    count++;
  }
  return count;
}

// Identical shape to GET /api/agent/characters/relationship-graph response.
function buildSnapshot(db, heroId) {
  const heroCard = charactersLib.lookupCharacter(db, heroId, CURSOR);
  if (!heroCard) return null;

  const heroVersion = heroCard.current_actor?.version || null;
  const heroPortrait = charactersLib.pickPortraitUrl(heroId, heroVersion);

  const rels = charactersLib.lookupRelationships(db, heroId, CURSOR);
  const edges = rels
    .filter(r => !charactersLib.characterHasTag(db, r.with, 'dragon'))
    .map(r => {
      const otherCard = charactersLib.lookupCharacter(db, r.with, CURSOR);
      const version = otherCard?.current_actor?.version || null;
      return {
        with: r.with,
        display_name: otherCard?.display_name || r.with,
        short_identity: otherCard?.short_identity || null,
        house: otherCard?.house || null,
        relation: r.relation,
        relation_en: r.relation_en || null,
        relation_kind: r.relation_kind || null,
        summary: r.summary || null,
        portrait_url: charactersLib.pickPortraitUrl(r.with, version),
        actor_version: version,
        alive: otherCard?.current?.alive !== false,
        companion: charactersLib.findCompanionByTag(db, r.with, CURSOR, 'dragon'),
      };
    });

  return {
    has_kb: false,
    has_character_db: true,
    cursor_used: CURSOR,
    hero: {
      character_id: heroCard.character_id,
      display_name: heroCard.display_name,
      short_identity: heroCard.short_identity,
      house: heroCard.house,
      actor_version: heroVersion,
      portrait_url: heroPortrait,
      current_title: heroCard.current?.title || null,
      alive: heroCard.current?.alive !== false,
      companion: charactersLib.findCompanionByTag(db, heroId, CURSOR, 'dragon'),
    },
    edges,
  };
}

function main() {
  ensureDir(SNAPSHOT_DIR);

  const db = charactersLib.loadCharacterDb(SHOW_ID);
  const characters = db.characters || [];

  const versionsSeen = new Set();
  let snapshotCount = 0;

  for (const char of characters) {
    const heroId = char.character_id;
    const snapshot = buildSnapshot(db, heroId);
    if (!snapshot) continue;
    fs.writeFileSync(
      path.join(SNAPSHOT_DIR, `${heroId}.json`),
      JSON.stringify(snapshot, null, 2),
    );
    snapshotCount++;

    const collect = (id, version) => {
      if (!version) return;
      const key = `${id}/${version}`;
      if (versionsSeen.has(key)) return;
      if (copyPickedFace(id, version)) versionsSeen.add(key);
    };
    collect(snapshot.hero.character_id, snapshot.hero.actor_version);
    for (const e of snapshot.edges) collect(e.with, e.actor_version);
  }

  const dragonCount = copyAllDragons();

  console.log(`✓ ${snapshotCount} snapshots → client/public/relationship-graph/`);
  console.log(`✓ ${versionsSeen.size} face portraits → client/public/kb/characters/face_refs/`);
  console.log(`✓ ${dragonCount} dragon portraits → client/public/kb/characters/dragon_refs/`);
}

main();
