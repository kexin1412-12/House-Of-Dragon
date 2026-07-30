# KB Structure Reorg — Design

**Date:** 2026-07-29
**Status:** Approved design, pending implementation plan
**Scope:** `server/kb/` folder layout, `server/scripts/` cleanup, and the code that reads kb paths

## 1. Problem

Per-episode data is scattered across ~5 sibling folders under 3 naming styles, so
adding an episode means dropping files into many places under inconsistent names,
and it's easy to miss one:

| Data | Current location | Naming style |
|---|---|---|
| Scene KB | `kb/<id>.json` (top level) | `house_of_dragon_05`, `house_of_dragon_s03e01` |
| Stance | `kb/stance/<id>.json` | underscore id |
| Storyline | `kb/storyline/<id>.json` | underscore id |
| Scene symbols | `kb/scene_symbols/<id>.json` | underscore id (only S3E1 present) |
| Dialogue riffs | `kb/dialogue_riffs/house-of-the-dragon-s03e01.json` | hyphen id (only S3E1) |

Plus junk: a **tracked** backup dir (`kb/.backups/`), ~13 untracked `*.backup-*.json`
files, and spent one-off scripts.

## 2. Goals / Non-goals

- **Goal:** consolidate per-episode data into one folder per episode, centralize kb
  path construction in one module, and remove verified junk — so adding an episode is
  "create one folder with fixed file names."
- **Non-goal (hard constraint): do NOT rename episode ids.** `house_of_dragon_05` /
  `house_of_dragon_s03e01` are load-bearing: they name the R2 CDN video URL, subtitles,
  `video-catalog.json`, `demo-videos.json`, every kb file, `retrieval/eval.json`, and the
  `video_id` baked into the committed `retrieval/*.vectors.json`. Only *folders* move; ids
  stay byte-for-byte.
- **Non-goal:** restructuring show-level files (`characters/`, `symbols/`, `locations/`,
  `lore_cards/`, `retrieval/`) — they are already one clean file per show. Leave them.

## 3. Target layout

Per-episode data moves into `kb/videos/<videoId>/` (named `videos/` — NOT `episodes/` —
because `kb/episodes/` already holds season-meta files):

```
kb/
  videos/                                  ← NEW
    house_of_dragon_05/
      scene.json          ← kb/house_of_dragon_05.json
      stance.json         ← kb/stance/house_of_dragon_05.json
      storyline.json      ← kb/storyline/house_of_dragon_05.json
    house_of_dragon_s03e01/
      scene.json          ← kb/house_of_dragon_s03e01.json
      stance.json         ← kb/stance/house_of_dragon_s03e01.json
      storyline.json      ← kb/storyline/house_of_dragon_s03e01.json
      symbols.json        ← kb/scene_symbols/house_of_dragon_s03e01.json
      dialogue_riffs.json ← kb/dialogue_riffs/house-of-the-dragon-s03e01.json (name fixed)
  characters/…            (unchanged)
  symbols/…  locations/…  lore_cards/…  retrieval/…            (unchanged)
  dialogue_riffs/house-of-the-dragon.json                       (show-level, stays)
  episodes/house-of-the-dragon.season-{1,3}.json                (season meta, stays)
  house-of-the-dragon_scene_episodes.json                       (stays)
```

Then remove the now-empty `kb/stance/`, `kb/storyline/`, `kb/scene_symbols/`.

Files present per episode are uneven (S1E5 has no scene_symbols/dialogue_riffs); that is
fine — a `kb/videos/<id>/` folder simply contains whatever that episode has. Readers must
tolerate a missing per-episode file (return null), which the current code already does.

## 4. The path helper (the core of the fix)

New module `server/lib/kb-paths.js` is the single place any kb path is built. All readers
call it instead of inline `path.join('kb', …)`. After this, the layout is defined in one
file and cannot drift.

