// Dimension ③: face recognition on real in-show frames via the PRODUCTION path —
// lib/face-recognition.js (Gemini Pro multimodal), the same code /api/agent/characters/recognize
// runs. The ArcFace closed-set service was retired (degenerate gallery, 7.5% identify rate).
//
// Inputs: 53 face crops from S1E5 committed under datasets/face_frames/ + a human-verified
// clear Viserys close-up (hero probe). Metrics:
//   - identification rate (how often the model commits to an identity at conf ≥ 0.7)
//   - accuracy on the subset with human-verified labels in the manifest
//   - hero probe correctness
// LLM calls are cached to .cache/face_llm.json (keyed by file + model); --refresh re-runs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..', '..', '..');
const faceRec = require(path.join(SERVER, 'lib', 'face-recognition'));
const kbPaths = require(path.join(SERVER, 'lib', 'kb-paths'));
const { cursorAtTime } = require(path.join(SERVER, 'lib', 'characters'));

const FRAMES_DIR = path.join(__dirname, '..', 'datasets', 'face_frames');
const MANIFEST = path.join(FRAMES_DIR, 'manifest.json');
const CACHE_FILE = path.join(__dirname, '..', '.cache', 'face_llm.json');

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } }
function saveCache(c) { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 1)); }

function dataUrlOf(file) {
  return 'data:image/jpeg;base64,' + fs.readFileSync(path.join(FRAMES_DIR, file)).toString('base64');
}

async function recognizeOne({ file, t, kb, db, cache, refresh }) {
  const model = process.env.AI_FACE_MODEL || 'gemini-3.1-pro-preview';
  const key = model + ':' + file + ':' + crypto.createHash('sha1')
    .update(fs.readFileSync(path.join(FRAMES_DIR, file))).digest('hex').slice(0, 10);
  if (!refresh && cache[key]) return cache[key];

  const cursor = kb ? cursorAtTime(kb, t) : null;
  let result;
  try {
    const chars = await faceRec.recognizeFaces({ image: dataUrlOf(file), db, cursor, recognitionContext: null });
    // Crop contains one face → the model's highest-confidence character is the subject.
    const top = (chars || []).slice().sort((a, b) => b.confidence - a.confidence)[0] || null;
    result = {
      predicted: top ? top.character_id : null,
      display_name: top ? top.display_name : null,
      confidence: top ? +Number(top.confidence).toFixed(3) : null,
      n_returned: (chars || []).length,
    };
  } catch (e) {
    result = { error: String(e.message || e).slice(0, 120), predicted: null, n_returned: 0 };
  }
  cache[key] = result;
  saveCache(cache);
  return result;
}

async function run(opts = {}) {
  if (!fs.existsSync(MANIFEST)) return { skipped: true, reason: 'no frame set (datasets/face_frames/manifest.json missing)' };
  if (!faceRec.isAvailable()) return { skipped: true, reason: 'face_recognition task unavailable (no Gemini/OpenAI key)' };

  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const kb = JSON.parse(fs.readFileSync(kbPaths.sceneKb('house_of_dragon_05'), 'utf8'));
  const dbPath = kbPaths.charactersDb(kb.show_id);
  const db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : { characters: [] };
  const cache = loadCache();

  const rows = [];
  for (const fr of man.frames) {
    const r = await recognizeOne({ file: fr.file, t: fr.t, kb, db, cache, refresh: opts.refresh });
    rows.push({ file: fr.file, t: fr.t, verified: fr.verified_character_id || null, ...r });
  }

  // Hero probe (human-verified clear close-up).
  let hero = null;
  if (man.hero) {
    const r = await recognizeOne({ file: man.hero.file, t: man.hero.t, kb, db, cache, refresh: opts.refresh });
    hero = {
      file: man.hero.file, truth: man.hero.verified_character_id, thumb: dataUrlOf(man.hero.file),
      ...r,
      correct: r.predicted === man.hero.verified_character_id,
    };
  }

  const n = rows.length || 1;
  const identified = rows.filter(r => r.predicted).length;
  const verifiedRows = rows.filter(r => r.verified);
  const verifiedIdentified = verifiedRows.filter(r => r.predicted);
  const verifiedCorrect = verifiedRows.filter(r => r.predicted && r.predicted === r.verified).length;
  const verifiedWrong = verifiedIdentified.length - verifiedCorrect;

  const step = Math.max(1, Math.floor(rows.length / 6));
  const samples = rows.filter((_, i) => i % step === 0).slice(0, 6).map(r => ({ ...r, thumb: dataUrlOf(r.file) }));

  return {
    skipped: false,
    engine: 'gemini-pro (lib/face-recognition.js, production path)',
    model: process.env.AI_FACE_MODEL || 'gemini-3.1-pro-preview',
    total_frames: rows.length,
    identified,
    identified_rate: identified / n,
    abstain_rate: (n - identified) / n,
    verified: {
      n: verifiedRows.length,
      identified: verifiedIdentified.length,
      correct: verifiedCorrect,
      wrong: verifiedWrong,
      accuracy_when_identified: verifiedIdentified.length ? verifiedCorrect / verifiedIdentified.length : null,
    },
    hero,
    rows,
    samples,
  };
}

module.exports = { run };
