# Hybrid Temporal RAG — Retrieval Layer Redesign

**Date:** 2026-07-29
**Status:** Approved design, pending implementation plan
**Scope:** Server-side knowledge retrieval (`server/lib/retrieval.js` and its callers)

## 1. Problem

The current retrieval layer (`server/lib/retrieval.js`) has three concrete weaknesses,
ranked by impact:

1. **Structural gap.** It only indexes `server/references/` (wiki lore + a whole-season
   解说 recap). The project's richest and most spoiler-sensitive knowledge — scene
   readings (`visual_beats[].meaning` etc.), character state/relationship/motivation
   timelines — is **not retrievable**. It reaches the model only through direct field
   reads in `agent.js`. So cross-scene / "why" association is structurally impossible in
   the retrieval layer, no matter how good the ranking is.
2. **Latent spoiler leak.** `retrieveKnowledge()` is called at
   [`agent.js:1800`](../../../server/agent.js) with only `query` + character names — **no
   cursor time, no spoiler gate**. Its 解说 source is a full-season recap, so a query at an
   early playback time can surface later-episode knowledge. This violates the project's
   spoiler-safety invariant, which the scene-KB business path otherwise upholds.
3. **Weak semantic recall.** Bigram + character-name matching misses paraphrase
   ("她为什么不说话" vs. a KB reading written as "以沉默表达不满 / 克制 / 保持政治距离").

**Goal:** a Hybrid Temporal RAG — dense (vector) semantic recall + sparse (keyword)
exact recall + temporal/spoiler hard-filter + deterministic rerank — that unifies the
high-value KB into one retrievable, time-gated layer. **No Qdrant, no external vector DB,
in-process, with the current bigram scorer preserved as a fallback.**

## 2. Non-goals (YAGNI)

Explicitly out of scope for this iteration; all reachable later without rework thanks to
`schema_version` and the stable `retrieve()` interface:

- Qdrant / pgvector or any external vector database.
- Cross-encoder or LLM reranker.
- LLM query-rewriter for query expansion (template expansion only, see §7).
- Chunk types beyond §4's set: `scene_fact` (already reaches the model via the business
  path), `symbol_*`, `location`, `foreshadow_*`, `subtitle_window`, `storyline_node`,
  `season_event`.

## 3. Runtime & key decisions (locked)

- **Backend is a persistent Node server** (`node index.js`) with an existing Python
  sidecar (`face_service.py`) and the OpenAI SDK already wired. No serverless constraint.
- **Embeddings: OpenAI `text-embedding-3-small`.** Chunks embedded offline; query embedded
  at request time (one cheap API call, cached by hash). Cosine similarity computed
  in-process over a local vector file.
- **解说 gating: decision (a).** An offline LLM-assisted tagging pass assigns each 解说
  knowledge point an `available_from_episode`; points that cannot be confidently tagged are
  **excluded** from the index. This both enables gated inclusion and closes leak #2.

## 4. Chunk model & sources

One flat chunk record. `content` (shown to the LLM) is separate from `retrieval_text`
(embedded + keyword-indexed); `retrieval_text` may add names/aliases/house/location/theme
terms to aid recall, but must not be padded with raw JSON field names.

```jsonc
{
  "id": "house_of_dragon_s03e01:scene:s024:reading",
  "knowledge_type": "scene_reading",
  "content": "…final text handed to the model…",
  "retrieval_text": "…embedding + keyword text, alias-enriched…",
  "show_id": "house-of-the-dragon",
  "video_id": "house_of_dragon_s03e01",
  "season": 3,
  "episode": "S03E01",
  "scene_id": "s024",
  "start_time": 812.4,
  "end_time": 861.7,
  "available_from_episode": "S03E01",
  "available_from_time": 812.4,
  "character_ids": ["rhaenyra_targaryen"],
  "location_ids": ["dragonstone"],
  "symbol_ids": [],
  "source_type": "scene_kb",
  "canonicality": "episode_verified",
  "confidence": 0.92,
  "spoiler_level": 0,
  "embedding_model": "text-embedding-3-small",
  "schema_version": 1,
  "content_hash": "…",
  "embedding": [/* float[] */]
}
```

### Indexed types (v1) and their projections

| knowledge_type            | Source                                                                 | Temporal key |
|---------------------------|------------------------------------------------------------------------|--------------|
| `scene_reading`           | `kb/<video>.json` `visual_beats[].meaning/aesthetic_reading/thematic_mirrors`, `scenes[].tapestry_meta_reading` | scene `start_time`/`end_time` + episode |
| `character_state`         | char DB `state_timeline[]` (`safe_summary_zh`, `title_*`, `political_role_zh`) | entry `from` (`S01E0N`) |
| `character_relationship`  | char DB `relationships[].timeline[]` (`relation_zh`, `summary_zh`, `evidence_zh`) | entry `from` |
| `character_motivation`    | char DB `motivations_timeline[]` (`motivation_zh`, `evidence_zh`)       | entry `from` |
| `lore_card`               | `references/*.knowledge.json` wiki points                              | default `S01E01`, low `spoiler_level` |
| `external_knowledge`      | 解说 `*.knowledge.json` / `*.chunks.json` essence points               | **assigned by offline tagging pass**; untaggable → excluded |

`scene_fact` is intentionally omitted: current-scene facts already reach the model through
the `agent.js` business path.

