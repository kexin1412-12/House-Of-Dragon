# KB Structure Reorg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate per-episode KB data into `kb/videos/<videoId>/`, centralize all kb path construction in one `kb-paths.js` module, and remove verified junk — without changing any episode id.

**Architecture:** A new `server/lib/kb-paths.js` becomes the single source of every kb path. Per-episode files (`scene`, `stance`, `storyline`, `symbols`, `dialogue_riffs`) move under `kb/videos/<videoId>/` with fixed names; every reader is rewired to the helper in the same change so the app is never left reading a moved-away path. Show-level files are untouched on disk but also routed through the helper. Then junk/one-off files are removed/archived.

**Tech Stack:** Node.js (CommonJS), `node:test` / `node:assert` (built-in), Express (existing server).

## Global Constraints

- **Episode ids never change.** `house_of_dragon_05` and `house_of_dragon_s03e01` are load-bearing (R2 CDN url, subtitles, `video-catalog.json`, `demo-videos.json`, committed `retrieval/*.vectors.json` `video_id` values, `retrieval/eval.json`). Only folders move.
- No new runtime dependencies. Tests use built-in `node:test` / `node:assert`.
- Per-episode folder is `kb/videos/<videoId>/` (NOT `episodes/` — `kb/episodes/` already holds season-meta files).
- Fixed per-episode filenames: `scene.json`, `stance.json`, `storyline.json`, `symbols.json`, `dialogue_riffs.json`.
- No reader may build a kb path inline after this change — all go through `kb-paths.js`.
- Use `git mv` for tracked files (preserve history).
- `index.js` loaders index by the `video_id` field *inside* each JSON (confirmed present), so scanning the new location + reading that field preserves behavior.

---

### Task 1: Create the `kb-paths.js` helper

**Files:**
- Create: `server/lib/kb-paths.js`
- Test: `server/test/kb-paths.test.js`

**Interfaces:**
- Produces:
  - Per-episode: `videoDir(videoId)`, `sceneKb(videoId)`, `stanceKb(videoId)`, `storylineKb(videoId)`, `sceneSymbols(videoId)`, `dialogueRiffs(videoId)` — all return absolute paths under `kb/videos/<videoId>/`.
  - Show-level: `charactersDb(showId)`, `roleplayDb(showId)`, `dragonRefsDir()`, `faceRefsDir(characterId, actorVersion)`, `symbolsDict(showId)`, `locations(showId)`, `loreCardsDir()`, `showDialogueRiffsDir()`, `seasonsDir()`, `vectors(showId)`.
  - Enumerator: `eachVideoFile(basename)` → `Array<{videoId, path}>` for every existing `kb/videos/<id>/<basename>`.
  - `KB_ROOT` (absolute path to `server/kb`).

- [ ] **Step 1: Write the failing test**

Create `server/test/kb-paths.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const kb = require('../lib/kb-paths');

test('per-episode builders point under kb/videos/<id>/', () => {
  assert.ok(kb.sceneKb('vid').endsWith(path.join('kb', 'videos', 'vid', 'scene.json')));
  assert.ok(kb.stanceKb('vid').endsWith(path.join('videos', 'vid', 'stance.json')));
  assert.ok(kb.storylineKb('vid').endsWith(path.join('videos', 'vid', 'storyline.json')));
  assert.ok(kb.sceneSymbols('vid').endsWith(path.join('videos', 'vid', 'symbols.json')));
  assert.ok(kb.dialogueRiffs('vid').endsWith(path.join('videos', 'vid', 'dialogue_riffs.json')));
});

test('show-level builders keep existing locations', () => {
  assert.ok(kb.charactersDb('show').endsWith(path.join('kb', 'characters', 'show.json')));
  assert.ok(kb.roleplayDb('show').endsWith(path.join('characters', 'show.roleplay.json')));
  assert.ok(kb.symbolsDict('show').endsWith(path.join('kb', 'symbols', 'show.json')));
  assert.ok(kb.locations('show').endsWith(path.join('kb', 'locations', 'show.json')));
  assert.ok(kb.vectors('show').endsWith(path.join('kb', 'retrieval', 'show.vectors.json')));
});

test('eachVideoFile enumerates existing per-episode files by basename', () => {
  // point KB_ROOT-independent: build a temp videos tree and monkey-check via real KB is fragile,
  // so assert against the real kb/videos once present is NOT done here; use a temp dir instead.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kbtest-'));
  fs.mkdirSync(path.join(tmp, 'a'));
  fs.mkdirSync(path.join(tmp, 'b'));
  fs.writeFileSync(path.join(tmp, 'a', 'stance.json'), '{}');
  fs.writeFileSync(path.join(tmp, 'b', 'stance.json'), '{}');
  fs.writeFileSync(path.join(tmp, 'b', 'scene.json'), '{}');
  const found = kb._enumerate(tmp, 'stance.json').map(x => x.videoId).sort();
  assert.deepStrictEqual(found, ['a', 'b']);
  const none = kb._enumerate(path.join(tmp, 'missing'), 'stance.json');
  assert.deepStrictEqual(none, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/kb-paths.test.js`
