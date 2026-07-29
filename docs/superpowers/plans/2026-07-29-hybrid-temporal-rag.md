# Hybrid Temporal RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bigram-only retrieval layer with an in-process Hybrid Temporal RAG (dense + sparse recall, temporal/spoiler hard-filter, deterministic rerank) that unifies scene readings and character timelines into one time-gated, retrievable index.

**Architecture:** A new `server/lib/retrieval/` folder holds focused pure modules (temporal filter, lexical arm, vector store, RRF fusion, reranker, context builder, chunkers, orchestrator). The existing `server/lib/retrieval.js` becomes a thin backward-compatible shim. Offline scripts project all KB sources into chunk records, tag the 解说 recap by episode, embed everything with OpenAI, and evaluate old-vs-new retrieval. The dense arm sits behind an env flag; when OpenAI embeddings are unavailable the orchestrator falls back to today's pure-lexical behavior.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert` (built-in, no new deps), `openai` SDK (already a dependency), OpenAI `text-embedding-3-small`.

## Global Constraints

- No external vector DB (no Qdrant/pgvector). Vectors live in a local file loaded once into a module cache.
- No new runtime dependencies. Tests use built-in `node:test` / `node:assert`.
- Embedding model: `text-embedding-3-small` (verbatim; stored in chunk `embedding_model`).
- `retrieve()` must stay backward compatible: `{query, characterNames, characterAliases, k}` keep working; new fields `{videoId, cursorTime, currentScene, characterIds, intent}` are all optional.
- Temporal/spoiler filter runs BEFORE scoring, fail-closed. Missing cursor → baseline-only (lore_card + non-time-sensitive chunks). Any future-episode chunk in a candidate set is a hard failure.
- Chunk records carry `schema_version` (start at `1`) so later chunk types need no re-ingest.
- `scene_fact` is NOT indexed (reaches the model via the `agent.js` business path).
- UI-visible text rules still apply downstream, but chunk `content` is model-facing only; no user-facing copy is produced by this plan.

---

### Task 1: Test harness + temporal filter

**Files:**
- Modify: `server/package.json` (add `test` script)
- Create: `server/lib/retrieval/temporal-filter.js`
- Test: `server/test/temporal-filter.test.js`

**Interfaces:**
- Produces:
  - `epToNum(ep: string) -> number|null` — `"S03E01"` → `301`.
  - `isEligible(chunk, cursor) -> boolean` where `cursor = {show_id, video_id, season, episode, cursorTime, allowedSpoilerLevel, crossVideo}`.
  - `filterEligible(chunks: object[], cursor) -> object[]`.

- [ ] **Step 1: Add the test script**

In `server/package.json`, add to `"scripts"`:

```json
"test": "node --test"
```

- [ ] **Step 2: Write the failing test**

Create `server/test/temporal-filter.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { epToNum, isEligible, filterEligible } = require('../lib/retrieval/temporal-filter');

const cursor = {
  show_id: 'house-of-the-dragon', video_id: 'v1', season: 3,
  episode: 'S03E01', cursorTime: 900, allowedSpoilerLevel: 0, crossVideo: false,
};
const base = {
  show_id: 'house-of-the-dragon', video_id: 'v1', season: 3,
  spoiler_level: 0, available_from_episode: 'S03E01',
};

test('epToNum parses episode codes', () => {
  assert.strictEqual(epToNum('S03E01'), 301);
  assert.strictEqual(epToNum('S01E10'), 110);
  assert.strictEqual(epToNum('nope'), null);
});

test('same episode gated by available_from_time', () => {
  assert.ok(isEligible({ ...base, available_from_time: 800 }, cursor));
  assert.ok(!isEligible({ ...base, available_from_time: 1000 }, cursor));
});

test('earlier episode is time-independent', () => {
  assert.ok(isEligible({ ...base, available_from_episode: 'S02E05', available_from_time: 99999 }, cursor));
});

test('future episode is blocked', () => {
  assert.ok(!isEligible({ ...base, available_from_episode: 'S03E02', available_from_time: 0 }, cursor));
});

test('higher spoiler level blocked', () => {
  assert.ok(!isEligible({ ...base, available_from_time: 0, spoiler_level: 2 }, cursor));
});

test('other show blocked; other video blocked unless crossVideo', () => {
  assert.ok(!isEligible({ ...base, available_from_time: 0, show_id: 'got' }, cursor));
  assert.ok(!isEligible({ ...base, available_from_time: 0, video_id: 'v2' }, cursor));
  assert.ok(isEligible({ ...base, available_from_time: 0, video_id: 'v2' }, { ...cursor, crossVideo: true }));
});

test('missing cursor → baseline only (lore/no time key)', () => {
  const loreish = { show_id: 'house-of-the-dragon', video_id: 'v1', season: 1, spoiler_level: 0, available_from_episode: 'S01E01' };
  assert.ok(isEligible(loreish, null));
  assert.ok(!isEligible({ ...base, available_from_time: 0 }, null)); // has scene time → not baseline
});

test('filterEligible returns only eligible', () => {
  const chunks = [
    { ...base, id: 'a', available_from_time: 800 },
    { ...base, id: 'b', available_from_episode: 'S03E02', available_from_time: 0 },
  ];
  assert.deepStrictEqual(filterEligible(chunks, cursor).map(c => c.id), ['a']);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && node --test test/temporal-filter.test.js`
Expected: FAIL — cannot find module `../lib/retrieval/temporal-filter`.

- [ ] **Step 4: Write minimal implementation**

Create `server/lib/retrieval/temporal-filter.js`:

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && node --test test/temporal-filter.test.js`
Expected: PASS (all subtests).

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/lib/retrieval/temporal-filter.js server/test/temporal-filter.test.js
git commit -m "feat(retrieval): temporal/spoiler eligibility filter + test harness"
```

---

### Task 2: RRF fusion

**Files:**
- Create: `server/lib/retrieval/fusion.js`
- Test: `server/test/fusion.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `rrf(rankedLists: string[][], k=60) -> {id, score}[]` — each input is an ordered array of chunk ids (best first); output is fused, sorted by descending score.

- [ ] **Step 1: Write the failing test**

Create `server/test/fusion.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { rrf } = require('../lib/retrieval/fusion');

test('id ranked high in both lists wins', () => {
  const fused = rrf([['a', 'b', 'c'], ['a', 'c', 'd']]);
  assert.strictEqual(fused[0].id, 'a');
});

test('union of all ids preserved', () => {
  const ids = rrf([['a', 'b'], ['c']]).map(r => r.id).sort();
  assert.deepStrictEqual(ids, ['a', 'b', 'c']);
});

test('score uses 1/(k+rank), rank starting at 1', () => {
  const fused = rrf([['x']], 60);
  assert.ok(Math.abs(fused[0].score - 1 / 61) < 1e-9);
});

