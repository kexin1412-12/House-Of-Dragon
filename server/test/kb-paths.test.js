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