Expected: FAIL — cannot find module `../lib/kb-paths`.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/kb-paths.js`:

```js
// Single source of every kb path. No reader builds kb paths inline.
const path = require('path');
const fs = require('fs');

const KB = path.join(__dirname, '..', 'kb');

const videoDir      = (videoId) => path.join(KB, 'videos', videoId);
const sceneKb       = (videoId) => path.join(videoDir(videoId), 'scene.json');
const stanceKb      = (videoId) => path.join(videoDir(videoId), 'stance.json');
const storylineKb   = (videoId) => path.join(videoDir(videoId), 'storyline.json');
const sceneSymbols  = (videoId) => path.join(videoDir(videoId), 'symbols.json');
const dialogueRiffs = (videoId) => path.join(videoDir(videoId), 'dialogue_riffs.json');

const charactersDb  = (showId) => path.join(KB, 'characters', `${showId}.json`);
const roleplayDb    = (showId) => path.join(KB, 'characters', `${showId}.roleplay.json`);
const dragonRefsDir = () => path.join(KB, 'characters', 'dragon_refs');
const faceRefsDir   = (characterId, actorVersion) => path.join(KB, 'characters', 'face_refs', characterId, actorVersion);
const symbolsDict   = (showId) => path.join(KB, 'symbols', `${showId}.json`);
const locations     = (showId) => path.join(KB, 'locations', `${showId}.json`);
const loreCardsDir  = () => path.join(KB, 'lore_cards');
const showDialogueRiffsDir = () => path.join(KB, 'dialogue_riffs');
const seasonsDir    = () => path.join(KB, 'episodes');
const vectors       = (showId) => path.join(KB, 'retrieval', `${showId}.vectors.json`);

// Enumerate <root>/<sub>/<basename> for every subdir that has it. Exported base for testing.
function _enumerate(root, basename) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const videoId of fs.readdirSync(root)) {
    const p = path.join(root, videoId, basename);
    if (fs.existsSync(p)) out.push({ videoId, path: p });
  }
  return out;
}
const eachVideoFile = (basename) => _enumerate(path.join(KB, 'videos'), basename);

