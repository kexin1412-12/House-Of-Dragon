// 知识检索层 —— 统一索引 references/ 下的 wiki + 解说库 +chunks，按相关性返回 top-k。
//
// 索引来源：
//   - references/wiki-*.knowledge.json         （从 wiki 抓的世界观）
//   - references/*.knowledge.json              （解说库的归纳后知识点）
//   - references/*.chunks.json                 （解说库的时序片段，含 essence_points）
//
// 输入：当前场景里出现的角色 + 用户问题
// 输出：相关性排序后的 top-k 知识条目 → 喂给 LLM 的 context
//
// 不做的事：
//   - 不做向量检索（成本/复杂度不值，BM25-ish 关键词打分够用）
//   - 不做 chunks 时间对齐（解说视频的 SRT 时间 != 用户播放时间）

const fs = require('fs');
const path = require('path');

let CACHE = null;

function loadKnowledgeBase() {
  if (CACHE) return CACHE;
  const dir = path.join(__dirname, '..', 'references');
  const all = [];
  if (!fs.existsSync(dir)) { CACHE = []; return CACHE; }

  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (f.endsWith('.knowledge.json')) {
      try {
        const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
        for (const kp of (j.knowledge_points || [])) {
          all.push({
            source: f,
            title: kp.title || '',
            type: kp.type || 'lore',
            summary: kp.summary || '',
            hint: kp.safe_hint || kp.expanded_explanation || '',
            characters: kp.related_characters || [],
            symbols: kp.related_symbols || [],
            importance: typeof kp.importance === 'number' ? kp.importance : 0.5,
          });
        }
      } catch (e) { /* skip bad file */ }
    } else if (f.endsWith('.chunks.json')) {
      try {
        const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
        const chunks = Array.isArray(j) ? j : Object.values(j);
        for (const c of chunks) {
          for (const p of (c.essence_points || [])) {
            all.push({
              source: f,
              title: p.title || '',
              type: p.type || 'lore',
              summary: p.point || p.viewer_value || p.usable_sidebar_hint || '',
              hint: p.agent_answer || '',
              characters: p.related_character || [],
              symbols: p.related_symbol || [],
              importance: typeof p.confidence === 'number' ? p.confidence : 0.5,
            });
          }
        }
      } catch (e) { /* skip */ }
    }
  }
  CACHE = all;
  return all;
}

// 中文分词：简易 bigram 子串提取（够用，不依赖分词库）
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

/**
 * 检索 top-k 相关知识。
 * @param {object} params
 * @param {string} params.query 用户问题原文
 * @param {string[]} params.characterNames 当前画面/场景里出现的角色中文名（display_name_zh）
 * @param {string[]} params.characterAliases 别名（短身份/家族名等，可选）
 * @param {number} params.k top-k，默认 8
 * @returns {Array<{title,summary,hint,characters,_score}>}
 */
function retrieve({ query = '', characterNames = [], characterAliases = [], k = 8 }) {
  const kb = loadKnowledgeBase();
  if (kb.length === 0) return [];

  const qBigrams = bigrams(query);
  const nameKeys = [...characterNames, ...characterAliases].map(normalizeName).filter(Boolean);

  const scored = kb.map(kp => {
    const blob = (kp.title + ' ' + kp.summary + ' ' + kp.hint).toLowerCase();
    const blobNorm = blob.replace(/[\s·\-]+/g, '');
    const kpCharNorms = (kp.characters || []).map(normalizeName);

    let score = 0;

    // (1) 角色匹配 —— 强信号。画面里出现的角色 vs 知识点的 related_characters / blob
    for (const nk of nameKeys) {
      if (!nk) continue;
      const inRelated = kpCharNorms.some(c => c.includes(nk) || nk.includes(c));
      if (inRelated) score += 5;
      else if (blobNorm.includes(nk)) score += 2;
    }

    // (2) 问题 bigram 匹配 —— 弱信号
    if (qBigrams.length) {
      let hits = 0;
      for (const bg of qBigrams) {
        if (blob.includes(bg)) hits++;
      }
      score += Math.min(hits * 0.3, 3); // 封顶，避免大段文本霸榜
    }

    // (3) importance 微调
    score += (kp.importance || 0.5) * 0.5;

    return { kp, score };
  });

  return scored
    .filter(s => s.score >= 1.5)   // 阈值：至少要命中一个角色或几个 bigram
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(s => ({
      title: s.kp.title,
      summary: s.kp.summary,
      hint: s.kp.hint || undefined,
      characters: s.kp.characters,
      type: s.kp.type,
      _score: Math.round(s.score * 10) / 10,
      _source: s.kp.source.replace(/\.(knowledge|chunks)\.json$/, ''),
    }));
}

function clearCache() { CACHE = null; }

module.exports = { loadKnowledgeBase, retrieve, clearCache };