test('empty input → empty output', () => {
  assert.deepStrictEqual(rrf([]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/fusion.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/retrieval/fusion.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/fusion.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/retrieval/fusion.js server/test/fusion.test.js
git commit -m "feat(retrieval): RRF rank fusion"
```

---

### Task 3: Lexical arm (extract bigram scorer)

**Files:**
- Create: `server/lib/retrieval/lexical.js`
- Test: `server/test/lexical.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `bigrams(text) -> string[]`
  - `normalizeName(s) -> string`
  - `rankLexical(chunks, {query, nameKeys}) -> string[]` — ordered chunk ids, best first, dropping zero-score chunks. Uses each chunk's `retrieval_text` (falls back to `content`), and `character_ids`.

- [ ] **Step 1: Write the failing test**

Create `server/test/lexical.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { bigrams, normalizeName, rankLexical } = require('../lib/retrieval/lexical');

test('bigrams strips whitespace and yields 2-grams', () => {
  assert.deepStrictEqual(bigrams('沉默'), ['沉默']);
  assert.ok(bigrams('御前 会议').includes('会议'));
});

test('normalizeName lowercases and strips separators', () => {
  assert.strictEqual(normalizeName('阿莉森特·海塔尔'), '阿莉森特海塔尔');
});

test('character-id match outranks pure text match', () => {
  const chunks = [
    { id: 'txt', retrieval_text: '关于沉默的解读', character_ids: [] },
    { id: 'char', retrieval_text: '会议', character_ids: ['alicent_hightower'] },
  ];
  const ranked = rankLexical(chunks, { query: '沉默', nameKeys: ['alicent_hightower'] });
  assert.strictEqual(ranked[0], 'char');
});

test('zero-score chunks dropped', () => {
  const chunks = [{ id: 'x', retrieval_text: '无关内容', character_ids: [] }];
  assert.deepStrictEqual(rankLexical(chunks, { query: 'zzz', nameKeys: [] }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/lexical.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/retrieval/lexical.js` (ported from the current `retrieval.js` scorer):

```js
// Sparse/keyword arm — bigram + character-id matching. Ported from the
// original retrieval.js so exact names / IDs / 台词 stay reliably matchable.

function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    if (/^[\W_]+$/.test(b)) continue;
    out.push(b);
  }
  return out;
}

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[\s·\-]+/g, '');
}

function rankLexical(chunks, { query = '', nameKeys = [] } = {}) {
  const qBigrams = bigrams(query);
  const keys = (nameKeys || []).map(normalizeName).filter(Boolean);

  const scored = (chunks || []).map(c => {
    const blob = String(c.retrieval_text || c.content || '').toLowerCase();
    const blobNorm = blob.replace(/[\s·\-]+/g, '');
    const charNorms = (c.character_ids || []).map(normalizeName);
    let score = 0;
    for (const nk of keys) {
      if (charNorms.some(cn => cn.includes(nk) || nk.includes(cn))) score += 5;
      else if (blobNorm.includes(nk)) score += 2;
    }
    if (qBigrams.length) {
      let hits = 0;
      for (const bg of qBigrams) if (blob.includes(bg)) hits++;
      score += Math.min(hits * 0.3, 3);
    }
    return { id: c.id, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.id);
}

module.exports = { bigrams, normalizeName, rankLexical };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/lexical.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/retrieval/lexical.js server/test/lexical.test.js
git commit -m "feat(retrieval): extract lexical (bigram) arm"
```

---

### Task 4: Vector store (cosine + embed + dense rank)

**Files:**
- Create: `server/lib/retrieval/vector-store.js`
- Test: `server/test/vector-store.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `cosine(a: number[], b: number[]) -> number`
  - `rankDense(chunks, queryEmbedding) -> string[]` — ordered ids by cosine over each chunk's `embedding`; chunks without `embedding` are skipped.
  - `async embedQuery(text, {client, cache}) -> number[]` — calls `client.embeddings.create`, caches by `model + hash(text)`; `client` is injectable for tests.
  - `EMBEDDING_MODEL = 'text-embedding-3-small'`.

- [ ] **Step 1: Write the failing test**

Create `server/test/vector-store.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { cosine, rankDense, embedQuery, EMBEDDING_MODEL } = require('../lib/retrieval/vector-store');

test('cosine of identical vectors is 1', () => {
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
});

test('rankDense orders by similarity, skips embedding-less chunks', () => {
  const q = [1, 0];
  const chunks = [
    { id: 'far', embedding: [0, 1] },
    { id: 'near', embedding: [0.9, 0.1] },
    { id: 'none' },
  ];
  assert.deepStrictEqual(rankDense(chunks, q), ['near', 'far']);
});

test('embedQuery uses injected client and caches', async () => {
  let calls = 0;
  const client = { embeddings: { create: async () => { calls++; return { data: [{ embedding: [1, 2, 3] }] }; } } };
  const cache = new Map();
  const a = await embedQuery('hi', { client, cache });
  const b = await embedQuery('hi', { client, cache });
  assert.deepStrictEqual(a, [1, 2, 3]);
  assert.deepStrictEqual(b, [1, 2, 3]);
  assert.strictEqual(calls, 1); // second call served from cache
  assert.strictEqual(EMBEDDING_MODEL, 'text-embedding-3-small');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/vector-store.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/retrieval/vector-store.js`:

```js
const crypto = require('crypto');

const EMBEDDING_MODEL = 'text-embedding-3-small';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function rankDense(chunks, queryEmbedding) {
  return (chunks || [])
    .filter(c => Array.isArray(c.embedding))
    .map(c => ({ id: c.id, score: cosine(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .map(s => s.id);
}

async function embedQuery(text, { client, cache } = {}) {
  const key = EMBEDDING_MODEL + ':' + crypto.createHash('sha1').update(String(text)).digest('hex');
  if (cache && cache.has(key)) return cache.get(key);
  const resp = await client.embeddings.create({ model: EMBEDDING_MODEL, input: String(text) });
  const vec = resp.data[0].embedding;
  if (cache) cache.set(key, vec);
  return vec;
}

module.exports = { cosine, rankDense, embedQuery, EMBEDDING_MODEL };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/vector-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/retrieval/vector-store.js server/test/vector-store.test.js
git commit -m "feat(retrieval): vector store (cosine, dense rank, cached query embed)"
```

---

### Task 5: Deterministic reranker

**Files:**
- Create: `server/lib/retrieval/rerank.js`
- Test: `server/test/rerank.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `rerank(chunks, cursorCtx) -> object[]` — returns the same chunk objects, reordered. `cursorCtx = {sceneId, characterIds, locationIds, symbolIds, cursorTime, intent}`. Weighted signals: current-scene, current-character, current-location/symbol, time distance, `confidence`, `knowledge_type`↔`intent` fit.

- [ ] **Step 1: Write the failing test**

Create `server/test/rerank.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { rerank } = require('../lib/retrieval/rerank');

const ctx = { sceneId: 's024', characterIds: ['rhaenyra'], locationIds: ['dragonstone'], symbolIds: [], cursorTime: 900, intent: 'character' };

test('current-scene chunk beats an off-scene one', () => {
  const chunks = [
    { id: 'off', scene_id: 's002', character_ids: [], knowledge_type: 'scene_reading', confidence: 0.9 },
    { id: 'here', scene_id: 's024', character_ids: [], knowledge_type: 'scene_reading', confidence: 0.5 },
  ];
  assert.strictEqual(rerank(chunks, ctx)[0].id, 'here');
});

test('character intent lifts character_motivation for the current character', () => {
  const chunks = [
    { id: 'reading', scene_id: 's002', character_ids: ['rhaenyra'], knowledge_type: 'scene_reading', confidence: 0.9 },
    { id: 'motive', scene_id: 's002', character_ids: ['rhaenyra'], knowledge_type: 'character_motivation', confidence: 0.6 },
  ];
  assert.strictEqual(rerank(chunks, ctx)[0].id, 'motive');
});

test('stable when ctx is empty (no throw)', () => {
  const chunks = [{ id: 'a', knowledge_type: 'lore_card' }];
  assert.deepStrictEqual(rerank(chunks, {}).map(c => c.id), ['a']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/rerank.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/retrieval/rerank.js`:

```js
// Deterministic rule reranker over the fused, already time-filtered candidates.

const INTENT_TYPE_BONUS = {
  character: { character_motivation: 3, character_relationship: 2.5, scene_reading: 1 },
  shot: { scene_shot: 3, symbol_occurrence: 2, symbol_definition: 1 },
  fact: { scene_fact: 3, subtitle_window: 2 },
};

function scoreChunk(c, ctx) {
  let s = 0;
  if (ctx.sceneId && c.scene_id === ctx.sceneId) s += 4;
  const ctxChars = new Set(ctx.characterIds || []);
  if ((c.character_ids || []).some(id => ctxChars.has(id))) s += 3;
  const ctxLoc = new Set(ctx.locationIds || []);
  if ((c.location_ids || []).some(id => ctxLoc.has(id))) s += 1.5;
  const ctxSym = new Set(ctx.symbolIds || []);
  if ((c.symbol_ids || []).some(id => ctxSym.has(id))) s += 1.5;
  if (typeof c.available_from_time === 'number' && typeof ctx.cursorTime === 'number') {
    const dist = Math.abs(ctx.cursorTime - c.available_from_time);
    s += Math.max(0, 1 - dist / 3600); // closer in time → up to +1
  }
  s += (typeof c.confidence === 'number' ? c.confidence : 0.5) * 0.5;
  const bonus = (INTENT_TYPE_BONUS[ctx.intent] || {})[c.knowledge_type] || 0;
  s += bonus;
  return s;
}

function rerank(chunks, ctx = {}) {
  return (chunks || [])
    .map(c => ({ c, s: scoreChunk(c, ctx) }))
    .sort((a, b) => b.s - a.s)
    .map(x => x.c);
}

module.exports = { rerank, scoreChunk };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/rerank.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/retrieval/rerank.js server/test/rerank.test.js
git commit -m "feat(retrieval): deterministic reranker"
```

---

### Task 6: Context builder (dedup + per-type quotas)

**Files:**
- Create: `server/lib/retrieval/context-builder.js`
- Test: `server/test/context-builder.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildContext(rankedChunks, {quotas, total}) -> object[]` — walks chunks in order, keeps each only if its `knowledge_type` quota is not exhausted and `total` not reached, dedups by `id`. Default quotas: `{scene_reading:2, character_state:1, character_relationship:1, character_motivation:1, lore_card:1, external_knowledge:2}`, default `total:8`.

- [ ] **Step 1: Write the failing test**

Create `server/test/context-builder.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildContext } = require('../lib/retrieval/context-builder');

test('per-type quota enforced in ranked order', () => {
  const chunks = [
    { id: 'r1', knowledge_type: 'scene_reading' },
    { id: 'r2', knowledge_type: 'scene_reading' },
    { id: 'r3', knowledge_type: 'scene_reading' },
    { id: 'l1', knowledge_type: 'lore_card' },
  ];
  const kept = buildContext(chunks, { quotas: { scene_reading: 2, lore_card: 1 }, total: 8 });
  assert.deepStrictEqual(kept.map(c => c.id), ['r1', 'r2', 'l1']);
});

test('total cap enforced', () => {
  const chunks = Array.from({ length: 5 }, (_, i) => ({ id: 'x' + i, knowledge_type: 'lore_card' }));
  const kept = buildContext(chunks, { quotas: { lore_card: 10 }, total: 3 });
  assert.strictEqual(kept.length, 3);
});

test('dedups by id', () => {
  const chunks = [{ id: 'a', knowledge_type: 'lore_card' }, { id: 'a', knowledge_type: 'lore_card' }];
  assert.strictEqual(buildContext(chunks, { quotas: { lore_card: 5 }, total: 8 }).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/context-builder.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/retrieval/context-builder.js`:

```js
const DEFAULT_QUOTAS = {
  scene_reading: 2, character_state: 1, character_relationship: 1,
  character_motivation: 1, lore_card: 1, external_knowledge: 2,
};

function buildContext(rankedChunks, { quotas = DEFAULT_QUOTAS, total = 8 } = {}) {
  const used = {};
  const seen = new Set();
  const out = [];
  for (const c of rankedChunks || []) {
    if (out.length >= total) break;
    if (seen.has(c.id)) continue;
    const type = c.knowledge_type || 'other';
    const cap = quotas[type] != null ? quotas[type] : total;
    if ((used[type] || 0) >= cap) continue;
    used[type] = (used[type] || 0) + 1;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

module.exports = { buildContext, DEFAULT_QUOTAS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/context-builder.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/retrieval/context-builder.js server/test/context-builder.test.js
git commit -m "feat(retrieval): context builder with per-type quotas"
```

---

### Task 7: Scene-reading chunker

**Files:**
- Create: `server/lib/retrieval/chunkers.js`
- Test: `server/test/chunkers-scene.test.js`

**Interfaces:**
- Consumes: `epToNum` from `temporal-filter.js`.
- Produces:
  - `hashContent(str) -> string` (sha1).
  - `episodeForScene(kb, sceneId) -> string|null` (reads `kb.episode_map`).
  - `chunkScenes(kb) -> object[]` — one `scene_reading` chunk per `visual_beats[]` entry (from `meaning` + `aesthetic_reading` + `thematic_mirrors`) and one per scene `tapestry_meta_reading`. Each chunk carries the §4 schema fields.

- [ ] **Step 1: Write the failing test**

Create `server/test/chunkers-scene.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { chunkScenes, episodeForScene, hashContent } = require('../lib/retrieval/chunkers');

const kb = {
  show_id: 'house-of-the-dragon', video_id: 'v1', season: 3,
  episode_map: [{ from_scene: 's002', to_scene: 's082', episode: 'S03E01' }],
  scenes: [{
    scene_id: 's024', start_time: 812.4, end_time: 861.7, characters: ['rhaenyra'],
    tapestry_meta_reading: { dragon_motif: '龙是资本与武器' },
    visual_beats: [{
      beat_id: 'b1', start_time: 815, end_time: 820,
      meaning: '沉默是观察而非退让', aesthetic_reading: '红线如伤口', thematic_mirrors: ['预言既救国也是负担'],
    }],
  }],
};

test('episodeForScene maps via episode_map', () => {
  assert.strictEqual(episodeForScene(kb, 's024'), 'S03E01');
});

test('chunkScenes emits reading chunks with schema fields', () => {
  const chunks = chunkScenes(kb);
  const beat = chunks.find(c => c.id.includes('b1'));
  assert.strictEqual(beat.knowledge_type, 'scene_reading');
  assert.strictEqual(beat.scene_id, 's024');
  assert.strictEqual(beat.available_from_episode, 'S03E01');
  assert.strictEqual(beat.available_from_time, 815);
  assert.deepStrictEqual(beat.character_ids, ['rhaenyra']);
  assert.strictEqual(beat.schema_version, 1);
  assert.ok(beat.content.includes('沉默'));
  assert.strictEqual(beat.content_hash, hashContent(beat.content));
  // tapestry reading uses the scene start_time
  const tap = chunks.find(c => c.id.includes('tapestry'));
  assert.strictEqual(tap.available_from_time, 812.4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/chunkers-scene.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/retrieval/chunkers.js`:

```js
const crypto = require('crypto');
const { epToNum } = require('./temporal-filter');

function hashContent(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex');
}

function sceneIdNum(sid) {
  const m = String(sid || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function episodeForScene(kb, sceneId) {
  const n = sceneIdNum(sceneId);
  for (const m of kb.episode_map || []) {
    const from = sceneIdNum(m.from_scene), to = sceneIdNum(m.to_scene);
    if (n != null && from != null && to != null && n >= from && n <= to) return m.episode || null;
  }
  return null;
}

function makeChunk({ kb, id, knowledge_type, content, retrieval_text, scene_id, episode, time, character_ids }) {
  return {
    id, knowledge_type, content,
    retrieval_text: retrieval_text || content,
    show_id: kb.show_id, video_id: kb.video_id,
    season: kb.season, episode, scene_id,
    start_time: null, end_time: null,
    available_from_episode: episode, available_from_time: time,
    character_ids: character_ids || [], location_ids: [], symbol_ids: [],
    source_type: 'scene_kb', canonicality: 'episode_verified',
    confidence: 0.9, spoiler_level: 0,
    embedding_model: null, schema_version: 1,
    content_hash: hashContent(content), embedding: null,
  };
}

function chunkScenes(kb) {
  const out = [];
  for (const scene of kb.scenes || []) {
    const episode = episodeForScene(kb, scene.scene_id);
    for (const beat of scene.visual_beats || []) {
      const parts = [beat.meaning, beat.aesthetic_reading, ...(beat.thematic_mirrors || [])].filter(Boolean);
      if (parts.length === 0) continue;
      const content = parts.join('\n');
      out.push(makeChunk({
        kb, id: `${kb.video_id}:scene:${scene.scene_id}:${beat.beat_id}:reading`,
        knowledge_type: 'scene_reading', content,
        retrieval_text: [content, ...(scene.characters || [])].join(' '),
        scene_id: scene.scene_id, episode,
        time: typeof beat.start_time === 'number' ? beat.start_time : scene.start_time,
        character_ids: scene.characters || [],
      }));
    }
    const tap = scene.tapestry_meta_reading;
    if (tap && typeof tap === 'object') {
      const content = Object.values(tap).filter(v => typeof v === 'string').join('\n');
      if (content) {
        out.push(makeChunk({
          kb, id: `${kb.video_id}:scene:${scene.scene_id}:tapestry:reading`,
          knowledge_type: 'scene_reading', content,
          scene_id: scene.scene_id, episode, time: scene.start_time,
          character_ids: scene.characters || [],
        }));
      }
    }
  }
  return out;
}

module.exports = { hashContent, episodeForScene, chunkScenes, makeChunk, sceneIdNum, epToNum };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/chunkers-scene.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/retrieval/chunkers.js server/test/chunkers-scene.test.js
git commit -m "feat(retrieval): scene_reading chunker"
```

---

### Task 8: Character chunker (state / relationship / motivation)

**Files:**
- Modify: `server/lib/retrieval/chunkers.js`
- Test: `server/test/chunkers-character.test.js`

**Interfaces:**
- Consumes: `makeChunk`, `hashContent` from `chunkers.js`.
- Produces: `chunkCharacters(charDb, {show_id, video_id, season}) -> object[]` — one chunk per `state_timeline[]`, per `motivations_timeline[]`, and per `relationships[].timeline[]` entry. `available_from_episode = entry.from`; `available_from_time = null` (episode-granular, so eligibility is episode-based). `source_type = 'character_kb'`.

- [ ] **Step 1: Write the failing test**

Create `server/test/chunkers-character.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { chunkCharacters } = require('../lib/retrieval/chunkers');

const charDb = {
  characters: [{
    character_id: 'alicent_hightower', display_name_zh: '阿莉森特·海塔尔',
    state_timeline: [{ from: 'S01E05', title_zh: '王后', safe_summary_zh: '以沉默表达不满' }],
    motivations_timeline: [{ from: 'S01E05', motivation_zh: '保住儿子的继承主张', evidence_zh: '御前会议' }],
  }],
  relationships: [{
    source: 'alicent_hightower', target: 'rhaenyra',
    timeline: [{ from: 'S01E05', relation_zh: '决裂的旧友', summary_zh: '继承权对立' }],
  }],
};
const meta = { show_id: 'house-of-the-dragon', video_id: 'v1', season: 1 };

test('emits state, motivation, relationship chunks with episode key', () => {
  const chunks = chunkCharacters(charDb, meta);
  const byType = t => chunks.filter(c => c.knowledge_type === t);
  assert.strictEqual(byType('character_state').length, 1);
  assert.strictEqual(byType('character_motivation').length, 1);
  assert.strictEqual(byType('character_relationship').length, 1);
  const state = byType('character_state')[0];
  assert.strictEqual(state.available_from_episode, 'S01E05');
  assert.strictEqual(state.available_from_time, null); // episode-granular
  assert.deepStrictEqual(state.character_ids, ['alicent_hightower']);
  assert.ok(state.content.includes('沉默'));
  const rel = byType('character_relationship')[0];
  assert.deepStrictEqual(rel.character_ids.sort(), ['alicent_hightower', 'rhaenyra']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/chunkers-character.test.js`
Expected: FAIL — `chunkCharacters is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `server/lib/retrieval/chunkers.js` (before `module.exports`):

```js
function charChunk({ meta, id, knowledge_type, content, episode, character_ids, confidence }) {
  return {
    id, knowledge_type, content, retrieval_text: content,
    show_id: meta.show_id, video_id: meta.video_id, season: meta.season,
    episode, scene_id: null, start_time: null, end_time: null,
    available_from_episode: episode, available_from_time: null,
    character_ids, location_ids: [], symbol_ids: [],
    source_type: 'character_kb', canonicality: 'episode_verified',
    confidence: confidence == null ? 0.85 : confidence, spoiler_level: 0,
    embedding_model: null, schema_version: 1,
    content_hash: hashContent(content), embedding: null,
  };
}

function chunkCharacters(charDb, meta) {
  const out = [];
  for (const ch of (charDb && charDb.characters) || []) {
    const cid = ch.character_id;
    for (const [i, st] of (ch.state_timeline || []).entries()) {
      const content = [st.title_zh, st.political_role_zh, st.safe_summary_zh].filter(Boolean).join(' / ');
      if (!content) continue;
      out.push(charChunk({ meta, id: `${meta.show_id}:char:${cid}:state:${i}`, knowledge_type: 'character_state', content, episode: st.from || 'S01E01', character_ids: [cid] }));
    }
    for (const [i, mo] of (ch.motivations_timeline || []).entries()) {
      const content = [mo.motivation_zh, mo.evidence_zh].filter(Boolean).join(' — ');
      if (!content) continue;
      out.push(charChunk({ meta, id: `${meta.show_id}:char:${cid}:motive:${i}`, knowledge_type: 'character_motivation', content, episode: mo.from || 'S01E01', character_ids: [cid] }));
    }
  }
  for (const [i, rel] of ((charDb && charDb.relationships) || []).entries()) {
    for (const [j, t] of (rel.timeline || []).entries()) {
      const content = [t.relation_zh || t.relation_en, t.summary_zh, t.evidence_zh].filter(Boolean).join(' — ');
      if (!content) continue;
      out.push(charChunk({ meta, id: `${meta.show_id}:rel:${i}:${j}`, knowledge_type: 'character_relationship', content, episode: t.from || 'S01E01', character_ids: [rel.source, rel.target].filter(Boolean) }));
    }
  }
  return out;
}
```

And add `chunkCharacters` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/chunkers-character.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/retrieval/chunkers.js server/test/chunkers-character.test.js
git commit -m "feat(retrieval): character state/relationship/motivation chunker"
```

---

### Task 9: Lore + recap chunkers

**Files:**
- Modify: `server/lib/retrieval/chunkers.js`
- Test: `server/test/chunkers-lore.test.js`

**Interfaces:**
- Consumes: `hashContent` from `chunkers.js`.
- Produces:
  - `chunkLore(knowledgeJson, meta) -> object[]` — `lore_card` from `knowledge_points[]`; `available_from_episode = 'S01E01'`, `available_from_time = null`, `source_type = 'wiki'`, `spoiler_level = 0`.
  - `chunkRecap(taggedPoints, meta) -> object[]` — `external_knowledge` from already-tagged recap points (each has `available_from_episode`); points **without** a tag are skipped. `source_type = 'recap'`, `available_from_time = null`.

- [ ] **Step 1: Write the failing test**

Create `server/test/chunkers-lore.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { chunkLore, chunkRecap } = require('../lib/retrieval/chunkers');

const meta = { show_id: 'house-of-the-dragon', video_id: null, season: 1 };

test('chunkLore emits timeless lore_card from S01E01', () => {
  const kj = { knowledge_points: [{ title: '月亮茶', summary: '避孕/堕胎药', safe_hint: '女性政治工具', related_characters: ['rhaenyra'], importance: 0.7 }] };
  const [c] = chunkLore(kj, meta);
  assert.strictEqual(c.knowledge_type, 'lore_card');
  assert.strictEqual(c.available_from_episode, 'S01E01');
  assert.strictEqual(c.available_from_time, null);
  assert.ok(c.content.includes('月亮茶'));
  assert.deepStrictEqual(c.character_ids, ['rhaenyra']);
});

test('chunkRecap keeps only tagged points', () => {
  const points = [
    { title: 'a', summary: '早期事件', available_from_episode: 'S01E03', related_characters: [] },
    { title: 'b', summary: '未标记', related_characters: [] }, // no tag → dropped
  ];
  const chunks = chunkRecap(points, meta);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0].knowledge_type, 'external_knowledge');
  assert.strictEqual(chunks[0].available_from_episode, 'S01E03');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/chunkers-lore.test.js`
Expected: FAIL — `chunkLore is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `server/lib/retrieval/chunkers.js` (before `module.exports`):

```js
function genericChunk({ meta, id, knowledge_type, content, episode, character_ids, source_type, confidence }) {
  return {
    id, knowledge_type, content, retrieval_text: content,
    show_id: meta.show_id, video_id: meta.video_id, season: meta.season,
    episode, scene_id: null, start_time: null, end_time: null,
    available_from_episode: episode, available_from_time: null,
    character_ids: character_ids || [], location_ids: [], symbol_ids: [],
    source_type, canonicality: source_type === 'wiki' ? 'lore' : 'recap',
    confidence: confidence == null ? 0.6 : confidence, spoiler_level: 0,
    embedding_model: null, schema_version: 1,
    content_hash: hashContent(content), embedding: null,
  };
}

function chunkLore(knowledgeJson, meta) {
  const out = [];
  for (const [i, kp] of ((knowledgeJson && knowledgeJson.knowledge_points) || []).entries()) {
    const content = [kp.title, kp.summary, kp.safe_hint || kp.expanded_explanation].filter(Boolean).join(' — ');
    if (!content) continue;
    out.push(genericChunk({
      meta, id: `${meta.show_id}:lore:${i}`, knowledge_type: 'lore_card', content,
      episode: 'S01E01', character_ids: kp.related_characters || [], source_type: 'wiki',
      confidence: typeof kp.confidence === 'number' ? kp.confidence : (kp.importance || 0.6),
    }));
  }
  return out;
}

function chunkRecap(taggedPoints, meta) {
  const out = [];
  for (const [i, p] of (taggedPoints || []).entries()) {
    if (!p.available_from_episode) continue; // untagged → excluded
    const content = [p.title, p.summary || p.point, p.safe_hint || p.agent_answer].filter(Boolean).join(' — ');
    if (!content) continue;
    out.push(genericChunk({
      meta, id: `${meta.show_id}:recap:${i}`, knowledge_type: 'external_knowledge', content,
      episode: p.available_from_episode, character_ids: p.related_characters || p.related_character || [], source_type: 'recap',
      confidence: typeof p.confidence === 'number' ? p.confidence : 0.55,
    }));
  }
  return out;
}
```

And add `chunkLore, chunkRecap` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/chunkers-lore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/retrieval/chunkers.js server/test/chunkers-lore.test.js
git commit -m "feat(retrieval): lore + recap chunkers (recap gated by episode tag)"
```

---

### Task 10: Orchestrator + backward-compatible shim

**Files:**
- Create: `server/lib/retrieval/index.js`
- Modify: `server/lib/retrieval.js` (replace body with a shim)
- Test: `server/test/orchestrator.test.js`

**Interfaces:**
- Consumes: `filterEligible`, `rankLexical`, `rankDense`, `embedQuery`, `rrf`, `rerank`, `buildContext`.
- Produces:
  - `async retrieve({query, characterNames, characterAliases, k, videoId, cursorTime, currentScene, characterIds, intent, cursor, _deps}) -> object[]` — returns final context chunks (shape from `buildContext`). When no embedding client is available OR the dense flag is off, uses lexical-only (today's behavior). `_deps` (optional) injects `{loadChunks, embedClient, embedCache}` for tests.
  - `clearCache()`.
- `server/lib/retrieval.js` re-exports `retrieve`, `clearCache` from `./retrieval/index.js` so `require('./lib/retrieval')` keeps working.

- [ ] **Step 1: Write the failing test**

Create `server/test/orchestrator.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { retrieve } = require('../lib/retrieval/index');

const chunks = [
  { id: 'here', knowledge_type: 'scene_reading', show_id: 's', video_id: 'v1', season: 1,
    available_from_episode: 'S01E01', available_from_time: 10, scene_id: 's024',
    character_ids: ['alicent'], content: '沉默是观察', retrieval_text: '沉默 观察 alicent', embedding: [1, 0] },
  { id: 'future', knowledge_type: 'scene_reading', show_id: 's', video_id: 'v1', season: 1,
    available_from_episode: 'S01E09', available_from_time: 0, scene_id: 's900',
    character_ids: [], content: '未来剧透', retrieval_text: '未来 剧透', embedding: [1, 0] },
];
const cursor = { show_id: 's', video_id: 'v1', season: 1, episode: 'S01E01', cursorTime: 900, allowedSpoilerLevel: 0 };

test('lexical-only path (no embed client) never returns future chunk', async () => {
  const out = await retrieve({
    query: '沉默', characterNames: ['alicent'], cursor,
    _deps: { loadChunks: () => chunks, embedClient: null },
  });
  const ids = out.map(c => c.id);
  assert.ok(ids.includes('here'));
  assert.ok(!ids.includes('future'));
});

test('hybrid path with fake embed client also excludes future chunk', async () => {
  const embedClient = { embeddings: { create: async () => ({ data: [{ embedding: [1, 0] }] }) } };
  const out = await retrieve({
    query: '沉默', characterNames: ['alicent'], cursor,
    _deps: { loadChunks: () => chunks, embedClient, embedCache: new Map() },
  });
  assert.ok(!out.map(c => c.id).includes('future'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/orchestrator.test.js`
Expected: FAIL — cannot find module `../lib/retrieval/index`.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/retrieval/index.js`:

```js
const path = require('path');
const fs = require('fs');
const { filterEligible } = require('./temporal-filter');
const { rankLexical } = require('./lexical');
const { rankDense, embedQuery } = require('./vector-store');
const { rrf } = require('./fusion');
const { rerank } = require('./rerank');
const { buildContext } = require('./context-builder');

let VECTOR_CACHE = null;
let QUERY_EMBED_CACHE = new Map();

function defaultLoadChunks(showId) {
  if (VECTOR_CACHE) return VECTOR_CACHE;
  const fp = path.join(__dirname, '..', '..', 'kb', 'retrieval', `${showId || 'house-of-the-dragon'}.vectors.json`);
  VECTOR_CACHE = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf8')) : [];
  return VECTOR_CACHE;
}

function defaultEmbedClient() {
  if (!process.env.OPENAI_API_KEY || process.env.RETRIEVAL_DENSE === 'off') return null;
  try { const OpenAI = require('openai'); return new OpenAI(); } catch { return null; }
}

async function retrieve(params = {}) {
  const {
    query = '', characterNames = [], characterAliases = [], k = 8,
    cursor = null, characterIds = [], intent = null, currentScene = null,
    _deps = {},
  } = params;

  const showId = cursor && cursor.show_id;
  const loadChunks = _deps.loadChunks || defaultLoadChunks;
  const embedClient = _deps.embedClient !== undefined ? _deps.embedClient : defaultEmbedClient();
  const embedCache = _deps.embedCache || QUERY_EMBED_CACHE;

  const all = loadChunks(showId);
  const eligible = filterEligible(all, cursor);
  if (eligible.length === 0) return [];

  const byId = new Map(eligible.map(c => [c.id, c]));
  const nameKeys = [...characterNames, ...characterAliases, ...characterIds];

  const lexRanked = rankLexical(eligible, { query, nameKeys }).slice(0, 40);

  let rankedIds;
  if (embedClient) {
    try {
      const qEmb = await embedQuery(query, { client: embedClient, cache: embedCache });
      const denseRanked = rankDense(eligible, qEmb).slice(0, 40);
      rankedIds = rrf([denseRanked, lexRanked]).map(r => r.id);
    } catch {
      rankedIds = lexRanked; // fallback
    }
  } else {
    rankedIds = lexRanked;
  }

  const cursorCtx = {
    sceneId: currentScene && currentScene.scene_id, characterIds,
    locationIds: (currentScene && currentScene.location_ids) || [],
    symbolIds: [], cursorTime: cursor && cursor.cursorTime, intent,
  };
  const reranked = rerank(rankedIds.map(id => byId.get(id)).filter(Boolean), cursorCtx);
  return buildContext(reranked, { total: k });
}

function clearCache() { VECTOR_CACHE = null; QUERY_EMBED_CACHE = new Map(); }

module.exports = { retrieve, clearCache };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/orchestrator.test.js`
Expected: PASS.

- [ ] **Step 5: Replace the shim and verify the public import**

Replace the entire body of `server/lib/retrieval.js` with:

```js
// Public entry — retrieval moved into ./retrieval/. Kept as a shim so
// require('./lib/retrieval') stays valid for existing callers.
module.exports = require('./retrieval/index.js');
```

Run: `cd server && node -e "const r=require('./lib/retrieval'); console.log(typeof r.retrieve, typeof r.clearCache)"`
Expected: `function function`.

- [ ] **Step 6: Run the full suite**

Run: `cd server && node --test`
Expected: PASS (all test files).

- [ ] **Step 7: Commit**

```bash
git add server/lib/retrieval/index.js server/lib/retrieval.js server/test/orchestrator.test.js
git commit -m "feat(retrieval): hybrid orchestrator + backward-compatible shim"
```

---

### Task 11: Recap episode-tagger (offline core + CLI)

**Files:**
- Create: `server/lib/retrieval/recap-tagger.js`
- Create: `server/scripts/tag_recap_knowledge.js`
- Test: `server/test/recap-tagger.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `async tagPoint(point, {sceneEpisodes, llmFn}) -> {available_from_episode}|null` — `sceneEpisodes` is a list of `{episode, keywords[]}`; `llmFn(prompt) -> "S0xE0y"|"UNKNOWN"`. Returns `null` (exclude) when the model says `UNKNOWN` or returns an unparseable episode.
  - `async tagAll(points, opts) -> object[]` — points annotated with `available_from_episode`, untaggable dropped.

- [ ] **Step 1: Write the failing test**

Create `server/test/recap-tagger.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { tagPoint, tagAll } = require('../lib/retrieval/recap-tagger');

const opts = {
  sceneEpisodes: [{ episode: 'S01E03', keywords: ['继承', '婚姻'] }],
  llmFn: async (prompt) => (prompt.includes('继承') ? 'S01E03' : 'UNKNOWN'),
};

test('tagPoint assigns episode from llm', async () => {
  const r = await tagPoint({ title: '继承危机', summary: '国王讨论继承' }, opts);
  assert.deepStrictEqual(r, { available_from_episode: 'S01E03' });
});

test('tagPoint returns null on UNKNOWN', async () => {
  const r = await tagPoint({ title: '无关', summary: '模糊内容' }, opts);
  assert.strictEqual(r, null);
});

test('tagAll drops untaggable points', async () => {
  const points = [{ title: '继承危机', summary: '继承' }, { title: '无关', summary: 'x' }];
  const out = await tagAll(points, opts);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].available_from_episode, 'S01E03');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/recap-tagger.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/retrieval/recap-tagger.js`:

```js
// Offline: assign each whole-season recap point an available_from_episode.
// Fail-closed — anything the model can't place confidently is dropped.

function parseEpisode(s) {
  const m = String(s || '').match(/S\d{2}E\d{2}/i);
  return m ? m[0].toUpperCase() : null;
}

function buildPrompt(point, sceneEpisodes) {
  const catalog = sceneEpisodes.map(s => `${s.episode}: ${s.keywords.join('、')}`).join('\n');
  return [
    '根据剧集关键词目录，判断下面这条解说知识最早在哪一集就已经可以安全知道。',
    '只回答形如 S01E03 的集数；如果无法确定，回答 UNKNOWN。',
    '目录:', catalog,
    '知识:', `${point.title || ''} ${point.summary || point.point || ''}`,
  ].join('\n');
}

async function tagPoint(point, { sceneEpisodes, llmFn }) {
  const ans = await llmFn(buildPrompt(point, sceneEpisodes));
  const ep = parseEpisode(ans);
  return ep ? { available_from_episode: ep } : null;
}

async function tagAll(points, opts) {
  const out = [];
  for (const p of points || []) {
    const tag = await tagPoint(p, opts);
    if (tag) out.push({ ...p, ...tag });
  }
  return out;
}

module.exports = { tagPoint, tagAll, parseEpisode, buildPrompt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/recap-tagger.test.js`
Expected: PASS.

- [ ] **Step 5: Write the CLI wrapper**

Create `server/scripts/tag_recap_knowledge.js`:

```js
#!/usr/bin/env node
// Usage: node scripts/tag_recap_knowledge.js <recap.knowledge.json> <showId> > tagged.json
const fs = require('fs');
const path = require('path');
const { tagAll } = require('../lib/retrieval/recap-tagger');

async function main() {
  const [srcPath, showId] = process.argv.slice(2);
  if (!srcPath || !showId) { console.error('args: <recap.knowledge.json> <showId>'); process.exit(1); }
  if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
  const OpenAI = require('openai');
  const client = new OpenAI();
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const kb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kb', `${showId}_scene_episodes.json`), 'utf8'));
  const sceneEpisodes = kb.scene_episodes || []; // [{episode, keywords[]}]
  const points = (JSON.parse(fs.readFileSync(srcPath, 'utf8')).knowledge_points) || [];

  const llmFn = async (prompt) => {
    const r = await client.chat.completions.create({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 });
    return r.choices[0].message.content || 'UNKNOWN';
  };
  const tagged = await tagAll(points, { sceneEpisodes, llmFn });
  process.stdout.write(JSON.stringify(tagged, null, 2));
  console.error(`tagged ${tagged.length}/${points.length}`);
}
main();
```

Note: `<showId>_scene_episodes.json` (a small `{scene_episodes:[{episode,keywords[]}]}` catalog) is authored once by hand or from the scene KB; document it in the script header.

- [ ] **Step 6: Commit**

```bash
git add server/lib/retrieval/recap-tagger.js server/scripts/tag_recap_knowledge.js server/test/recap-tagger.test.js
git commit -m "feat(retrieval): offline recap episode-tagger (fail-closed)"
```

---

### Task 12: Offline index builder (core + CLI)

**Files:**
- Create: `server/lib/retrieval/index-builder.js`
- Create: `server/scripts/build_retrieval_index.js`
- Test: `server/test/index-builder.test.js`

**Interfaces:**
- Consumes: `hashContent` from `chunkers.js`.
- Produces:
  - `syncIndex(existing, freshChunks) -> {merged, added, updated, deleted}` — diff by `id + content_hash`: new id → add; same id, changed hash → update (drop old embedding); same id+hash → keep existing embedding; id gone from fresh → delete.
  - `async embedMissing(chunks, {embedFn}) -> chunks` — fills `embedding` + `embedding_model` for chunks whose `embedding` is null; `embedFn(text) -> number[]` injectable.

- [ ] **Step 1: Write the failing test**

Create `server/test/index-builder.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { syncIndex, embedMissing } = require('../lib/retrieval/index-builder');

test('syncIndex adds/updates/keeps/deletes by id+hash', () => {
  const existing = [
    { id: 'keep', content_hash: 'h1', embedding: [1] },
    { id: 'change', content_hash: 'old', embedding: [2] },
    { id: 'gone', content_hash: 'h3', embedding: [3] },
  ];
  const fresh = [
    { id: 'keep', content_hash: 'h1', embedding: null },
    { id: 'change', content_hash: 'new', embedding: null },
    { id: 'add', content_hash: 'h4', embedding: null },
  ];
  const { merged, added, updated, deleted } = syncIndex(existing, fresh);
  assert.deepStrictEqual(added, ['add']);
  assert.deepStrictEqual(updated, ['change']);
  assert.deepStrictEqual(deleted, ['gone']);
  assert.deepStrictEqual(merged.find(c => c.id === 'keep').embedding, [1]); // preserved
  assert.strictEqual(merged.find(c => c.id === 'change').embedding, null); // dropped for re-embed
});

test('embedMissing only fills null embeddings', async () => {
  const chunks = [{ id: 'a', content: 'x', embedding: null }, { id: 'b', content: 'y', embedding: [9] }];
  const out = await embedMissing(chunks, { embedFn: async () => [1, 1] });
  assert.deepStrictEqual(out.find(c => c.id === 'a').embedding, [1, 1]);
  assert.strictEqual(out.find(c => c.id === 'a').embedding_model, 'text-embedding-3-small');
  assert.deepStrictEqual(out.find(c => c.id === 'b').embedding, [9]); // untouched
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/index-builder.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/retrieval/index-builder.js`:

```js
const { EMBEDDING_MODEL } = require('./vector-store');

function syncIndex(existing, freshChunks) {
  const existingById = new Map((existing || []).map(c => [c.id, c]));
  const freshIds = new Set(freshChunks.map(c => c.id));
  const added = [], updated = [], merged = [];

  for (const fresh of freshChunks) {
    const prev = existingById.get(fresh.id);
    if (!prev) { added.push(fresh.id); merged.push(fresh); continue; }
    if (prev.content_hash === fresh.content_hash) {
      merged.push({ ...fresh, embedding: prev.embedding, embedding_model: prev.embedding_model }); // reuse
    } else {
      updated.push(fresh.id);
      merged.push({ ...fresh, embedding: null }); // force re-embed
    }
  }
  const deleted = (existing || []).filter(c => !freshIds.has(c.id)).map(c => c.id);
  return { merged, added, updated, deleted };
}

async function embedMissing(chunks, { embedFn }) {
  for (const c of chunks) {
    if (c.embedding == null) {
      c.embedding = await embedFn(c.retrieval_text || c.content);
      c.embedding_model = EMBEDDING_MODEL;
    }
  }
  return chunks;
}

module.exports = { syncIndex, embedMissing };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/index-builder.test.js`
Expected: PASS.

- [ ] **Step 5: Write the CLI wrapper**

Create `server/scripts/build_retrieval_index.js`:

```js
#!/usr/bin/env node
// Usage: node scripts/build_retrieval_index.js <showId> [videoId ...]
// Full rebuild if no existing index; otherwise incremental sync by id+content_hash.
const fs = require('fs');
const path = require('path');
const { chunkScenes, chunkCharacters, chunkLore, chunkRecap } = require('../lib/retrieval/chunkers');
const { syncIndex, embedMissing } = require('../lib/retrieval/index-builder');
const { EMBEDDING_MODEL } = require('../lib/retrieval/vector-store');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function main() {
  const [showId, ...videoIds] = process.argv.slice(2);
  if (!showId) { console.error('args: <showId> [videoId ...]'); process.exit(1); }
  const SERVER = path.join(__dirname, '..');
  const fresh = [];

  for (const vid of videoIds) {
    const kb = readJson(path.join(SERVER, 'kb', `${vid}.json`));
    fresh.push(...chunkScenes(kb));
  }
  const charPath = path.join(SERVER, 'kb', 'characters', `${showId}.json`);
  if (fs.existsSync(charPath)) {
    fresh.push(...chunkCharacters(readJson(charPath), { show_id: showId, video_id: null, season: 1 }));
  }
  const refsDir = path.join(SERVER, 'references');
  for (const f of fs.readdirSync(refsDir)) {
    if (f.startsWith('wiki-') && f.endsWith('.knowledge.json')) {
      fresh.push(...chunkLore(readJson(path.join(refsDir, f)), { show_id: showId, video_id: null, season: 1 }));
    }
  }
  const taggedRecap = path.join(SERVER, 'kb', 'retrieval', `${showId}.recap-tagged.json`);
  if (fs.existsSync(taggedRecap)) {
    fresh.push(...chunkRecap(readJson(taggedRecap), { show_id: showId, video_id: null, season: 1 }));
  }

  const outDir = path.join(SERVER, 'kb', 'retrieval');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${showId}.vectors.json`);
  const existing = fs.existsSync(outPath) ? readJson(outPath) : [];

  const { merged, added, updated, deleted } = syncIndex(existing, fresh);

  const OpenAI = require('openai');
  const client = new OpenAI();
  const embedFn = async (text) => (await client.embeddings.create({ model: EMBEDDING_MODEL, input: text })).data[0].embedding;
  await embedMissing(merged, { embedFn });

  fs.writeFileSync(outPath, JSON.stringify(merged));
  console.error(`index: +${added.length} ~${updated.length} -${deleted.length}, total ${merged.length} → ${outPath}`);
}
main();
```

- [ ] **Step 6: Commit**

```bash
git add server/lib/retrieval/index-builder.js server/scripts/build_retrieval_index.js server/test/index-builder.test.js
git commit -m "feat(retrieval): offline index builder (full + incremental)"
```

---

### Task 13: Evaluation harness + seed questions

**Files:**
- Create: `server/lib/retrieval/eval.js`
- Create: `server/kb/retrieval/eval.json`
- Create: `server/scripts/eval_retrieval.js`
- Test: `server/test/eval.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `recallAtK(returnedIds, expectedIds, k) -> number`
  - `leakCount(returnedIds, mustNotIds) -> number`
  - `async evaluate(questions, retrieveFn) -> {recall, leaks, perQuestion}` — `retrieveFn(q) -> ids[]`; `leaks` is the total across all questions and is the hard gate.

- [ ] **Step 1: Write the failing test**

Create `server/test/eval.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { recallAtK, leakCount, evaluate } = require('../lib/retrieval/eval');

test('recallAtK counts hits within top k', () => {
  assert.strictEqual(recallAtK(['a', 'b', 'c'], ['a', 'z'], 2), 0.5);
});

test('leakCount counts forbidden ids returned', () => {
  assert.strictEqual(leakCount(['a', 'future'], ['future']), 1);
});

test('evaluate aggregates recall and hard leak gate', async () => {
  const questions = [
    { id: 'q1', expected_ids: ['a'], must_not_recall_ids: ['future'] },
    { id: 'q2', expected_ids: ['b'], must_not_recall_ids: [] },
  ];
  const retrieveFn = async (q) => (q.id === 'q1' ? ['a', 'future'] : ['b']);
  const r = await evaluate(questions, retrieveFn);
  assert.ok(Math.abs(r.recall - 1) < 1e-9);
  assert.strictEqual(r.leaks, 1); // q1 leaked → gate fails
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test test/eval.test.js`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/retrieval/eval.js`:

```js
function recallAtK(returnedIds, expectedIds, k = 8) {
  if (!expectedIds || expectedIds.length === 0) return 1;
  const top = new Set((returnedIds || []).slice(0, k));
  const hits = expectedIds.filter(id => top.has(id)).length;
  return hits / expectedIds.length;
}

function leakCount(returnedIds, mustNotIds) {
  const forbidden = new Set(mustNotIds || []);
  return (returnedIds || []).filter(id => forbidden.has(id)).length;
}

async function evaluate(questions, retrieveFn, k = 8) {
  let recallSum = 0, leaks = 0;
  const perQuestion = [];
  for (const q of questions) {
    const ids = await retrieveFn(q);
    const recall = recallAtK(ids, q.expected_ids, k);
    const leak = leakCount(ids, q.must_not_recall_ids);
    recallSum += recall; leaks += leak;
    perQuestion.push({ id: q.id, recall, leak });
  }
  return { recall: questions.length ? recallSum / questions.length : 1, leaks, perQuestion };
}

module.exports = { recallAtK, leakCount, evaluate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test test/eval.test.js`
Expected: PASS.

- [ ] **Step 5: Seed the eval file and CLI**

Create `server/kb/retrieval/eval.json` with a starter (fill `expected_ids` after the first index build by inspecting `<showId>.vectors.json`):

```json
{
  "showId": "house-of-the-dragon",
  "k": 8,
  "questions": [
    { "id": "q_silence", "videoId": "house_of_dragon_s03e01", "cursorTime": 900, "query": "她为什么不说话？", "expected_ids": [], "must_not_recall_ids": [] },
    { "id": "q_relation_now", "videoId": "house_of_dragon_s03e01", "cursorTime": 900, "query": "他和她现在是什么关系？", "expected_ids": [], "must_not_recall_ids": [] }
  ]
}
```

Create `server/scripts/eval_retrieval.js`:

```js
#!/usr/bin/env node
// Usage: node scripts/eval_retrieval.js
// Runs the current retrieve() over kb/retrieval/eval.json and prints recall + leak gate.
const fs = require('fs');
const path = require('path');
const { evaluate } = require('../lib/retrieval/eval');
const { retrieve } = require('../lib/retrieval');
const { cursorAtTime } = require('../lib/characters');

async function main() {
  const SERVER = path.join(__dirname, '..');
  const spec = JSON.parse(fs.readFileSync(path.join(SERVER, 'kb', 'retrieval', 'eval.json'), 'utf8'));
  const retrieveFn = async (q) => {
    const kb = JSON.parse(fs.readFileSync(path.join(SERVER, 'kb', `${q.videoId}.json`), 'utf8'));
    const cursor = {
      show_id: kb.show_id, video_id: q.videoId, season: kb.season,
      episode: cursorAtTime(kb, q.cursorTime), cursorTime: q.cursorTime, allowedSpoilerLevel: 0,
    };
    const out = await retrieve({ query: q.query, cursor });
    return out.map(c => c.id);
  };
  const r = await evaluate(spec.questions, retrieveFn, spec.k || 8);
  console.log(JSON.stringify({ recall: r.recall, leaks: r.leaks, perQuestion: r.perQuestion }, null, 2));
  if (r.leaks > 0) { console.error('LEAK GATE FAILED'); process.exit(2); }
}
main();
```

- [ ] **Step 6: Commit**

```bash
git add server/lib/retrieval/eval.js server/kb/retrieval/eval.json server/scripts/eval_retrieval.js server/test/eval.test.js
git commit -m "feat(retrieval): eval harness with hard leak gate + seed questions"
```

---

### Task 14: Wire the agent.js call site behind a flag

**Files:**
- Modify: `server/agent.js` (around line 1800; and where the retrieval result is used)
- Test: `server/test/agent-callsite.test.js`

**Interfaces:**
- Consumes: `retrieve` (now async) from `./lib/retrieval`, `cursorAtTime` from `./lib/characters`.
- Produces: no new exports; behavior change is that `retrieveKnowledge` is `await`ed and passed cursor/scene context. With `RETRIEVAL_DENSE=off` (or no `OPENAI_API_KEY`) the result set must be a subset of what the eligible lexical path returns (no future chunks, no throw).

- [ ] **Step 1: Write the failing test**

Create `server/test/agent-callsite.test.js` (guards the contract; exercises the retrieval entry the call site uses):

```js
const test = require('node:test');
const assert = require('node:assert');
const { retrieve } = require('../lib/retrieval');

test('retrieve is awaitable and returns an array with cursor context', async () => {
  const out = await retrieve({
    query: '继承', characterNames: [],
    cursor: { show_id: 'house-of-the-dragon', video_id: 'house_of_dragon_s03e01', season: 3, episode: 'S03E01', cursorTime: 900, allowedSpoilerLevel: 0 },
  });
  assert.ok(Array.isArray(out));
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd server && node --test test/agent-callsite.test.js`
Expected: PASS if the index file exists; if `kb/retrieval/house-of-the-dragon.vectors.json` is absent it returns `[]` (still an array — test passes). This test locks the async array contract before the call-site edit.

- [ ] **Step 3: Update the call site**

In `server/agent.js`, the block at [`agent.js:1800`](../../../server/agent.js) currently reads:

```js
const retrievedKnowledge = retrieveKnowledge({
  query: prepared.question || '',
  characterNames: charNames,
  characterAliases: charAliases,
  k: 8,
});
```

Replace with (note `await`, cursor + scene context):

```js
const retrievedKnowledge = await retrieveKnowledge({
  query: prepared.question || '',
  characterNames: charNames,
  characterAliases: charAliases,
  k: 8,
  cursor: {
    show_id: kb.show_id,
    video_id: kb.video_id,
    season: kb.season,
    episode: charactersLib.cursorAtTime(kb, cursorTime),
    cursorTime,
    allowedSpoilerLevel: 0,
  },
  currentScene: scene,
  characterIds: (scene && scene.characters) || [],
});
```

Confirm the enclosing function is `async` (the handler already `await`s AI calls) and that `kb`, `scene`, `cursorTime`, `charactersLib` are in scope at that point (they are used elsewhere in the same handler — verify by reading ±40 lines).

- [ ] **Step 4: Run the full suite + smoke the endpoint path**

Run: `cd server && node --test`
Expected: PASS.

Run: `cd server && node -e "require('./agent.js'); console.log('agent.js loads')"`
Expected: `agent.js loads` (no syntax/require errors).

- [ ] **Step 5: Commit**

```bash
git add server/agent.js server/test/agent-callsite.test.js
git commit -m "feat(retrieval): pass cursor/scene context into retrieval at call site"
```

---

## Post-implementation (manual, not a code task)

1. Author `server/kb/house-of-the-dragon_scene_episodes.json` (`{scene_episodes:[{episode,keywords[]}]}`) from the scene KB.
2. Run `node scripts/tag_recap_knowledge.js references/<recap>.knowledge.json house-of-the-dragon > kb/retrieval/house-of-the-dragon.recap-tagged.json`.
3. Run `node scripts/build_retrieval_index.js house-of-the-dragon house_of_dragon_s03e01` to produce the vector file.
4. Fill `expected_ids` / `must_not_recall_ids` in `eval.json` by inspecting the built index, then run `node scripts/eval_retrieval.js` and compare against the pre-change baseline (run once with `RETRIEVAL_DENSE=off`, once on).
5. Flip `RETRIEVAL_DENSE` on in the server env once the leak gate passes and recall improves.

## Self-Review

- **Spec coverage:** §4 chunk model → Tasks 7–9; §5 temporal filter → Task 1; §6 dense/sparse/RRF/rerank/context → Tasks 2–6, 10; §3(a) recap tagging → Task 11; §8 fallback/cache/flag → Task 10 (`defaultEmbedClient` honors `RETRIEVAL_DENSE`/missing key; query cache); §9 module layout + shim + incremental builder → Tasks 10, 12; §10 eval → Task 13; §11 rollout + call-site enrichment → Tasks 12–14 + Post-implementation. `scene_fact` correctly excluded.
- **Placeholder scan:** eval seed `expected_ids` are intentionally empty (data-dependent) and called out in Post-implementation step 4, not a code placeholder.
- **Type consistency:** `retrieve()` returns `buildContext` output (chunk objects with `.id`) consumed as `.map(c => c.id)` in eval/tests; `rankLexical`/`rankDense`/`rrf` all operate on id strings; `EMBEDDING_MODEL` reused from `vector-store.js` in `index-builder.js` and the build CLI; `hashContent` defined once in `chunkers.js` and reused.