module.exports = {
  KB_ROOT: KB, videoDir, sceneKb, stanceKb, storylineKb, sceneSymbols, dialogueRiffs,
  charactersDb, roleplayDb, dragonRefsDir, faceRefsDir, symbolsDict, locations,
  loreCardsDir, showDialogueRiffsDir, seasonsDir, vectors, eachVideoFile, _enumerate,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/kb-paths.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/kb-paths.js server/test/kb-paths.test.js
git commit -m "feat(kb): add centralized kb-paths helper"
```

---

### Task 2: Move per-episode files + rewire every reader of a moved file

**Files:**
- Move (git mv): the 8 per-episode files listed below.
- Modify: `server/agent.js`, `server/index.js`, `server/lib/scene_analyst/tools.js`, `server/scripts/build_retrieval_index.js`, `server/scripts/eval_retrieval.js`.

**Interfaces:**
- Consumes: all functions from `server/lib/kb-paths.js` (Task 1).
- Produces: no new exports; the app now reads per-episode data from `kb/videos/<id>/`.

- [ ] **Step 1: Move the files with git mv and drop empty dirs**

```bash
cd server
mkdir -p kb/videos/house_of_dragon_05 kb/videos/house_of_dragon_s03e01
git mv kb/house_of_dragon_05.json            kb/videos/house_of_dragon_05/scene.json
git mv kb/stance/house_of_dragon_05.json     kb/videos/house_of_dragon_05/stance.json
git mv kb/storyline/house_of_dragon_05.json  kb/videos/house_of_dragon_05/storyline.json
git mv kb/house_of_dragon_s03e01.json           kb/videos/house_of_dragon_s03e01/scene.json
git mv kb/stance/house_of_dragon_s03e01.json    kb/videos/house_of_dragon_s03e01/stance.json
git mv kb/storyline/house_of_dragon_s03e01.json kb/videos/house_of_dragon_s03e01/storyline.json
git mv kb/scene_symbols/house_of_dragon_s03e01.json    kb/videos/house_of_dragon_s03e01/symbols.json
git mv "kb/dialogue_riffs/house-of-the-dragon-s03e01.json" kb/videos/house_of_dragon_s03e01/dialogue_riffs.json
rmdir kb/stance kb/storyline kb/scene_symbols
```

Note: `kb/dialogue_riffs/house-of-the-dragon.json` (show-level) stays. `kb/house-of-the-dragon_scene_episodes.json` stays.

- [ ] **Step 2: Rewire `agent.js`**

Add near the other requires at the top of `server/agent.js` (it already requires `./lib/retrieval` etc.):

```js
const kbPaths = require('./lib/kb-paths');
```

At `agent.js:177` (inside `loadKB`), change:
```js
  const file = path.join(KB_DIR, `${videoId}.json`);
```
to:
```js
  const file = kbPaths.sceneKb(videoId);
```

At `agent.js:184`, change:
```js
    const sceneSymbolsFile = path.join(KB_DIR, 'scene_symbols', `${videoId}.json`);
```
to:
```js
    const sceneSymbolsFile = kbPaths.sceneSymbols(videoId);
```

At each of `agent.js:3351`, `:3500`, `:3624`, `:3673`, change:
```js
    const stancePath = path.join(__dirname, 'kb', 'stance', `${videoId}.json`);
```
to:
```js
    const stancePath = kbPaths.stanceKb(videoId);
```

(`KB_DIR` at line 13 may now be unused; if so, delete that line. If still referenced elsewhere, leave it.)

- [ ] **Step 3: Rewire `index.js` loaders**

Add near the top requires of `server/index.js`:
```js
const kbPaths = require('./lib/kb-paths');
```

Replace `loadStoryline` (around `index.js:271-288`) body's scan with an enumerate over the new location:
```js
function loadStoryline() {
  if (_storylineCache) return _storylineCache;
  const byVideo = {};
  for (const { path: p } of kbPaths.eachVideoFile('storyline.json')) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.video_id) byVideo[j.video_id] = j;
    } catch (e) { console.warn(`[storyline] skip bad file ${p}:`, e.message); }
  }
  _storylineCache = byVideo;
  return byVideo;
}
```

Replace `loadStanceTriggers` (around `index.js:302-320`) similarly:
```js
function loadStanceTriggers() {
  if (_stanceTriggersCache) return _stanceTriggersCache;
  const byVideo = {};
  for (const { path: p } of kbPaths.eachVideoFile('stance.json')) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j.video_id) byVideo[j.video_id] = j;
    } catch (e) { console.warn(`[stance] skip bad triggers file ${p}:`, e.message); }
  }
  _stanceTriggersCache = byVideo;
  return byVideo;
}
```

Replace `loadRiffs` (around `index.js:192-208`) to scan BOTH the show-level dir and the per-episode files:
```js
function loadRiffs() {
  if (_riffsCache) return _riffsCache;
  const all = [];
  const readInto = (p, label) => {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const r of (j.riffs || [])) all.push(r);
    } catch (e) { console.warn(`[riffs] skip bad file ${label}:`, e.message); }
  };
  const showDir = kbPaths.showDialogueRiffsDir();
  if (fs.existsSync(showDir)) {
    for (const f of fs.readdirSync(showDir)) {
      if (f.endsWith('.json')) readInto(path.join(showDir, f), f);
    }
  }
  for (const { path: p } of kbPaths.eachVideoFile('dialogue_riffs.json')) readInto(p, p);
  _riffsCache = all;
  return all;
}
```

- [ ] **Step 4: Rewire `tools.js` + the two scripts (scene reads of moved files)**

In `server/lib/scene_analyst/tools.js`, add at top requires:
```js
const kbPaths = require('../kb-paths');
```
At `tools.js:57` change:
```js
    const kbPath = path.join(SERVER_DIR, 'kb', `${videoId}.json`);
```
to:
```js
    const kbPath = kbPaths.sceneKb(videoId);
