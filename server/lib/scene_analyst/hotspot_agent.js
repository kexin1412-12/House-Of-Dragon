/**
 * Hotspot 生成 agent。
 *
 * 与 scene_analyst/agent.js 的区别：
 *   - 输入是"用户想给某个 scene 加一个热点"——可能给了 symbol_id（来自词典），
 *     也可能只给了一句模糊描述（"画面里那杯茶很奇怪"）
 *   - 输出**单个**热点条目（与 scene.symbols[] 元素同形），不是整 scene 解读
 *   - 复用 ToolBox 的查询能力（lookup_motif / search_kb_scenes / get_character_profile / get_subtitles）
 *   - 不写文件、不写双向 foreshadow——只返回 reading.symbol_entry
 *
 * 调用：
 *   const { generateHotspot } = require('./lib/scene_analyst/hotspot_agent');
 *   const { ok, hotspot, transcript } = await generateHotspot({
 *     scene, kb, charDb, toolBox, cursor,
 *     userInput: { symbol_id?, hint?, bbox? },
 *   });
 */

const ai = require('../ai');
const { sceneIdNum } = require('./tools');
const { ANTI_BLOAT_SCENE_RULES } = require('../../prompts/common/anti-bloat');

const SYSTEM_PROMPT = `你是 HBO《龙之家族》的"剧情符号热点"撰稿人。

# 任务
用户在某个 scene 里指定了一个热点（要么直接挑了符号词典里的某个 symbol_id，要么只给了模糊的中文描述）。请用工具查证后，输出**单个热点条目**——格式与 scene.symbols[] 元素一致：

{
  "symbol_id": "string. 优先复用现有词典里的 id；如果用户给的是新的、词典里没有，输出 kebab-case 新 id（如 'larys_bow_to_alicent'）",
  "is_new_symbol_id": false | true,
  "evidence_in_frame": "30-80 字。画面里**具体能看到/听到**的东西——这是用户能验证的硬事实，不要写解读。",
  "meaning_zh": "60-150 字。这个符号在剧中的剧情含义。如果是词典已有 symbol，复述词典含义并**结合当前 scene 加一两句具体化**；如果是新 symbol，自己写。",
  "viewer_takeaway": "一句话（≤30 字），观众看到这个热点的'外卖'金句。",
  "deep_reading": "可选，2-3 句。当前 scene 里这个符号的特殊深读（与词典通用含义不同的部分）。无则 null。",
  "confidence": "high | medium | low. 你对自己判断的置信度。"
}

# 工作步骤
1. 如果用户给了 symbol_id，**先调 lookup_motif** 拿词典条目和过往出现。
2. 如果用户给的是 hint（模糊描述），调 lookup_motif 用 hint 里的关键词搜，看能不能落到现有词典；有就复用 id，没有就给新 id。
3. 调 get_scenes_in_range 看前后几个 scene 的事实——保证 evidence_in_frame 真在画面里。
4. 必要时 search_kb_scenes 看这个符号别处出现过没（用于 deep_reading）。
5. 把所有要写入的字段通过 finalize_hotspot 工具一次性输出。

# 硬规则
- evidence_in_frame **只能写当前 scene 的画面/台词里实际有的东西**。如果当前 scene 的 fact 完全不支持热点描述，confidence=low 并在 evidence 里写"无法在画面中确认，仅根据用户提示推断"。
- meaning_zh 不要照抄词典，要把通用含义"贴"到当前 scene。
- 不剧透 cursor 之后的事件。
${ANTI_BLOAT_SCENE_RULES}
- 禁止古风词（宿命/此刻/盘算/眼前/红尘/命运），HBO 政治剧的克制口吻。
- 工具调用上限 6 次，超额会被强制 finalize。`;

const FINALIZE_TOOL = {
  name: 'finalize_hotspot',
  description: '输出最终热点条目，结束 agent 循环。',
  parameters: {
    type: 'object',
    properties: {
      symbol_id: { type: 'string' },
      is_new_symbol_id: { type: 'boolean' },
      evidence_in_frame: { type: 'string' },
      meaning_zh: { type: 'string' },
      viewer_takeaway: { type: 'string' },
      deep_reading: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      tools_used: { type: 'array', items: { type: 'string' } },
    },
    required: ['symbol_id', 'is_new_symbol_id', 'evidence_in_frame', 'meaning_zh', 'viewer_takeaway', 'confidence', 'tools_used'],
  },
};

