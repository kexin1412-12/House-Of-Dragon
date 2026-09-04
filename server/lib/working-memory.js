// Working Memory — 服务端会话级记忆，让多轮对话复用已验证的证据。
// key = sessionId（前端生成的 UUID），value = 该会话积累的证据/人物/事件。
// TTL 10 分钟自动淘汰，防内存泄漏。

const SESSIONS = new Map();
const TTL_MS = 10 * 60 * 1000;
const MAX_EVIDENCE = 40;
const MAX_CHARACTERS = 30;
const MAX_EVENTS = 30;
const MAX_ENTITIES = 50;

function _now() { return Date.now(); }

function _prune() {
  const cutoff = _now() - TTL_MS;
  for (const [id, mem] of SESSIONS) {
    if (mem.lastActiveAt < cutoff) SESSIONS.delete(id);
  }
}

function getOrCreate(sessionId, videoId) {
  if (!sessionId) return _blank(videoId);
  _prune();
  if (SESSIONS.has(sessionId)) {
    const mem = SESSIONS.get(sessionId);
    mem.lastActiveAt = _now();
    if (videoId && mem.videoId !== videoId) {
      // 切换了视频 → 清空记忆
      const fresh = _blank(videoId);
      fresh.lastActiveAt = _now();
      SESSIONS.set(sessionId, fresh);
      return fresh;
    }
    return mem;
  }
  const mem = _blank(videoId);
  mem.lastActiveAt = _now();
  SESSIONS.set(sessionId, mem);
  return mem;
}

function _blank(videoId) {
  return {
    videoId: videoId || null,
    lastActiveAt: _now(),
    verified_evidence: [],
    identified_characters: [],
    resolved_events: [],
    conversation_entities: [],
  };
}

function memorize(sessionId, patch) {
  if (!sessionId) return;
  const mem = SESSIONS.get(sessionId);
  if (!mem) return;
  mem.lastActiveAt = _now();

  if (Array.isArray(patch.evidence)) {
    const existing = new Set(mem.verified_evidence.map(e => e.id));
    for (const e of patch.evidence) {
      if (e.id && !existing.has(e.id)) {
        mem.verified_evidence.push(e);
        existing.add(e.id);
      }
    }
    if (mem.verified_evidence.length > MAX_EVIDENCE) {
      mem.verified_evidence = mem.verified_evidence.slice(-MAX_EVIDENCE);
    }
  }

  if (Array.isArray(patch.characters)) {
    const s = new Set(mem.identified_characters);
    for (const c of patch.characters) { if (c) s.add(c); }
    mem.identified_characters = [...s].slice(-MAX_CHARACTERS);
  }

  if (Array.isArray(patch.events)) {
    const s = new Set(mem.resolved_events);
    for (const e of patch.events) { if (e) s.add(e); }
    mem.resolved_events = [...s].slice(-MAX_EVENTS);
  }

  if (Array.isArray(patch.entities)) {
    const s = new Set(mem.conversation_entities);
    for (const e of patch.entities) { if (e) s.add(e); }
    mem.conversation_entities = [...s].slice(-MAX_ENTITIES);
  }
}

function getVerifiedIds(sessionId) {
  if (!sessionId || !SESSIONS.has(sessionId)) return new Set();
  return new Set(SESSIONS.get(sessionId).verified_evidence.map(e => e.id));
}

function getSummary(sessionId) {
  if (!sessionId || !SESSIONS.has(sessionId)) return null;
  const mem = SESSIONS.get(sessionId);
  return {
    evidence_count: mem.verified_evidence.length,
    characters: mem.identified_characters,
    events: mem.resolved_events,
    entities: mem.conversation_entities,
    evidence_summaries: mem.verified_evidence.map(e => e.summary).filter(Boolean),
  };
}

function clear(sessionId) {
  SESSIONS.delete(sessionId);
}

module.exports = { getOrCreate, memorize, getVerifiedIds, getSummary, clear };