```

In `server/scripts/build_retrieval_index.js`, add `const kbPaths = require('../lib/kb-paths');` near the top, and change the scene read `readJson(path.join(SERVER, 'kb', `${vid}.json`))` to `readJson(kbPaths.sceneKb(vid))`.

In `server/scripts/eval_retrieval.js`, add `const kbPaths = require('../lib/kb-paths');` near the top, and change `JSON.parse(fs.readFileSync(path.join(SERVER, 'kb', `${q.videoId}.json`), 'utf8'))` to `JSON.parse(fs.readFileSync(kbPaths.sceneKb(q.videoId), 'utf8'))`.

- [ ] **Step 5: Verify tests + app + endpoints**

```bash
cd server
node --test 2>&1 | grep -iE "tests [0-9]|pass [0-9]|fail [0-9]"     # expect fail 0
node -e "require('./agent.js'); console.log('agent.js loads')"      # expect: agent.js loads
node -e "require('./index.js')" & SRV=$!; sleep 2
curl -s "http://localhost:3001/api/storyline?videoId=house_of_dragon_05" | head -c 80; echo
curl -s "http://localhost:3001/api/stance/triggers?videoId=house_of_dragon_05" | head -c 80; echo
curl -s "http://localhost:3001/api/riffs?videoId=house_of_dragon_s03e01" | head -c 80; echo
kill $SRV
```
Expected: `fail 0`; `agent.js loads`; the three curls return JSON (storyline object, triggers array, riffs with count>0) — not 404/`no storyline`.

(If `PORT` differs, read it from `index.js`/`.env`; default is 3001.)

Also confirm retrieval still resolves the moved scene path via the build/eval scripts (offline, needs proxy/key — optional if network unavailable):
```bash
node -r dotenv/config -e "const p=require('./lib/kb-paths'); const fs=require('fs'); console.log('scene exists:', fs.existsSync(p.sceneKb('house_of_dragon_05')))"
```
Expected: `scene exists: true`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(kb): move per-episode data into kb/videos/<id>/, rewire readers via kb-paths"
```

---

### Task 3: Route show-level readers through the helper (paths unchanged)

**Files:**
- Modify: `server/lib/characters.js`, `server/lib/locations.js`, `server/lib/season.js`, `server/lib/scene_analyst/tools.js`, `server/lib/retrieval/index.js`, `server/scripts/build_retrieval_index.js`.

**Interfaces:**
- Consumes: `kb-paths.js`. No path *values* change — this is a pure refactor so the helper is the single source.

- [ ] **Step 1: Rewire the show-level readers**

