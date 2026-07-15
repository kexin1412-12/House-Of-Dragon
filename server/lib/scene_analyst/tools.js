/**
 * Scene-analyst agent 的工具集合。
 *
 * 一个 ToolBox 实例对应一次「整集 KB + 字幕 + 符号词典 + 角色 DB」的会话——
 * 加载一次，多个 scene 复用。内部不缓存随 scene 变化的数据。
 *
 * 工具协议（每个 exec 都返回 { ok, data | error }，序列化成 JSON 喂给 LLM）：
 *   1. search_kb_scenes(query, limit?, episode?)
 *   2. get_scenes_in_range(start_id, end_id, limit?)
 *   3. get_character_profile(character_id)
 *   4. lookup_motif(name_or_id)
 *   5. get_subtitles(start_time, end_time)
 *   6. finalize_analysis(reading)   —— 终止信号；ToolBox 不实际"做事"，只校验 schema
 */

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', '..');

// ─── SRT 解析（与 enrich_scenes_gemini.js 复用） ───────────────────
function srtTimeToSec(t) {
  const [hms, msPart] = t.split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + (Number(msPart || 0) / 1000);
}
function parseSrt(text) {
  return text.split(/\r?\n\r?\n/).map(block => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) return null;
    const [s, e] = timeLine.split('-->').map(t => srtTimeToSec(t.trim()));
    const body = lines.slice(lines.indexOf(timeLine) + 1).join(' ').trim();
    return body ? { start: s, end: e, text: body } : null;
  }).filter(Boolean);
}

