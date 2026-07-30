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