`server/lib/characters.js` — add `const kbPaths = require('./kb-paths');` at top, then:
- `:17` `path.join(__dirname, '..', 'kb', 'characters', `${showId}.json`)` → `kbPaths.charactersDb(showId)`
- `:30` roleplay → `kbPaths.roleplayDb(showId)`
- `:191` dragon_refs dir → `kbPaths.dragonRefsDir()`
- `:291` face_refs → `kbPaths.faceRefsDir(characterId, actorVersion)`
- (leave `:292` — that's `client/public/...`, not a kb path.)

`server/lib/locations.js` — add `const kbPaths = require('./kb-paths');`, change `:10` → `kbPaths.locations(showId)`.

`server/lib/season.js` — add `const kbPaths = require('./kb-paths');`, change `:17` `SEASONS_DIR` → `kbPaths.seasonsDir()`. (Leave `:18` `KB_DIR` if used only for other joins already covered, or route those too.)

`server/lib/scene_analyst/tools.js` — `:61` charDb → `kbPaths.charactersDb(showId)`; `:64` symbols → `kbPaths.symbolsDict(showId)`.

`server/lib/retrieval/index.js` — `defaultLoadChunks` reads `kb/retrieval/<showId>.vectors.json`; change that `path.join(...)` to `kbPaths.vectors(showId || 'house-of-the-dragon')` (add `const kbPaths = require('../kb-paths');`).

`server/scripts/build_retrieval_index.js` — route its char/symbol/lore/vectors reads through the helper (`charactersDb`, `symbolsDict`, `loreCardsDir` as applicable, `vectors`).

- [ ] **Step 2: Verify**

```bash
cd server
node --test 2>&1 | grep -iE "tests [0-9]|pass [0-9]|fail [0-9]"   # fail 0
node -e "require('./agent.js'); require('./lib/season'); require('./lib/characters'); require('./lib/locations'); console.log('libs load')"
node -r dotenv/config -e "require('./lib/retrieval').retrieve({query:'月亮茶',cursor:{show_id:'house-of-the-dragon',video_id:'house_of_dragon_05',season:1,episode:'S01E05',cursorTime:2135,allowedSpoilerLevel:0}}).then(r=>console.log('retrieve returns',r.length)).catch(e=>console.log('ERR',e.message))"
```
Expected: `fail 0`; `libs load`; `retrieve returns` N>0 (or a clean network error if OpenAI unreachable — lexical fallback still returns N>0).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(kb): route show-level readers through kb-paths"
```

---

### Task 4: Cleanup — junk, one-off scripts, gitignore, package.json

**Files:**
- Delete: `server/kb/.backups/` (tracked); untracked `*.backup-*.json` under `server/kb/`.
- Move: 6 one-off scripts → `server/scripts/_archive/`.
- Modify: `.gitignore`, `server/package.json`.

**Interfaces:** none (no code paths change).

- [ ] **Step 1: Remove backups**

```bash
cd server
git rm -r kb/.backups
find kb -name '*.backup-*.json' -delete
rm -f kb/house_of_dragon_05.json.backup-restore-*.json
```

- [ ] **Step 2: Archive the spent one-off scripts**

```bash
cd server
mkdir -p scripts/_archive
git mv scripts/apply_upgrades.py scripts/_archive/
git mv scripts/upgrades_data.json scripts/_archive/
git mv scripts/dedupe_general.py scripts/_archive/
git mv scripts/extend_house_dragon_s3_characters.js scripts/_archive/
git mv scripts/extend_house_dragon_s3_reference_characters.js scripts/_archive/
git mv scripts/extend_house_dragon_s3_roleplay.js scripts/_archive/
printf '# Archived one-off scripts\n\nSpent single-use migration/seed scripts. Their output already lives in the committed KB/DB files. Kept as a record; not wired into package.json. Do not re-run — re-running the extend_* seeders would duplicate rows.\n' > scripts/_archive/README.md
git add scripts/_archive/README.md
```

- [ ] **Step 3: Drop the extend-s3 entries from package.json**

In `server/package.json` `"scripts"`, remove these three lines:
```json
    "extend-s3-characters": "node scripts/extend_house_dragon_s3_characters.js",
    "extend-s3-reference-characters": "node scripts/extend_house_dragon_s3_reference_characters.js",
    "extend-s3-roleplay": "node scripts/extend_house_dragon_s3_roleplay.js",
```
Verify JSON is still valid: `node -e "require('./server/package.json')"` from repo root (no error).

- [ ] **Step 4: gitignore regenerable script output + backups**

Append to `.gitignore` (repo root):
```
# regenerable script output / local backups
server/kb/.backups/
server/kb/characters/_suggestions/
```

- [ ] **Step 5: Verify**

```bash
cd server
node --test 2>&1 | grep -iE "tests [0-9]|pass [0-9]|fail [0-9]"   # fail 0
node -e "require('./package.json'); console.log('package.json valid')"
git status -s | head
```
Expected: `fail 0`; `package.json valid`; `git status` shows the deletions/moves staged, no surprise untracked kb data.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(kb): remove backups, archive spent one-off scripts, gitignore script output"
```

---

## Self-Review

- **Spec coverage:** §3 target layout → Task 2 Step 1 (git mv) + empty-dir removal. §4 helper → Task 1. §5 cleanup → Task 4. §6 reference updates → Task 2 (moved-file readers: agent.js, index.js, tools.js scene, build/eval scene) + Task 3 (show-level). §7 verification → Task 2 Step 5, Task 3 Step 2, Task 4 Step 5. Non-goal "ids unchanged" → Global Constraints + no id appears in any move target rename.
- **Placeholder scan:** none. `index.js` line numbers are approximate ("around") because earlier edits in the same file may shift them; the code blocks are exact replacements keyed to function names (`loadStoryline`/`loadStanceTriggers`/`loadRiffs`), which are unambiguous.
- **Type consistency:** `eachVideoFile(basename)` returns `{videoId, path}` objects; all three `index.js` loaders destructure `{ path: p }` consistently. Helper function names used in Tasks 2–3 (`sceneKb`, `sceneSymbols`, `stanceKb`, `storylineKb`, `dialogueRiffs`, `charactersDb`, `roleplayDb`, `symbolsDict`, `locations`, `dragonRefsDir`, `faceRefsDir`, `seasonsDir`, `showDialogueRiffsDir`, `vectors`, `eachVideoFile`) all match Task 1's `module.exports`.