// scene_id → 数字（"s013" → 13），用于排序/区间比较
function sceneIdNum(sid) {
  const m = String(sid || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

class ToolBox {
  constructor({ kb, charDb, symbolDict, subs, episodeCursor }) {
    this.kb = kb;
    this.charDb = charDb;
    this.symbolDict = symbolDict;
    this.subs = subs || [];
    this.episodeCursor = episodeCursor || null;
    // 索引：scene_id → scene 引用
    this._sceneById = new Map();
    for (const s of (kb.scenes || [])) this._sceneById.set(s.scene_id, s);
  }

  static fromVideo({ videoId, episodeCursor = 'S01E05' }) {
    const kbPath = path.join(SERVER_DIR, 'kb', `${videoId}.json`);
    const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));

    const showId = kb.show_id || 'house-of-the-dragon';
    const charDbPath = path.join(SERVER_DIR, 'kb', 'characters', `${showId}.json`);
    const charDb = fs.existsSync(charDbPath) ? JSON.parse(fs.readFileSync(charDbPath, 'utf8')) : null;

    const symPath = path.join(SERVER_DIR, 'kb', 'symbols', `${showId}.json`);
    const symbolDict = fs.existsSync(symPath) ? JSON.parse(fs.readFileSync(symPath, 'utf8')) : { symbols: [] };

    const srtPath = path.join(SERVER_DIR, 'uploads', `${videoId}.srt`);
    const subs = fs.existsSync(srtPath) ? parseSrt(fs.readFileSync(srtPath, 'utf8')) : [];

    return { box: new ToolBox({ kb, charDb, symbolDict, subs, episodeCursor }), kbPath };
  }

  // 工具的 OpenAI tools 描述（schema 喂给 LLM）
  describeTools() {
    return [
      {
        name: 'search_kb_scenes',
        description:
          '语义/关键词搜索整集已标注的 scene。用于"前面有没有出现过 X"、"还有哪些 scene 涉及 Y"。' +
          '匹配 plot.fact / plot.reading / tags / dialogue_summary。返回 scene_id + 简介。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '查询关键词，可中英文，可多关键词空格分隔' },
            limit: { type: 'integer', minimum: 1, maximum: 15, default: 5 },
            time_lt: { type: 'number', description: '只返回 start_time < 此值 的 scene（秒）；用来取"之前"' },
            time_gt: { type: 'number', description: '只返回 start_time > 此值 的 scene（秒）；用来取"之后"' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_scenes_in_range',
        description:
          '按 scene_id 顺序拿一段连续 scene 的事实。用于查"前情"或"后续"。返回每个 scene 的 plot.fact + characters。',
        parameters: {
          type: 'object',
          properties: {
            start_id: { type: 'string', description: '区间起始 scene_id（含），如 s013' },
            end_id: { type: 'string', description: '区间结束 scene_id（含），如 s020' },
            limit: { type: 'integer', minimum: 1, maximum: 30, default: 20 },
          },
          required: ['start_id', 'end_id'],
        },
      },
      {
        name: 'get_character_profile',
        description:
          '查某个角色当前 cursor 下的安全卡片：身份、政治位置、与谁有关系。剧透安全（不会暴露 cursor 之后的信息）。',
        parameters: {
          type: 'object',
          properties: {
            character_id: { type: 'string', description: '如 rhaenyra_targaryen / criston_cole' },
          },
          required: ['character_id'],
        },
      },
      {
        name: 'lookup_motif',
        description:
          '查一个剧中母题/符号：含义 + 已经在哪些 scene 出现过。可以传 symbol_id（moon_tea / weirwood / hightower_green）或中文关键词。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '符号 id 或视觉描述关键词（如 "鱼梁木" / "moon_tea"）' },
          },
          required: ['name'],
        },
      },
      {
        name: 'get_subtitles',
        description:
          '拿某段时间的字幕（用于"前后几秒/几分钟在说什么"，超出当前 scene 范围）。',
        parameters: {
          type: 'object',
          properties: {
            start_time: { type: 'number', description: '起始秒数' },
            end_time: { type: 'number', description: '结束秒数' },
          },
          required: ['start_time', 'end_time'],
        },
      },
      {
        name: 'finalize_analysis',
        description:
          '输出最终解读，结束 agent 循环。所有字段都允许 null（除 narrative_function 外），但**至少**要写出 narrative_function 和 thematic_link。' +
          'foreshadowing.target_scene_id 必须严格大于当前 scene；callback.source_scene_id 必须严格小于当前 scene。违反时间方向应直接置 null。',
        parameters: {
          type: 'object',
          properties: {
            narrative_function: {
              type: 'string',
              description: '40-80 字。这个 scene 在剧情结构上的作用——建立 / 转折 / 铺垫 / 回响 / 释放。',
            },
            thematic_link: {
              type: 'object',
              properties: {
                theme_label: { type: 'string', description: '2-6 字主题标签，如 "破誓"、"绿党萌芽"' },
                how: { type: 'string', description: '30-50 字。这个 scene 如何与该主题关联。' },
              },
              required: ['theme_label', 'how'],
            },
            symbolism: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
              description: '0-150 字。如果是象征性镜头/空镜，分析符号学含义。普通对话场景填 null。',
            },
            foreshadowing: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    target_scene_id: { type: 'string' },
                    text: { type: 'string', description: '50-80 字。具体预示了哪个 scene 的什么事件。' },
                  },
                  required: ['target_scene_id', 'text'],
                },
                { type: 'null' },
              ],
            },
            callback: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    source_scene_id: { type: 'string' },
                    text: { type: 'string', description: '50-80 字。回应了之前哪个 scene 的什么。' },
                  },
                  required: ['source_scene_id', 'text'],
                },
                { type: 'null' },
              ],
            },
            character_subtext: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
              description: '0-100 字。人物未说出口的动机。空镜场景填 null。',
            },
            evidence_used: {
              type: 'array',
              items: { type: 'string' },
              description: '列出你在解读中实际依赖的工具调用（如 "lookup_motif(weirwood)"）。',
            },
          },
          required: ['narrative_function', 'thematic_link', 'evidence_used'],
        },
      },
    ];
  }

  // 工具入口：name + arguments(object) → { ok, data | error }
  async exec(name, args) {
    try {
      switch (name) {
        case 'search_kb_scenes':   return this._searchKbScenes(args);
        case 'get_scenes_in_range': return this._getScenesInRange(args);
        case 'get_character_profile': return this._getCharacterProfile(args);
        case 'lookup_motif':       return this._lookupMotif(args);
        case 'get_subtitles':      return this._getSubtitles(args);
        case 'finalize_analysis':  return this._validateFinalize(args);
        default:
          return { ok: false, error: `Unknown tool: ${name}. Available: search_kb_scenes, get_scenes_in_range, get_character_profile, lookup_motif, get_subtitles, finalize_analysis` };
      }
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  // ── 工具实现 ─────────────────────────────────────────────

  _searchKbScenes({ query, limit = 5, time_lt, time_gt }) {
    if (!query || typeof query !== 'string') return { ok: false, error: 'query is required' };
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { ok: false, error: 'query is empty' };

    const scored = [];
    for (const s of (this.kb.scenes || [])) {
      if (typeof time_lt === 'number' && s.start_time >= time_lt) continue;
      if (typeof time_gt === 'number' && s.start_time <= time_gt) continue;

      const fields = [
        s.plot?.fact || '',
        s.plot?.reading || '',
        s.plot?.deep_reading || '',
        s.plot?.dialogue_summary || '',
        (s.tags || []).join(' '),
        (s.symbols || []).map(sy => sy.symbol_id + ' ' + (sy.evidence_in_frame || '')).join(' '),
      ];
      const hay = fields.join(' ').toLowerCase();
      let score = 0;
      for (const t of tokens) {
        // tag/symbol 命中加权
        if ((s.tags || []).some(tg => tg.toLowerCase().includes(t))) score += 3;
        if ((s.symbols || []).some(sy => sy.symbol_id.toLowerCase().includes(t))) score += 4;
        if (hay.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ score, s });
    }
    scored.sort((a, b) => b.score - a.score || a.s.start_time - b.s.start_time);
    const top = scored.slice(0, Math.min(limit, 15));
    return {
      ok: true,
      data: {
        total_matched: scored.length,
        results: top.map(({ score, s }) => ({
          scene_id: s.scene_id,
          time: [s.start_time, s.end_time],
          score,
          fact: s.plot?.fact || null,
          tags: s.tags || [],
          characters: (s.characters || []).map(c => c.id),
        })),
      },
    };
  }

  _getScenesInRange({ start_id, end_id, limit = 20 }) {
    const a = sceneIdNum(start_id), b = sceneIdNum(end_id);
    if (a == null || b == null) return { ok: false, error: 'start_id / end_id must be like "s013"' };
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const out = [];
    for (const s of (this.kb.scenes || [])) {
      const n = sceneIdNum(s.scene_id);
      if (n == null) continue;
      if (n < lo || n > hi) continue;
      out.push({
        scene_id: s.scene_id,
        time: [s.start_time, s.end_time],
        fact: s.plot?.fact || null,
        tags: s.tags || [],
        characters: (s.characters || []).map(c => c.id),
      });
      if (out.length >= limit) break;
    }
    return { ok: true, data: { count: out.length, scenes: out } };
  }

  _getCharacterProfile({ character_id }) {
    if (!this.charDb) return { ok: false, error: 'character DB not loaded' };
    if (!character_id) return { ok: false, error: 'character_id required' };
    const cursor = this.episodeCursor;

    const c = (this.charDb.characters || []).find(x => x.character_id === character_id);
    if (!c) {
      // 兜底：按 display_name_zh 模糊匹配
      const lower = character_id.toLowerCase();
      const fuzzy = (this.charDb.characters || []).find(x =>
        (x.display_name_zh || '').toLowerCase().includes(lower) ||
        (x.canonical_name || '').toLowerCase().includes(lower) ||
        (x.aliases || []).some(alias => String(alias).toLowerCase().includes(lower))
      );
      if (!fuzzy) return { ok: false, error: `character not found: ${character_id}. Try canonical id (e.g. rhaenyra_targaryen).` };
      return this._getCharacterProfile({ character_id: fuzzy.character_id });
    }

    const tl = c.state_timeline || [];
    const active = tl.filter(s =>
      (!s.from || s.from <= cursor) && (s.to == null || cursor <= s.to)
    ).pop() || null;

    // cursor 之前的关系（双向）
    const rels = [];
    for (const r of (this.charDb.relationships || [])) {
      if (r.source !== character_id && r.target !== character_id) continue;
      const otherId = r.source === character_id ? r.target : r.source;
      const activeR = (r.timeline || []).filter(t =>
        (!t.from || t.from <= cursor) && (t.to == null || cursor <= t.to)
      ).pop();
      if (!activeR) continue;
      rels.push({
        with: otherId,
        relation: activeR.relation_zh || activeR.relation_en,
        summary: activeR.summary_zh || null,
      });
    }

    return {
      ok: true,
      data: {
        character_id: c.character_id,
        name: c.display_name_zh || c.canonical_name,
        house: c.house || null,
        identity: c.short_identity_zh || null,
        title: active?.title_zh || null,
        political_role: active?.political_role_zh || null,
        summary: active?.safe_summary_zh || null,
        alive: active?.alive !== false,
        relationships: rels,
        cursor,
      },
    };
  }

  _lookupMotif({ name }) {
    if (!name) return { ok: false, error: 'name required' };
    const lower = name.toLowerCase();
    // 先精确 id 命中，再模糊 visual_cue / meaning_zh
    const exact = (this.symbolDict.symbols || []).find(s =>
      (s.symbol_id || '').toLowerCase() === lower
    );
    let found = exact ? [exact] : (this.symbolDict.symbols || []).filter(s =>
      (s.symbol_id || '').toLowerCase().includes(lower) ||
      (s.visual_cue || '').toLowerCase().includes(lower) ||
      (s.meaning_zh || '').includes(name)
    );
    if (found.length === 0) {
      return {
        ok: true,
        data: {
          matched: 0,
          available_symbol_ids: (this.symbolDict.symbols || []).map(s => s.symbol_id),
        },
      };
    }
    // 对每个命中的 symbol，找已经标注过它的 scene
    const out = found.slice(0, 3).map(sym => {
      const occurrences = [];
      for (const s of (this.kb.scenes || [])) {
        const hit = (s.symbols || []).find(sy => sy.symbol_id === sym.symbol_id);
        if (hit) {
          occurrences.push({
            scene_id: s.scene_id,
            time: [s.start_time, s.end_time],
            evidence: hit.evidence_in_frame,
            confidence: hit.confidence,
          });
        }
      }
      return {
        symbol_id: sym.symbol_id,
        category: sym.category,
        visual_cue: sym.visual_cue,
        meaning: sym.meaning_zh,
        viewer_takeaway: sym.viewer_takeaway,
        earliest_appearance: sym.earliest_appearance,
        occurrences,
      };
    });
    return { ok: true, data: { matched: found.length, symbols: out } };
  }

  _getSubtitles({ start_time, end_time }) {
    if (typeof start_time !== 'number' || typeof end_time !== 'number') {
      return { ok: false, error: 'start_time and end_time must be numbers (seconds)' };
    }
    if (this.subs.length === 0) return { ok: true, data: { lines: [], note: 'no SRT loaded' } };
    if (end_time - start_time > 600) {
      return { ok: false, error: 'window too large (>600s); query in smaller chunks' };
    }
    const lines = this.subs
      .filter(s => s.start < end_time && s.end > start_time)
      .map(s => ({ t: +s.start.toFixed(1), text: s.text }));
    return { ok: true, data: { lines: lines.slice(0, 60), truncated: lines.length > 60 } };
  }

  // finalize 工具不"做事"，只校验 schema + 时间方向
  _validateFinalize(args) {
    const errs = [];
    if (!args || typeof args !== 'object') errs.push('payload must be object');
    if (!args?.narrative_function || args.narrative_function.length < 10) errs.push('narrative_function too short or missing');
    if (!args?.thematic_link?.theme_label || !args?.thematic_link?.how) errs.push('thematic_link.{theme_label, how} required');
    if (!Array.isArray(args?.evidence_used)) errs.push('evidence_used must be array of tool-call descriptions');
    if (errs.length) return { ok: false, error: errs.join('; ') };
    // 时间方向校验交给 agent loop（它知道当前 scene 的 id），这里只做基础形状校验
    return { ok: true, data: { received: true } };
  }
}

module.exports = { ToolBox, parseSrt, sceneIdNum };