const BANNED = ['宿命', '此刻', '盘算', '隐忧', '眼前', '红尘', '尘世', '命运'];

function findBanned(text) {
  if (!text) return [];
  return BANNED.filter(p => text.includes(p));
}
function violatesAnywhere(h) {
  const all = [h?.evidence_in_frame, h?.meaning_zh, h?.viewer_takeaway, h?.deep_reading].filter(Boolean).join(' ');
  return findBanned(all);
}

function safeParseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

async function callWithRetry(fn, { maxRetries = 5, log = () => {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      const status = err?.status || err?.response?.status;
      const is429 = status === 429 || /\b429\b/.test(msg) || /rate limit/i.test(msg);
      const is5xx = (status >= 500 && status < 600) || /\b5\d\d\b/.test(msg);
      if (!is429 && !is5xx) throw err;
      if (attempt === maxRetries) throw err;
      let waitMs = 0;
      const mMs = /try again in (\d+(?:\.\d+)?)\s*ms/i.exec(msg);
      const mS  = /try again in (\d+(?:\.\d+)?)\s*s\b/i.exec(msg);
      if (mMs) waitMs = parseFloat(mMs[1]);
      else if (mS) waitMs = parseFloat(mS[1]) * 1000;
      else waitMs = 1500 * Math.pow(2, attempt);
      waitMs = Math.ceil(waitMs * 1.3) + 200;
      log(`    [retry] ${is429 ? '429' : '5xx'} attempt ${attempt + 1}/${maxRetries} waiting ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

function describeOnScreen(scene, charDb, cursor) {
  if (!charDb || !scene.characters?.length) return [];
  return scene.characters.map(c => {
    const cd = (charDb.characters || []).find(x => x.character_id === c.id);
    if (!cd) return { id: c.id };
    const tl = cd.state_timeline || [];
    const st = tl.filter(s => (!s.from || s.from <= cursor) && (s.to == null || cursor <= s.to)).pop();
    return {
      id: c.id,
      name: cd.display_name_zh,
      title: st?.title_zh || null,
      role: st?.political_role_zh || null,
    };
  });
}

function buildUserPrompt({ scene, charDb, cursor, userInput }) {
  const onScreen = describeOnScreen(scene, charDb, cursor);
  const lines = [
    `# 当前 scene`,
    `scene_id: ${scene.scene_id}`,
    `time: [${scene.start_time.toFixed(1)}s, ${scene.end_time.toFixed(1)}s]`,
    `cursor: ${cursor}`,
    ``,
    `## 客观事实`,
    `plot.fact: ${scene.plot?.fact || '(空)'}`,
    `plot.dialogue_summary: ${scene.plot?.dialogue_summary || '(空)'}`,
    `shot.framing: ${scene.shot?.framing || '(空)'}`,
    `tags: ${(scene.tags || []).join(', ') || '(无)'}`,
    `已有 symbols: ${(scene.symbols || []).map(s => s.symbol_id).join(', ') || '(无)'}`,
    ``,
    `## 画面里的角色`,
    onScreen.length ? JSON.stringify(onScreen, null, 2) : '(空镜或环境)',
    ``,
    `# 用户的热点请求`,
  ];
  if (userInput.symbol_id) {
    lines.push(`- 用户从词典里选了 symbol_id = "${userInput.symbol_id}"`);
    lines.push(`  → 调 lookup_motif 拿词典条目，再把它结合到当前 scene 写成热点。`);
  }
  if (userInput.hint) {
    lines.push(`- 用户的描述/提示："${userInput.hint}"`);
    if (!userInput.symbol_id) {
      lines.push(`  → 先用 lookup_motif 看能不能落到词典里的现有 symbol；不能就给新 kebab-case id。`);
    }
  }
  if (userInput.bbox) {
    lines.push(`- 用户在画面上画了 bbox = ${JSON.stringify(userInput.bbox)}（你不需要处理 bbox，它只是说明用户在指画面的哪块区域）`);
  }
  if (!userInput.symbol_id && !userInput.hint) {
    lines.push(`- 用户没给具体提示，默认让你**自动**挑出这个 scene 里最值得标的一个剧情符号热点。`);
  }
  lines.push('', '# 任务');
  lines.push('按 system 提示走："必要时调工具，再 finalize_hotspot"。最多 6 次工具调用。');
  return lines.join('\n');
}

/**
 * 单 hotspot 生成。
 */
async function generateHotspot({
  scene,
  kb,
  charDb,
  toolBox,
  cursor,
  userInput = {},
  maxToolCalls = 6,
  maxIters = 10,
  temperature = 0.25,
  log = () => {},
}) {
  // 用 ToolBox 的所有查询工具 + 自定义 finalize_hotspot
  const queryTools = toolBox.describeTools().filter(t => t.name !== 'finalize_analysis');
  const tools = [...queryTools, FINALIZE_TOOL];

  const messages = [
    { role: 'user', content: buildUserPrompt({ scene, charDb, cursor, userInput }) },
  ];

  const transcript = [];
  const toolCallsLog = [];
  const seen = new Set();
  let toolCount = 0;
  let usage = { input: 0, output: 0 };
  let finalHotspot = null;

  for (let iter = 0; iter < maxIters; iter++) {
    const remaining = maxToolCalls - toolCount;
    let toolChoice = 'auto';
    let activeTools = tools;
    if (remaining <= 0) {
      toolChoice = { type: 'function', function: { name: 'finalize_hotspot' } };
      activeTools = [FINALIZE_TOOL];
    }

    let resp;
    try {
      resp = await callWithRetry(() => ai.chatWithTools({
        task: 'agent_analysis',
        system: SYSTEM_PROMPT,
        messages,
        tools: activeTools,
        temperature,
        toolChoice,
      }), { log });
    } catch (err) {
      return { ok: false, error: `LLM call failed: ${err.message}`, transcript, toolCalls: toolCallsLog };
    }
    if (resp.usage) { usage.input += resp.usage.input || 0; usage.output += resp.usage.output || 0; }
    transcript.push({ iter, finishReason: resp.finishReason, text: resp.text, toolCalls: resp.toolCalls });
    log(`  iter ${iter}: finish=${resp.finishReason}, tool_calls=${resp.toolCalls.length}`);

    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      if (finalHotspot) return { ok: true, hotspot: finalHotspot, transcript, toolCalls: toolCallsLog, usage };
      messages.push({ role: 'assistant', content: resp.text || '' });
      messages.push({ role: 'user', content: '你没有调用 finalize_hotspot。请立即调用它输出最终热点条目。' });
      continue;
    }

    messages.push({
      role: 'assistant',
      content: resp.text || null,
      tool_calls: resp.toolCalls.map(tc => ({ id: tc.id, name: tc.name, argumentsJson: tc.argumentsJson })),
    });

    for (const tc of resp.toolCalls) {
      const args = safeParseJson(tc.argumentsJson) || {};
      const sig = `${tc.name}::${JSON.stringify(args)}`;
      let result;

      if (seen.has(sig) && tc.name !== 'finalize_hotspot') {
        result = { ok: false, error: `duplicate call: ${sig}` };
      } else {
        seen.add(sig);
        if (tc.name === 'finalize_hotspot') {
          // 内部校验
          const violations = violatesAnywhere(args);
          if (violations.length) {
            result = { ok: false, error: `含违禁古风词：${violations.map(w => `「${w}」`).join('、')}。请重新 finalize_hotspot。` };
          } else if (!args.evidence_in_frame || args.evidence_in_frame.length < 8) {
            result = { ok: false, error: `evidence_in_frame 太短或缺失` };
          } else if (!args.meaning_zh || args.meaning_zh.length < 20) {
            result = { ok: false, error: `meaning_zh 太短（少于 20 字）` };
          } else {
            finalHotspot = args;
            result = { ok: true, data: { received: true } };
          }
        } else {
          result = await toolBox.exec(tc.name, args);
        }
      }

      toolCallsLog.push({ name: tc.name, args, ok: result.ok, error: result.ok ? null : result.error });
      if (tc.name !== 'finalize_hotspot') toolCount++;
      log(`    tool ${tc.name}: ${result.ok ? 'OK' : 'ERR ' + result.error}`);

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result.ok ? result.data : { error: result.error }).slice(0, 8000),
      });
    }

    if (finalHotspot) return { ok: true, hotspot: finalHotspot, transcript, toolCalls: toolCallsLog, usage };
  }

  return { ok: false, error: `agent did not finalize within ${maxIters} iters`, transcript, toolCalls: toolCallsLog, usage };
}

module.exports = { generateHotspot, SYSTEM_PROMPT, FINALIZE_TOOL };
