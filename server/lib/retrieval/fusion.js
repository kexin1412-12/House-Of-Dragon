// Reciprocal Rank Fusion — fuse multiple ranked id lists by rank, not raw score.
function rrf(rankedLists, k = 60) {
  const scores = new Map();
  for (const list of rankedLists || []) {
    list.forEach((id, i) => {
      const add = 1 / (k + i + 1); // rank starts at 1
      scores.set(id, (scores.get(id) || 0) + add);
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

module.exports = { rrf };
