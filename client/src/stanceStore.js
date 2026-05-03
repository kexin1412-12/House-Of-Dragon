// 立场追踪 / Stance Tracking —— 纯内存状态层（每次刷新页面清零）
//
// 之前用 localStorage('hotd.stance.v1') 持久化，但产品决定立场选择是
// "本次观影"内的现场记录——刷新页面就回到空白，让用户每次重新开始
// 观影时面对一张白板。所以从 localStorage 退化成模块级变量，F5 即清。
//
// 不打分、不归类、不聚合。choices 就是一个按时间排序的事件流，
// 每条记录"在哪场戏 / 你选了哪一个 / 你当时的内心理由"。
// 选择本身就是产物，不再派生出"+N 黑党 / X 类型"这种二次产物。
//
// 开关由 conspiratorMode（共谋模式）统一控制，本 store 不再保管 opt-in。

let _state = { choices: [] };

// 一次性清理旧版本遗留在 localStorage 里的 stance 数据。新模型走纯内存，
// 不读不写 localStorage，但用户浏览器里可能还有上次访问留下的 hotd.stance.v1。
try { localStorage.removeItem('hotd.stance.v1'); } catch {}

function ensureState() {
  return _state;
}

// ─── choices ─────────────────────────────────────────────────────────────

export function getChoices() {
  const s = ensureState();
  return Array.isArray(s.choices) ? s.choices : [];
}

export function getChoiceFor(triggerId) {
  return getChoices().find(c => c.trigger_id === triggerId) || null;
}

// 记录一条 faction_choice 选择
export function recordFactionChoice({ trigger_id, video_id, option_id, option_label, option_inner_voice, scene_label }) {
  const s = ensureState();
  const idx = s.choices.findIndex(c => c.trigger_id === trigger_id && c.type === 'faction_choice');
  const entry = {
    type: 'faction_choice',
    trigger_id, video_id, option_id, option_label, option_inner_voice, scene_label,
    recorded_at: new Date().toISOString(),
  };
  if (idx >= 0) s.choices[idx] = entry;
  else s.choices.push(entry);
  return entry;
}

// 记录一条 recall 结果（针对前一次选择的"打脸"再决定）
export function recordRecallResolution({ trigger_id, video_id, prior_trigger_id, option_id, option_label, option_inner_voice, scene_label }) {
  const s = ensureState();
  const idx = s.choices.findIndex(c => c.trigger_id === trigger_id && c.type === 'recall');
  const entry = {
    type: 'recall',
    trigger_id, video_id, prior_trigger_id, option_id, option_label, option_inner_voice, scene_label,
    recorded_at: new Date().toISOString(),
  };
  if (idx >= 0) s.choices[idx] = entry;
  else s.choices.push(entry);
  return entry;
}

// 已经触发过的 trigger（不论 faction_choice 还是 recall）—— 用于触发去重
export function isTriggerHandled(triggerId) {
  return getChoices().some(c => c.trigger_id === triggerId);
}

// 整个 store 重置（"重置我的轨迹"按钮用）
export function resetAll() {
  _state = { choices: [] };
}
