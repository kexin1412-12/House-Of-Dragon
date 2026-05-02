// 立场追踪 / Stance Tracking —— localStorage 状态层
//
// 后端不存选择（anonymous + 无 DB）。所有 user state 在浏览器里：
//   hotd.stance.v1 = { choices }
//
// 不打分、不归类、不聚合。choices 就是一个按时间排序的事件流，
// 每条记录"在哪场戏 / 你选了哪一个 / 你当时的内心理由"。
// 选择本身就是产物，不再派生出"+N 黑党 / X 类型"这种二次产物。
//
// 开关由 conspiratorMode（共谋模式）统一控制，本 store 不再保管 opt-in。

const KEY = 'hotd.stance.v1';

function readRaw() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeRaw(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode → silently ignore；功能本身就是可选 */
  }
}

function ensureState() {
  const cur = readRaw();
  if (cur && typeof cur === 'object') return cur;
  const init = { choices: [] };
  writeRaw(init);
  return init;
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
  writeRaw(s);
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
  writeRaw(s);
  return entry;
}

// 已经触发过的 trigger（不论 faction_choice 还是 recall）—— 用于触发去重
export function isTriggerHandled(triggerId) {
  return getChoices().some(c => c.trigger_id === triggerId);
}

// 整个 store 重置（"重置我的轨迹"按钮用）
export function resetAll() {
  writeRaw({ choices: [] });
}
