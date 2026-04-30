#!/usr/bin/env node
/**
 * character_graph_agent.js
 *
 * 输入：已升级的 scene KB（plot.deep_reading + foreshadow + narrative）+ 角色字典 + 集梗概
 * 输出：kb/characters/_suggestions/<video>.relationship_events.json
 *
 * 这是 user 提的"人物图谱 Agent"的离线引擎：
 *   1) 注入剧集级 system prompt（剧名 + 集梗概 + 角色表 + relation_kind 枚举 + 前情滑动窗口）
 *   2) 喂 episode 内所有"高价值 scene"（有 plot.deep_reading 或 narrative 的）
 *   3) 让 LLM 按受控 schema 抽取 state_events / motivation_events / relationship_events
 *   4) dry-run 默认输出到 _suggestions/，再由 apply_relationship_events.js 审查合并
 *
 * 用法：
 *   node scripts/character_graph_agent.js \
 *     --kb kb/house_of_dragon_05.json \
 *     --episode S01E05 \
 *     --synopsis "..."  \
 *    [--out kb/characters/_suggestions/house_of_dragon_05.relationship_events.json] \
 *    [--prev-events kb/characters/_suggestions/house_of_dragon_04.relationship_events.json] \
 *    [--dry-run]    # 只 print prompt / 不调 LLM（默认会调用）
 *
 * 关于 S1E5：当前 _suggestions/house_of_dragon_05.relationship_events.json 是手工 ground-truth，
 * 这个 agent 跑出来的结果跟它对照可作为 LLM 抽取质量的回归基准（regression baseline）。
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');

// ───────── CLI ──────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv);
const SERVER_ROOT = path.join(__dirname, '..');

const kbPath = path.resolve(SERVER_ROOT, args.kb || 'kb/house_of_dragon_05.json');
const episode = args.episode || 'S01E05';
const synopsis = args.synopsis || ''; // ideally passed by caller / wiki agent
const charDictPath = path.resolve(SERVER_ROOT, args['char-dict'] || 'kb/characters/house-of-the-dragon.json');
const prevEventsPath = args['prev-events']
  ? path.resolve(SERVER_ROOT, args['prev-events'])
  : null;
const videoId = path.basename(kbPath).replace(/\.json$/, '');
const outPath = path.resolve(
  SERVER_ROOT,
  args.out || `kb/characters/_suggestions/${videoId}.relationship_events.json`,
);
const DRY = !!args['dry-run'];

if (!fs.existsSync(kbPath)) { console.error('KB not found:', kbPath); process.exit(1); }
if (!fs.existsSync(charDictPath)) { console.error('char dict not found:', charDictPath); process.exit(1); }

const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
const charDict = JSON.parse(fs.readFileSync(charDictPath, 'utf8'));

// ───────── Controlled vocabularies ──────────────────────────
const RELATION_KIND_ENUM = [
  'parent-child', 'sibling', 'spouse', 'kin-other',
  'close-friend', 'estranged',
  'political-ally', 'political-rival', 'political-fallout',
  'lover', 'lover-killer', 'killer-of-kin',
  'mentor', 'patron-client', 'hostile', 'guardian',
  'political-marriage', 'dance-partner-of-pretender',
];
const STATE_CHANGE_ENUM = [
  'death', 'title_revoked', 'title_added', 'political_realignment',
  'moral_breakdown', 'rebirth',
];
const REL_CHANGE_ENUM = [
  'relation_created', 'relation_inverted', 'relation_intensified',
  'relation_strained', 'relation_reaffirmed', 'relation_terminated',
];

// ───────── Build inputs for the LLM ─────────────────────────
// 1. character roster: id → name + house + tags（不带 spoiler timeline，避免 LLM 看到未来）
const roster = charDict.characters
  .filter(c => !(c.tags || []).includes('dragon')) // 龙不参与关系图
  .map(c => ({
    character_id: c.character_id,
    name_zh: c.display_name_zh || c.canonical_name,
    house: c.house || null,
  }));

// 2. high-value scenes：有 plot.deep_reading 长文本或 narrative
const richScenes = (kb.scenes || [])
  .filter(s => {
    const dr = (s.plot && s.plot.deep_reading) || '';
    const narr = s.narrative || '';
    return dr.length > 100 || narr.length > 30;
  })
  .map(s => {
    // 只保留事件抽取需要的字段
    const sec = Math.floor(s.start_time);
    const ts = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    return {
      scene_id: s.scene_id,
      timestamp: ts,
      narrative: s.narrative || null,
      plot_fact: s.plot && s.plot.fact || null,
      plot_reading: s.plot && s.plot.reading || null,
      plot_deep_reading: s.plot && s.plot.deep_reading || null,
      foreshadow: s.foreshadow || null,
      symbols: (s.symbols || []).map(sym => ({
        symbol_id: sym.symbol_id,
        evidence_in_frame: sym.evidence_in_frame,
      })),
      tags: s.tags || [],
    };
  });

// 3. prev-episode events for sliding-window context
let prevEventsSummary = '(none)';
if (prevEventsPath && fs.existsSync(prevEventsPath)) {
  const pe = JSON.parse(fs.readFileSync(prevEventsPath, 'utf8'));
  const lines = [];
  for (const ev of pe.relationship_events || []) {
    lines.push(`  - [${pe.episode}/${ev.scene_id}] ${ev.source} → ${ev.target}: ${ev.change} (${ev.new_relation_kind}) Δ${ev.intensity_delta} :: ${ev.summary_zh}`);
  }
  prevEventsSummary = lines.length ? lines.join('\n') : '(none)';
}

// ───────── Compose prompt ───────────────────────────────────
const systemPrompt = `你是 House of the Dragon 的人物图谱关系事件抽取器。

你的任务：阅读用户提供的"已富化场景 KB"（每个 scene 含 plot.deep_reading 深度解读、foreshadow 伏笔链接、narrative 主题陈述句），从中抽取结构化的人物事件。

输出三类事件：
  1) state_events: 角色身份/职位/生死的变化
  2) motivation_events: 角色驱动力的变化（动机层）
  3) relationship_events: 一对人物之间关系的变化

约束：
  - 每个事件必须 anchor 到一个 scene_id（触发它的那一帧）
  - 每个事件必须有 evidence 字段，引用 deep_reading 里的原句作为依据
  - 只用提供的 character_id；如果一个人物在 dict 里不存在但场景里出现，写到 character_creations[]，并给 short_safe 资料卡
  - relation_kind 必须从受控枚举里选；change 字段同理
  - intensity_delta 是 -3..+3 整数（-3 = 决裂/死敌，+3 = 至亲/挚爱）
  - 保守原则：deep_reading 没明确暗示的事件，不要编。宁可漏掉，不要捏造。
  - spoiler-safe：character_creations 的 state_timeline.to 应保持未来开放（null），不要写成与未来集相关的字段。
`;

const userPrompt = `# 剧目
${kb.show_id || 'house-of-the-dragon'} ${episode}

# 集梗概
${synopsis || '(略——LLM 应优先以 deep_reading 自身为依据)'}

# 角色字典（id → name / house）
${JSON.stringify(roster, null, 2)}

# relation_kind 枚举
${JSON.stringify(RELATION_KIND_ENUM)}

# state change 枚举
${JSON.stringify(STATE_CHANGE_ENUM)}

# relationship change 枚举
${JSON.stringify(REL_CHANGE_ENUM)}

# 前一集事件（滑动窗口，仅作上下文，不要复制成本集事件）
${prevEventsSummary}

# 本集高价值场景（${richScenes.length} 个，按时间顺序）
${JSON.stringify(richScenes, null, 2)}

# 输出格式
返回严格 JSON：
{
  "character_creations": [...],
  "state_events": [...],
  "motivation_events": [...],
  "relationship_events": [...]
}
不要返回任何 markdown 包装、不要返回额外解释，仅 JSON。
`;

// ───────── Schema for structured output ─────────────────────
const eventSchema = {
  type: 'object',
  properties: {
    character_creations: { type: 'array', items: { type: 'object' } },
    state_events: { type: 'array', items: { type: 'object' } },
    motivation_events: { type: 'array', items: { type: 'object' } },
    relationship_events: { type: 'array', items: { type: 'object' } },
  },
  required: ['character_creations', 'state_events', 'motivation_events', 'relationship_events'],
};

// ───────── Run / dry-run ────────────────────────────────────
async function main() {
  console.log('Episode:        ', episode);
  console.log('KB:             ', path.relative(SERVER_ROOT, kbPath));
  console.log('Char dict:      ', path.relative(SERVER_ROOT, charDictPath));
  console.log('Output (JSON):  ', path.relative(SERVER_ROOT, outPath));
  console.log('Roster size:    ', roster.length);
  console.log('Rich scenes:    ', richScenes.length);
  console.log('Prev events:    ', prevEventsPath ? path.relative(SERVER_ROOT, prevEventsPath) : '(none)');
  console.log('System prompt:  ', systemPrompt.length, 'chars');
  console.log('User prompt:    ', userPrompt.length, 'chars');

  if (DRY) {
    const dumpPath = outPath.replace(/\.json$/, '.prompt.txt');
    fs.writeFileSync(dumpPath, `=== SYSTEM ===\n${systemPrompt}\n\n=== USER ===\n${userPrompt}\n`, 'utf8');
    console.log('\n--dry-run: prompt dumped to', path.relative(SERVER_ROOT, dumpPath));
    console.log('Re-run without --dry-run to actually call the LLM.');
    return;
  }

  console.log('\nCalling LLM (task=character_graph)...');
  const result = await ai.generateStructured({
    task: 'character_graph',
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    schema: eventSchema,
    schemaName: 'character_graph_events',
    temperature: 0.2,
  });

  const out = {
    _schema_version: 1,
    _notes: [
      'auto-generated by character_graph_agent.js — REVIEW BEFORE APPLY.',
      'apply via: node scripts/apply_relationship_events.js --events <this file> --apply',
    ],
    episode,
    video_id: videoId,
    show_id: kb.show_id || 'house-of-the-dragon',
    generated_by: 'character_graph_agent.js',
    generated_at: new Date().toISOString().slice(0, 10),
    ...result,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('\n✓ wrote', path.relative(SERVER_ROOT, outPath));
  console.log('   character_creations:', (out.character_creations || []).length);
  console.log('   state_events:       ', (out.state_events || []).length);
  console.log('   motivation_events:  ', (out.motivation_events || []).length);
  console.log('   relationship_events:', (out.relationship_events || []).length);
  console.log('\nNext: review the file, then run');
  console.log(`  node scripts/apply_relationship_events.js --events ${path.relative(SERVER_ROOT, outPath)} --apply`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