`content_hash` (hash of `content` + relevant source fields) drives incremental re-embedding:
editing one scene reading re-embeds only that chunk.

## 5. Temporal / spoiler hard filter

Runs **before** any scoring, fail-closed. Reuses the existing `epToNum` +
`currentEntry`/`cursorAtTime` episode logic (`server/lib/characters.js`,
`server/lib/season.js`) so gating is consistent with the rest of the app.

Predicate for a chunk to be eligible at `(videoId, cursorTime → cursorEpisode)`:

```
chunk.show_id == cursor.show_id
AND chunk.season <= cursor.season
AND epToNum(chunk.available_from_episode) <= epToNum(cursor.episode)
AND ( epToNum(chunk.available_from_episode) < epToNum(cursor.episode)
      OR chunk.available_from_time <= cursorTime )
AND chunk.spoiler_level <= allowedSpoilerLevel
```

- Single-video queries additionally constrain `video_id == cursor.video_id`; worldview
  queries allow cross-video but only over unlocked chunks.
- Missing cursor → **baseline only** (mirrors `lookupCharacter`'s `no_cursor` fail-closed
  behavior): lore_card + baseline chunks, no time-sensitive readings.
- Any future-episode chunk reaching a candidate set is a hard failure, not a soft penalty.

## 6. Retrieval → fusion → rerank → context

1. Build the eligible candidate set via §5.
2. **Dense arm:** embed query (OpenAI, cached) → cosine over eligible set → top ~30.
3. **Sparse arm:** existing bigram/keyword scorer over the *same* eligible set → top ~30.
4. **RRF fusion** by rank (not raw-score sum — cosine and bigram scales differ).
5. **Deterministic rerank**, weighted signals:
   current-scene match > current-character match > current-location/symbol match >
   time distance > `confidence` > `knowledge_type`↔`intent` fit.
   (e.g. character "why" intent favors `character_motivation` → `character_relationship`
   → recent `scene_reading` → past readings → `lore_card`/`external_knowledge`.)
6. **context-builder** applies per-type quotas and dedups before assembling the bundle,
   e.g. readings ≤2, character ≤2, lore ≤1, external ≤2. Each retained chunk keeps
   `source_type` / `scene_id` / time / `confidence` so the prompt can label
   current-frame-fact vs. character-DB vs. external material.

## 7. Query expansion (template, no extra LLM call)

Before embedding, expand the raw question using **only currently-known** context (current
scene foreground characters, location, recent dialogue topic) into a short internal query
string. No future identities or season summaries may enter the expansion — expansion must
not become a spoiler vector. An LLM rewriter is explicitly deferred (§2).

## 8. Fallback, caching, config

- OpenAI embedding unavailable/errors → **fall back to pure lexical** (today's exact
  behavior). AI Q&A never hard-fails on retrieval.
- Query-embedding cache keyed by `embedding_model + hash(retrieval_text)`.
- Vector file loaded once into a module cache (like today's `CACHE`); `clearCache()` kept.
- Env flag to enable/disable the dense arm — allows A/B and shadow rollout without code
  changes.

## 9. Module layout & interface

```
server/lib/retrieval/
  index.js            orchestrator — new retrieve()
  vector-store.js     load local vectors, embed query (OpenAI), cosine
  lexical.js          today's bigram/keyword scorer, refactored in
  temporal-filter.js  cursor → eligibility predicate (reuses epToNum/currentEntry)
  rerank.js           deterministic rule reranker
  context-builder.js  knowledge-type dedup + quotas → final bundle
scripts/build_retrieval_index.js   offline: KB → chunks → embeddings → local vector file
scripts/tag_recap_knowledge.js     offline: LLM-assisted 解说 episode tagging (§3a)
scripts/eval_retrieval.js          §10 harness
```

`retrieve()` extends from `{query, characterNames, characterAliases, k}` to also accept
`{videoId, cursorTime, currentScene, characterIds, intent}` — **all optional, backward
compatible**. The [`agent.js:1800`](../../../server/agent.js) call site keeps working
unchanged; a follow-up step enriches it to pass cursor context. Director-note agent, visual
Q&A, and character roleplay do not need simultaneous changes.

The offline index builder supports **full rebuild** and **incremental sync** (add/update
changed chunks by `id + content_hash`, delete chunks whose source no longer exists).

## 10. Evaluation

`server/kb/retrieval/eval.json` — 30–40 real questions, each
`{videoId, cursorTime, expected_ids[], must_not_recall_ids[]}`, covering plot fact,
motivation, relationship, location, symbol, and "what did I just miss" — with `cursorTime`
bound for any "now / just now" question.

`scripts/eval_retrieval.js` reports, old vs. new retrieval:

- **recall@k** (and MRR if cheap),
- **future-knowledge leak count** — a hard gate: any `must_not_recall_id` surfaced = fail,
  independent of answer fluency,
- current-character hit rate, fact-source hit rate, P95 retrieval latency.

Optional **shadow retrieval**: online answers keep using the old path while the new path's
candidates are logged for offline comparison before switch-over.

## 11. Rollout order

1. Chunk projection + offline index builder + 解说 tagging pass (closes leak #2 as a
   side effect once `retrieveKnowledge` gains the §5 filter).
2. Dense arm + RRF fusion + deterministic rerank behind the env flag.
3. Enrich the `agent.js` call site to pass cursor/scene/character context.
4. Eval harness; compare; then flip the flag on.
