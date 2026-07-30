// Dimension ③: face-recognition quality, evaluated deterministically & offline via
// leave-one-out (LOO) over the enrolled ArcFace gallery. No model inference, no running
// service: we replay face_service.py's EXACT matching decision (best-per-group dedup →
// cosine rank → ACCEPT_THRESHOLD → top1-vs-top2 MARGIN) on the stored 512-d embeddings.
//
// For each enrolled embedding we treat it as a query, hide that single vector, and ask:
// does the closed-set matcher recover the right character? This measures the gallery's
// separability and the decision thresholds — the two things that actually drive whether a
// face gets a correct name, a rejection, or a wrong name in production.
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', '..');
const GALLERY_FILE = path.join(SERVER, 'kb', 'characters', 'face_gallery.json');

// Mirror face_service.py defaults.
const ACCEPT_THRESHOLD = 0.45;
const MARGIN = 0.05;
const CANDIDATE_TOP_K = 3;

function norm(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const inv = 1 / (Math.sqrt(s) + 1e-8);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] * inv;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function loadFlat() {
  const gallery = JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf8'));
  const flat = [];
  let idx = 0;
  for (const [cid, versions] of Object.entries(gallery.characters || {})) {
    for (const [vkey, ventry] of Object.entries(versions)) {
      for (const emb of ventry.embeddings || []) {
        flat.push({
          uid: idx++,
          character_id: cid,
          version_key: vkey,
          actor: ventry.actor,
          version: ventry.version,
          emb: norm(emb),
        });
      }
    }
  }
  return { flat, meta: { show: gallery.show, model: gallery.model, dim: gallery.embedding_dim } };
}

// Replay the service's decision for one query against a candidate pool.
function decide(queryEmb, pool) {
  const bestPerGroup = new Map();
  for (const g of pool) {
    const sim = dot(queryEmb, g.emb);
    const key = g.character_id + '|' + g.version_key;
    const cur = bestPerGroup.get(key);
    if (!cur || sim > cur.similarity) {
      bestPerGroup.set(key, { character_id: g.character_id, version: g.version, actor: g.actor, similarity: sim });
    }
  }
  const ranked = [...bestPerGroup.values()].sort((a, b) => b.similarity - a.similarity);
  const top = ranked.slice(0, CANDIDATE_TOP_K);
  if (!top.length) return { status: 'no_face', match: null, top };
  const top1 = top[0].similarity;
  const top2 = top.length >= 2 ? top[1].similarity : -1;
  const margin = top1 - top2;
  if (top1 < ACCEPT_THRESHOLD) return { status: 'below_threshold', match: null, top, margin };
  if (margin < MARGIN) return { status: 'ambiguous', match: null, top, margin };
  return { status: 'matched', match: top[0], top, margin };
}

function run() {
  const { flat, meta } = loadFlat();
  const perChar = {};
  const confusion = {};
  let matchedCorrect = 0, matchedWrong = 0, rejected = 0;
  const samples = [];

  for (const q of flat) {
    const pool = flat.filter(g => g.uid !== q.uid); // leave-one-out
    const res = decide(q.emb, pool);
    const pc = (perChar[q.character_id] = perChar[q.character_id] || {
      character_id: q.character_id, actor: q.actor, n: 0, correct: 0, wrong: 0, rejected: 0,
    });
    pc.n += 1;

    let outcome;
    if (res.status === 'matched') {
      if (res.match.character_id === q.character_id) { matchedCorrect++; pc.correct++; outcome = 'correct'; }
      else {
        matchedWrong++; pc.wrong++; outcome = 'wrong';
        const key = q.character_id + ' → ' + res.match.character_id;
        confusion[key] = (confusion[key] || 0) + 1;
      }
    } else { rejected++; pc.rejected++; outcome = 'rejected'; }

    samples.push({
      character_id: q.character_id, version_key: q.version_key, actor: q.actor,
      status: res.status, outcome,
      predicted: res.match ? res.match.character_id : null,
      top1_sim: res.top && res.top[0] ? +res.top[0].similarity.toFixed(4) : null,
      margin: typeof res.margin === 'number' ? +res.margin.toFixed(4) : null,
    });
  }

  const total = flat.length || 1;
  const perCharList = Object.values(perChar)
    .map(c => ({ ...c, accuracy: c.n ? c.correct / c.n : 0 }))
    .sort((a, b) => a.accuracy - b.accuracy);
  const confusionList = Object.entries(confusion)
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count);

  return {
    meta,
    threshold: ACCEPT_THRESHOLD,
    margin: MARGIN,
    total_embeddings: flat.length,
    characters: Object.keys(perChar).length,
    top1_accuracy: matchedCorrect / total,
    false_accept_rate: matchedWrong / total,
    reject_rate: rejected / total,
    accuracy_when_matched: (matchedCorrect + matchedWrong) ? matchedCorrect / (matchedCorrect + matchedWrong) : 1,
    counts: { correct: matchedCorrect, wrong: matchedWrong, rejected },
    per_character: perCharList,
    confusion: confusionList,
    samples,
  };
}

module.exports = { run };