```js
// server/lib/kb-paths.js  (illustrative signatures)
const path = require('path');
const KB = path.join(__dirname, '..', 'kb');

const videoDir     = (videoId) => path.join(KB, 'videos', videoId);
const sceneKb      = (videoId) => path.join(videoDir(videoId), 'scene.json');
const stanceKb     = (videoId) => path.join(videoDir(videoId), 'stance.json');
const storylineKb  = (videoId) => path.join(videoDir(videoId), 'storyline.json');
const sceneSymbols = (videoId) => path.join(videoDir(videoId), 'symbols.json');
const dialogueRiffs= (videoId) => path.join(videoDir(videoId), 'dialogue_riffs.json');

const charactersDb = (showId) => path.join(KB, 'characters', `${showId}.json`);
const roleplayDb   = (showId) => path.join(KB, 'characters', `${showId}.roleplay.json`);
const symbolsDict  = (showId) => path.join(KB, 'symbols', `${showId}.json`);
const locations    = (showId) => path.join(KB, 'locations', `${showId}.json`);
const loreCards    = (showId) => path.join(KB, 'lore_cards', `${showId}.json`);
const showDialogueRiffs = (showId) => path.join(KB, 'dialogue_riffs', `${showId}.json`);
const seasonMeta   = (showId, season) => path.join(KB, 'episodes', `${showId}.season-${season}.json`);
const vectors      = (showId) => path.join(KB, 'retrieval', `${showId}.vectors.json`);
const KB_ROOT = KB;
module.exports = { KB_ROOT, videoDir, sceneKb, stanceKb, storylineKb, sceneSymbols,
  dialogueRiffs, charactersDb, roleplayDb, symbolsDict, locations, loreCards,
  showDialogueRiffs, seasonMeta, vectors };
```

(The exact export set is finalized during implementation against the real call sites; the
principle is fixed: no reader builds a kb path inline anymore.)

## 5. Cleanup (moderate, post-verification)

- **Delete:** `kb/.backups/` (tracked backup) · all untracked `*.backup-*.json` under `kb/`
  (~13) · `kb/house_of_dragon_05.json.backup-restore-*.json`.
- **Archive → `server/scripts/_archive/`:** `apply_upgrades.py`, `upgrades_data.json`,
  `dedupe_general.py`, `extend_house_dragon_s3_characters.js`,
  `extend_house_dragon_s3_reference_characters.js`, `extend_house_dragon_s3_roleplay.js`
  (all spent one-shot seeders; their data is already in the committed DBs). Remove the
  `extend-s3-*` entries from `package.json`.
- **`.gitignore` additions:** `server/kb/.backups/`, `server/kb/characters/_suggestions/`.
- **Explicitly keep:** `_suggestions/` mechanism (output of `enrich_characters.js`),
  `track_characters.py` (invoked by `track_characters.js`), all other pipeline scripts.

## 6. Reference updates (blast radius)

Update these to use `kb-paths.js` (they currently build kb paths inline):

- `server/agent.js` — `loadKB` and the stance / storyline / scene_symbols / dialogue_riffs readers (~15 sites).
- `server/lib/season.js` — season-meta dir.
- `server/lib/scene_analyst/tools.js` — `fromVideo` (scene kb, characters, symbols).
- `server/lib/characters.js`, `server/lib/locations.js`.
- `server/scripts/build_retrieval_index.js` — reads `kb/<videoId>.json` → `sceneKb(videoId)`.
- `server/scripts/eval_retrieval.js` — reads `kb/<videoId>.json` → `sceneKb(videoId)`.
- Any other reader surfaced by grep for `'kb'` path joins during implementation.

Unaffected because ids don't change: R2 video URL, subtitles, `video-catalog.json`,
`demo-videos.json`, `retrieval/*.vectors.json` (chunk `video_id`), `retrieval/eval.json`.

## 7. Execution & verification

- Use `git mv` for tracked files (preserve history); create `kb/videos/<id>/` folders.
- Do the path-helper + call-site swap and the file move together so the app is never left
  reading a moved-away path.
- **Verification gate (all must pass before done):**
  - `cd server && node --test` → 43/43 (existing suite; add a small `kb-paths` unit test).
  - `node -e "require('./agent.js')"` loads with no error.
  - `node -r dotenv/config -e "require('./lib/retrieval').retrieve({query:'月亮茶是什么',cursor:{show_id:'house-of-the-dragon',video_id:'house_of_dragon_05',season:1,episode:'S01E05',cursorTime:2135,allowedSpoilerLevel:0}}).then(r=>console.log(r.length))"` → non-empty.
  - `node -r dotenv/config scripts/eval_retrieval.js` still runs (leaks 0).
  - `node scripts/build_retrieval_index.js …` resolves the new scene path (dry check).

## 8. Out of scope (future, not now)

- Renaming ids to a consistent `sNNeMM` scheme (would require re-uploading the R2 asset and
  rebuilding the vectors — deferred).
- Restructuring show-level files into `kb/shows/<showId>/`.
