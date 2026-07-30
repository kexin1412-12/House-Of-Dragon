// Dimension ③ (real frames): does the ArcFace face service actually recognize faces from
// real episode footage? We take face crops detected across S1E5, POST each to the live
// service's /recognize (same call the production app makes), and measure how many get a
// confident identity vs get rejected — plus whether the raw similarities are discriminative
// at all. A human-verified clear Viserys close-up (hero) is included as a labeled probe.
//
// This needs the service running (start scripts/face_service.py). Crops are committed under
// datasets/face_frames/, so the eval re-runs without the source video. If the service is
// down the dimension reports skipped with start instructions.
const fs = require('fs');
const path = require('path');

const FRAMES_DIR = path.join(__dirname, '..', 'datasets', 'face_frames');
const MANIFEST = path.join(FRAMES_DIR, 'manifest.json');

async function serviceUp(url) {
  try { const r = await fetch(url + '/health', { signal: AbortSignal.timeout(4000) }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
function dataUrlOf(file) {
  return 'data:image/jpeg;base64,' + fs.readFileSync(path.join(FRAMES_DIR, file)).toString('base64');
}
async function recognize(url, dataUrl) {
  const r = await fetch(url + '/recognize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl }), signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return (j.faces || []).sort((a, b) =>
    ((b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1])) - ((a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1])))[0] || null;
}

async function run() {
  const url = process.env.FACE_SERVICE_URL || 'http://127.0.0.1:5001';
  if (!fs.existsSync(MANIFEST)) return { skipped: true, reason: 'no frame set (datasets/face_frames/manifest.json missing)' };
  const health = await serviceUp(url);
  if (!health) return { skipped: true, reason: `ArcFace service not reachable at ${url}. Start it: conda run -n hotd-face python server/scripts/face_service.py` };

  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const rows = [];
  for (const fr of man.frames) {
    try {
      const f = await recognize(url, dataUrlOf(fr.file));
      rows.push({
        file: fr.file, t: fr.t,
        status: f ? f.status : 'no_face',
        matched: f && f.status === 'matched' ? f.match.character_id : null,
        top1: f && f.candidates && f.candidates[0] ? { id: f.candidates[0].character_id, sim: +f.candidates[0].similarity.toFixed(3) } : null,
        top2: f && f.candidates && f.candidates[1] ? { id: f.candidates[1].character_id, sim: +f.candidates[1].similarity.toFixed(3) } : null,
      });
    } catch { rows.push({ file: fr.file, t: fr.t, status: 'error', top1: null }); }
  }

  // Hero probe: a human-verified clear frontal Viserys close-up.
  let hero = null;
  if (man.hero) {
    try {
      const f = await recognize(url, dataUrlOf(man.hero.file));
      hero = {
        file: man.hero.file, truth: man.hero.verified_character_id, thumb: dataUrlOf(man.hero.file),
        status: f ? f.status : 'no_face',
        matched: f && f.status === 'matched' ? f.match.character_id : null,
        candidates: f ? (f.candidates || []).map(c => ({ id: c.character_id, sim: +c.similarity.toFixed(3) })) : [],
        truth_in_top3: f ? (f.candidates || []).slice(0, 3).some(c => c.character_id === man.hero.verified_character_id) : false,
      };
    } catch { hero = { error: true, file: man.hero.file }; }
  }

  const n = rows.length || 1;
  const identified = rows.filter(r => r.status === 'matched').length;
  const ambiguous = rows.filter(r => r.status === 'ambiguous').length;
  const below = rows.filter(r => r.status === 'below_threshold').length;
  const noface = rows.filter(r => r.status === 'no_face' || r.status === 'error').length;
  const sims = rows.filter(r => r.top1).map(r => r.top1.sim);
  const avgSim = sims.length ? sims.reduce((a, b) => a + b, 0) / sims.length : 0;

  // Degeneracy: which identity does the top candidate collapse onto?
  const collapse = {};
  for (const r of rows) if (r.top1) collapse[r.top1.id] = (collapse[r.top1.id] || 0) + 1;
  const collapseList = Object.entries(collapse).map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);

  // A handful of sample thumbnails spread across the set for the report.
  const step = Math.max(1, Math.floor(rows.length / 6));
  const samples = rows.filter((_, i) => i % step === 0).slice(0, 6).map(r => ({
    ...r, thumb: dataUrlOf(r.file),
  }));

  return {
    skipped: false,
    service: { url, gallery_size: health.gallery_size, threshold: health.threshold },
    total_frames: rows.length,
    identified, ambiguous, below_threshold: below, no_face: noface,
    identified_rate: identified / n,
    reject_rate: (ambiguous + below + noface) / n,
    avg_top1_sim: avgSim,
    sims_above_threshold: sims.filter(s => s >= health.threshold).length,
    distinct_top1_identities: collapseList.length,
    collapse: collapseList,
    hero,
    samples,
  };
}

module.exports = { run };
