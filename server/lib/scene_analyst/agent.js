/**
 * Scene-analyst agent loop。
 *
 * 一次 analyzeScene 调用 = 一个 scene 的完整解读：
 *   system + user(scene) → LLM → tool_calls → exec → 结果回喂 → ... → finalize_analysis
 *
 * 终止条件（按优先级）：
 *   1. LLM 调用了 finalize_analysis（成功路径）
 *   2. 达到 maxToolCalls（强制最后一轮无工具，只能 finalize 或 plain text）
 *   3. LLM 不再调工具且没 finalize（视为失败，返回降级 reading）
 */

const ai = require('../ai');
const { sceneIdNum } = require('./tools');

const SYSTEM_PROMPT = `你是 HBO《龙之家族》的剧情解读 agent。

# 任务
为传入的 scene 生成结构化解读。**你必须使用工具**——不要凭印象写。
建议路径：
  1. 先看 scene 自身和近邻的事实（get_scenes_in_range 取 ±5 个邻居）
  2. 如果画面里有显著母题（鱼梁木 / 铁王座 / 月亮茶 / 绿色礼服），调 lookup_motif
  3. 如果不确定某角色当前的政治位置，调 get_character_profile
  4. 如果要找"之前 / 之后是否出现过 X"，调 search_kb_scenes（用 time_lt / time_gt 限定方向）
  5. 调用次数有上限，**最多 8 次**——别浪费。
  6. 收集到足够证据后，调 finalize_analysis 输出结果。

# 写作约束
- foreshadowing.target_scene_id 必须**严格大于**当前 scene_id；callback.source_scene_id 必须**严格小于**当前 scene_id。违反时间方向请直接置 null。
- 没把握就 null。**宁可少出，不要硬塞**。普通对话 scene 经常 foreshadowing 和 callback 都是 null，这是正常的。
- evidence_used 数组里要列出你**实际依赖**的工具调用，例如 ["lookup_motif(weirwood)", "get_scenes_in_range(s014, s020)"]。这是审计字段，不要造假。
- HBO 政治剧的克制口吻。**禁止古风**词（宿命/此刻/盘算/隐忧/眼前/红尘/命运）。
- 具体 > 抽象。"暗示了悲剧" → 垃圾；"预示 27 分钟后 Joffrey 在婚宴上被杀" → 合格。
- 禁止空话句式："不仅……更是……"、"既有……也有……"、"形成鲜明对比"、"无声地诉说/承担"、"具象化/折射"、"权力与秩序"。
- 不要复述用户看得见的物理信息，例如泥泞、盔甲、帐篷、构图庄严、气氛凝重；除非它直接指向具体文化机制。
- Lore-first：优先写家族规矩、战争习俗、政治利益或人物动机。比如北境老兵南下时，要先考虑"冬狼军"的求死传统，而不是写"军营庄严"。

# 不要做的事
- 不要剧透 cursor 之后的事件。你看到的角色 DB 已经按 cursor 过滤。
- 不要重复调用同一个工具用相同参数（看 scratchpad）。
- 不要无限调工具——超过 6 次就该考虑 finalize 了。

# character_subtext 的硬约束（违反者无效）
- character_subtext 只能写**当前 scene 的 fact 已经提到的角色**，或**画面识别角色列表（on-screen characters）里的角色**。
- 如果 fact 写的是"一名男子" / "一位侍从" / "某人" 等**身份未指明**的人物，subtext 必须保持这种模糊（"该男子……"）或直接填 null。**绝不允许**从工具返回的其它 scene 里"借"一个名字过来安到当前 scene 上。
- 工具（search_kb_scenes / lookup_motif / get_character_profile）返回的角色信息**只能用于建立外部联系**（foreshadowing / callback / thematic_link），不能用于推断当前 scene 里"这个未具名的人就是某某"。
- 普通空镜（无角色出场）→ character_subtext 一律 null。`;

const BANNED = ['宿命', '此刻', '盘算', '隐忧', '眼前', '红尘', '尘世', '命运', '不仅', '更是', '既有', '也有', '形成鲜明对比', '无声地诉说', '具象化', '折射', '权力与秩序'];

function findBanned(text) {
  if (!text) return [];
  return BANNED.filter(p => text.includes(p));
}
function violatesAnywhere(reading) {
  const all = [
    reading?.narrative_function,
    reading?.thematic_link?.how,
    reading?.symbolism,
    reading?.foreshadowing?.text,
    reading?.callback?.text,
    reading?.character_subtext,
  ].filter(Boolean).join(' ');
  return findBanned(all);
}

function safeParseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// 重试 OpenAI 429 / 5xx：429 解析 "try again in Xms"，5xx 用指数退避
async function callWithRetry(fn, { maxRetries = 5, log = () => {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err?.message || String(err);
      const status = err?.status || err?.response?.status;
      const is429 = status === 429 || /\b429\b/.test(msg) || /rate limit/i.test(msg);
      const is5xx = (status >= 500 && status < 600) || /\b5\d\d\b/.test(msg);
      if (!is429 && !is5xx) throw err;
      if (attempt === maxRetries) throw err;
      // 解析 "try again in 830ms" 或 "in 12s"
      let waitMs = 0;
      const mMs = /try again in (\d+(?:\.\d+)?)\s*ms/i.exec(msg);
      const mS  = /try again in (\d+(?:\.\d+)?)\s*s\b/i.exec(msg);
      if (mMs) waitMs = parseFloat(mMs[1]);
      else if (mS) waitMs = parseFloat(mS[1]) * 1000;
      else waitMs = 1500 * Math.pow(2, attempt);   // 指数退避 1.5s, 3s, 6s, ...
      // 加 1.3 倍 buffer 防止边界继续撞限速
      waitMs = Math.ceil(waitMs * 1.3) + 200;
      log(`    [retry] ${is429 ? '429' : '5xx'} (attempt ${attempt + 1}/${maxRetries}) waiting ${waitMs}ms…`);
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

function buildUserPrompt({ scene, kb, charDb, cursor }) {
  const onScreen = describeOnScreen(scene, charDb, cursor);
  const idx = (kb.scenes || []).findIndex(s => s.scene_id === scene.scene_id);
  const prev = idx > 0 ? kb.scenes[idx - 1] : null;
  const next = idx < (kb.scenes.length - 1) ? kb.scenes[idx + 1] : null;

  return [
    `# 当前 scene`,
    `scene_id: ${scene.scene_id}`,
    `time: [${scene.start_time.toFixed(1)}s, ${scene.end_time.toFixed(1)}s]  (duration ${(scene.end_time - scene.start_time).toFixed(1)}s)`,
    `cursor: ${cursor}`,
    ``,
    `## 客观事实（前一阶段已生成）`,
    `plot.fact: ${scene.plot?.fact || '(空)'}`,
    `plot.dialogue_summary: ${scene.plot?.dialogue_summary || '(空)'}`,
    `shot.framing: ${scene.shot?.framing || '(空)'}`,
    `shot.intent: ${scene.shot?.intent || '(空)'}`,
    `shot.emotion: ${scene.shot?.emotion || '(空)'}`,
    `tags: ${(scene.tags || []).join(', ') || '(无)'}`,
    `已识别符号: ${(scene.symbols || []).map(s => s.symbol_id).join(', ') || '(无)'}`,
    ``,
    `## 画面中的角色（已 cursor 过滤）`,
    onScreen.length ? JSON.stringify(onScreen, null, 2) : '(空镜或环境镜头)',
    ``,
    `## 紧邻 scene 的事实（用于结构判断）`,
    prev ? `prev ${prev.scene_id}: ${prev.plot?.fact || '(空)'}` : '(本集首个 scene)',
    next ? `next ${next.scene_id}: ${next.plot?.fact || '(空)'}` : '(本集最后一个 scene)',
    ``,
    `# 任务`,
    `按 system 提示走："先调工具收集证据，再 finalize_analysis"。最多 8 次工具调用。`,
  ].join('\n');
}

/**
 * 单 scene 分析。返回 { ok, reading?, transcript, toolCalls, error?, usage }
 */
async function analyzeScene({
  scene,
  kb,
  charDb,
  toolBox,
  cursor,
  maxToolCalls = 8,
  maxIters = 12,           // 安全阀（每次 LLM 调用算一次 iter）
  temperature = 0.25,
  log = () => {},
}) {
  const tools = toolBox.describeTools();
  const messages = [
    { role: 'user', content: buildUserPrompt({ scene, kb, charDb, cursor }) },
  ];

  const transcript = [];      // 给调试 / 评估用
  const toolCallsLog = [];    // 实际执行了什么工具
  const seenSignatures = new Set();
  let toolCallCount = 0;
  let totalUsage = { input: 0, output: 0 };
  let finalReading = null;

  for (let iter = 0; iter < maxIters; iter++) {
    // 软提示：超过预算就只允许 finalize
    const remaining = maxToolCalls - toolCallCount;
    let toolChoice = 'auto';
    if (remaining <= 0) {
      // 强制 finalize：只暴露 finalize 工具
      toolChoice = { type: 'function', function: { name: 'finalize_analysis' } };
    }

    let resp;
    try {
      resp = await callWithRetry(() => ai.chatWithTools({
        task: 'agent_analysis',
        system: SYSTEM_PROMPT,
        messages,
        tools: remaining <= 0 ? tools.filter(t => t.name === 'finalize_analysis') : tools,
        temperature,
        toolChoice,
      }), { log });
    } catch (err) {
      return { ok: false, error: `LLM call failed: ${err.message}`, transcript, toolCalls: toolCallsLog };
    }
    if (resp.usage) {
      totalUsage.input += resp.usage.input || 0;
      totalUsage.output += resp.usage.output || 0;
    }

    transcript.push({ iter, finishReason: resp.finishReason, text: resp.text, toolCalls: resp.toolCalls });
    log(`  iter ${iter}: finish=${resp.finishReason}, tool_calls=${resp.toolCalls.length}, text_len=${(resp.text || '').length}`);

    // 没有工具调用 → agent 想结束。检查它是不是已经 finalize 过；没 finalize 就报错
    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      if (finalReading) return { ok: true, reading: finalReading, transcript, toolCalls: toolCallsLog, usage: totalUsage };
      // 强制再来一轮，明确要求 finalize
      messages.push({ role: 'assistant', content: resp.text || '' });
      messages.push({
        role: 'user',
        content: '你没有调用 finalize_analysis。请立即调用它输出最终解读。'
      });
      continue;
    }

    // 把 assistant 这条 tool_call 消息追加进去（后续 tool 结果必须紧跟在它后面）
    messages.push({
      role: 'assistant',
      content: resp.text || null,
      tool_calls: resp.toolCalls.map(tc => ({
        id: tc.id, name: tc.name, argumentsJson: tc.argumentsJson,
      })),
    });

    // 执行所有 tool_calls（顺序执行，结果一一回喂）
    for (const tc of resp.toolCalls) {
      const args = safeParseJson(tc.argumentsJson) || {};
      const sig = `${tc.name}::${JSON.stringify(args)}`;
      let result;

      if (seenSignatures.has(sig) && tc.name !== 'finalize_analysis') {
        result = { ok: false, error: `duplicate call (signature seen). 调用过：${sig}。请用不同参数或换工具。` };
      } else {
        seenSignatures.add(sig);
        result = await toolBox.exec(tc.name, args);

        // finalize 命中：额外做时间方向校验
        if (tc.name === 'finalize_analysis' && result.ok) {
          const direction = validateTimeDirection(args, scene.scene_id);
          if (direction.error) {
            result = { ok: false, error: direction.error };
          } else {
            // 风格检查
            const violations = violatesAnywhere(args);
            if (violations.length) {
              result = { ok: false, error: `含违禁古风词：${violations.map(w => `「${w}」`).join('、')}。请重新 finalize_analysis，把对应字段改写得克制一些。` };
            } else {
              finalReading = args;
            }
          }
        }
      }

      toolCallsLog.push({ name: tc.name, args, ok: result.ok, error: result.ok ? null : result.error });
      if (tc.name !== 'finalize_analysis') toolCallCount++;
      log(`    tool ${tc.name}: ${result.ok ? 'OK' : 'ERR ' + result.error}`);

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result.ok ? result.data : { error: result.error }).slice(0, 8000),
      });
    }

    if (finalReading) {
      return { ok: true, reading: finalReading, transcript, toolCalls: toolCallsLog, usage: totalUsage };
    }
  }

  return {
    ok: false,
    error: `agent did not finalize within ${maxIters} iters / ${toolCallCount} tool calls`,
    transcript,
    toolCalls: toolCallsLog,
    usage: totalUsage,
  };
}

// foreshadowing 必须指向后面的 scene；callback 必须指向前面的 scene
function validateTimeDirection(reading, currentSceneId) {
  const cur = sceneIdNum(currentSceneId);
  if (cur == null) return { error: null };
  if (reading.foreshadowing?.target_scene_id) {
    const t = sceneIdNum(reading.foreshadowing.target_scene_id);
    if (t == null) return { error: `foreshadowing.target_scene_id 格式错: ${reading.foreshadowing.target_scene_id}` };
    if (t <= cur) return { error: `foreshadowing.target_scene_id (${reading.foreshadowing.target_scene_id}) 必须严格大于当前 ${currentSceneId}。请置为 null 或换一个真正在后面的 scene。` };
  }
  if (reading.callback?.source_scene_id) {
    const t = sceneIdNum(reading.callback.source_scene_id);
    if (t == null) return { error: `callback.source_scene_id 格式错: ${reading.callback.source_scene_id}` };
    if (t >= cur) return { error: `callback.source_scene_id (${reading.callback.source_scene_id}) 必须严格小于当前 ${currentSceneId}。请置为 null 或换一个真正在前面的 scene。` };
  }
  return { error: null };
}

module.exports = { analyzeScene, SYSTEM_PROMPT };
