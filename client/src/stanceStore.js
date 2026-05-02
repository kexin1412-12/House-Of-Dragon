// 立场追踪 / Stance Tracking —— localStorage 状态层
//
// 后端不存选择（anonymous + 无 DB）。所有 user state 在浏览器里：
//   hotd.stance.v1 = { optin, choices }
//
// choices 是一个按时间排序的事件流，包含 faction_choice 和 recall。
// recall 不直接打分；它带 modifier ('halve' / 'flip')，作用在 requires_prior_choice
// 那条 faction_choice 的 score 上 —— 在算 effective trajectory 时一次性应用。

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
  const init = { optin: null, choices: [] };
  writeRaw(init);
  return init;
}

// ─── opt-in ──────────────────────────────────────────────────────────────

export function getOptIn() {
  const s = ensureState();
  return s.optin;  // 'yes' | 'no' | null
}

export function setOptIn(value) {
  const s = ensureState();
  s.optin = value;
  writeRaw(s);
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
export function recordFactionChoice({ trigger_id, video_id, option_id, score, faction, scene_label }) {
  const s = ensureState();
  // 同一个 trigger 已经选过 → 替换（用户回放重选）
  const idx = s.choices.findIndex(c => c.trigger_id === trigger_id && c.type === 'faction_choice');
  const entry = {
    type: 'faction_choice',
    trigger_id, video_id, option_id, score, faction, scene_label,
    recorded_at: new Date().toISOString(),
  };
  if (idx >= 0) s.choices[idx] = entry;
  else s.choices.push(entry);
  writeRaw(s);
  return entry;
}

// 记录一条 recall 结果（针对前一次 faction_choice 的"打脸"）
export function recordRecallResolution({ trigger_id, video_id, prior_trigger_id, option_id, modifier, scene_label }) {
  const s = ensureState();
  const idx = s.choices.findIndex(c => c.trigger_id === trigger_id && c.type === 'recall');
  const entry = {
    type: 'recall',
    trigger_id, video_id, prior_trigger_id, option_id, modifier, scene_label,
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

// ─── trajectory（轨迹计算） ──────────────────────────────────────────────
//
// 输入：所有 choices（按记录顺序）。
// 输出：[{ trigger_id, scene_label, raw_score, effective_score, cumulative, faction }]
//
// 规则：
//   - faction_choice 的 score 是基础分（+1/0/-1）。
//   - 如果之后有一条 recall 指向它：
//       modifier = 'halve' → effective = raw / 2 (向 0 取整保留方向)
//       modifier = 'flip'  → effective = -raw
//       null / 其它        → effective = raw
//   - cumulative 按 effective_score 累加。
export function computeTrajectory() {
  const choices = getChoices();
  const factionChoices = choices.filter(c => c.type === 'faction_choice');
  const recalls = choices.filter(c => c.type === 'recall');

  // recall index by prior_trigger_id
  const recallByPrior = {};
  for (const r of recalls) {
    recallByPrior[r.prior_trigger_id] = r;
  }

  let cumulative = 0;
  const points = factionChoices.map(fc => {
    const recall = recallByPrior[fc.trigger_id];
    let effective = fc.score;
    if (recall) {
      if (recall.modifier === 'flip') effective = -fc.score;
      else if (recall.modifier === 'halve') {
        effective = fc.score === 0 ? 0 : (fc.score > 0 ? Math.floor(fc.score / 2) : Math.ceil(fc.score / 2));
        if (effective === 0 && fc.score !== 0) effective = fc.score > 0 ? 0 : 0;  // 1/2 → 0 是合理的"几乎中立"
      }
    }
    cumulative += effective;
    return {
      trigger_id: fc.trigger_id,
      scene_label: fc.scene_label,
      raw_score: fc.score,
      effective_score: effective,
      cumulative,
      faction: fc.faction,
      had_recall: !!recall,
      recall_outcome: recall?.option_id || null,
    };
  });

  return points;
}

// 从 trajectory + types catalog 算出"用户的人格类型"
// types 来自 /api/stance/types?show=...
export function classifyType(trajectory, typesCatalog) {
  if (!typesCatalog || !Array.isArray(typesCatalog.types)) return null;
  const total = trajectory.reduce((s, p) => s + p.effective_score, 0);
  const volatility = trajectory.filter(p => p.had_recall && p.recall_outcome !== 'hold_position').length;
  const absScore = Math.abs(total);
  const neutralCount = trajectory.filter(p => p.faction === 'neutral').length;
  const startsPositive = trajectory.length > 0 && trajectory[0].raw_score > 0;
  const endsNegative = trajectory.length > 0 && trajectory[trajectory.length - 1].effective_score < 0;

  for (const t of typesCatalog.types) {
    const m = t.match || {};
    if (m.fallback) continue;
    if (m.starts_positive && !startsPositive) continue;
    if (m.ends_negative && !endsNegative) continue;
    if (typeof m.min_score === 'number' && total < m.min_score) continue;
    if (typeof m.max_score === 'number' && total > m.max_score) continue;
    if (typeof m.max_volatility === 'number' && volatility > m.max_volatility) continue;
    if (typeof m.min_volatility === 'number' && volatility < m.min_volatility) continue;
    if (typeof m.max_abs_score === 'number' && absScore > m.max_abs_score) continue;
    if (typeof m.min_neutral_count === 'number' && neutralCount < m.min_neutral_count) continue;
    return t;
  }
  // fallback
  return typesCatalog.types.find(t => t.match?.fallback) || null;
}

// 整个 store 重置（"重置我的轨迹"按钮用）
export function resetAll() {
  writeRaw({ optin: null, choices: [] });
}
