// Cursor → chunk eligibility. Runs BEFORE scoring, fail-closed.
// Mirrors the episode-number logic used in season.js / characters.js.

function epToNum(ep) {
  const m = String(ep || '').match(/^S(\d+)E(\d+)$/i);
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
}

// A chunk is "baseline" (cursor-independent) when it has no scene-level time key.
function isBaseline(chunk) {
  return chunk.available_from_time == null;
}

function isEligible(chunk, cursor) {
  // Fail-closed: no cursor → only cursor-independent baseline chunks.
  if (!cursor) return isBaseline(chunk);

  if (chunk.show_id !== cursor.show_id) return false;
  if (!cursor.crossVideo && chunk.video_id !== cursor.video_id) return false;
  if (typeof chunk.season === 'number' && chunk.season > cursor.season) return false;
  if ((chunk.spoiler_level || 0) > (cursor.allowedSpoilerLevel || 0)) return false;

  const chunkEp = epToNum(chunk.available_from_episode);
  const cursorEp = epToNum(cursor.episode);
  if (chunkEp == null || cursorEp == null) return false;
  if (chunkEp > cursorEp) return false;
  if (chunkEp < cursorEp) return true; // earlier episode → time-independent
  // same episode → gate by scene time (baseline chunks pass)
  if (isBaseline(chunk)) return true;
  return chunk.available_from_time <= cursor.cursorTime;
}

function filterEligible(chunks, cursor) {
  return (chunks || []).filter(c => isEligible(c, cursor));
}

module.exports = { epToNum, isEligible, filterEligible, isBaseline };
