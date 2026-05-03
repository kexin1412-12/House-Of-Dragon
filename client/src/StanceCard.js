import React, { useEffect, useRef, useState } from 'react';
import './StanceCard.css';

// 分叉图标 —— 替代 🔀。Y 字形：一根主干，两条带箭头的分支。
function ForkIcon({ className }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M 8 14 L 8 9" />
      <path d="M 8 9 C 8 7 6 6 4 6 L 4 3" />
      <path d="M 8 9 C 8 7 10 6 12 6 L 12 3" />
      <path d="M 2.4 5 L 4 3 L 5.6 5" />
      <path d="M 10.4 5 L 12 3 L 13.6 5" />
    </svg>
  );
}

// 立场抉择卡 / 回顾卡 / 投后 CTA 三态共组件 ——
// 横向 pill 布局，"实时互动" badge + 倒计时，画面右下角浮层。
//
//   投票前：[实时互动] 谷地·戴蒙杀妻  剩余 00:08  ×
//           戴蒙杀了自己的妻子来挣脱一段政治联姻。
//           [冷血但合理] [不可接受] [蕾雅死得不值]
//           hover → 内心理由
//
//   投票后（无推演）：✓ 你投了：xxx + 内心理由 → 1.5s 自动收
//
//   投票后（有推演）：✓ 你投了：xxx
//                    🔀 想看看如果走这条路会怎样？
//                      [展开推演 →]  [关闭继续看]
//
// 不暂停视频、不蒙黑。
//   pre-vote: 10s 内不点 → 自动收
//   post-vote eligible: 不自动收，让用户决定
//   post-vote not eligible: 1.5s 自动收

const AUTO_DISMISS_MS = 10000;
const POST_PICK_DISMISS_MS = 1500;

export default function StanceCard({
  trigger, priorChoice,
  onChoose, onDismiss, onOpenSpeculation,
}) {
  // per-option 推演判定：投了 canonical 选项 → 不出 CTA；投了 by_option 里有
  // hint 的（与剧情不一样的选项）→ 出 CTA。
  const speculationByOption = trigger?.speculation?.by_option || {};
  const [revealedIdx, setRevealedIdx] = useState(null);
  const [pickedId, setPickedId] = useState(null);
  const [remainingMs, setRemainingMs] = useState(AUTO_DISMISS_MS);
  const startedAtRef = useRef(0);
  const isRecall = trigger?.type === 'recall';

  useEffect(() => {
    if (!trigger) return;
    setPickedId(null);
    setRevealedIdx(null);
    startedAtRef.current = Date.now();
    setRemainingMs(AUTO_DISMISS_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.trigger_id]);

  // pre-vote 倒计时
  useEffect(() => {
    if (!trigger || pickedId) return;
    const id = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      const remaining = Math.max(0, AUTO_DISMISS_MS - elapsed);
      setRemainingMs(remaining);
      if (remaining <= 0) {
        clearInterval(id);
        onDismiss && onDismiss();
      }
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.trigger_id, pickedId, onDismiss]);

  // post-vote no-speculation：1.5s 后自动收
  // canSpeculate 走的是当前 pick 的 option_id 是否在 by_option 里
  useEffect(() => {
    if (!pickedId) return;
    if (speculationByOption[pickedId]) return;  // 可推演 → 让用户决定
    const t = setTimeout(() => {
      onDismiss && onDismiss();
    }, POST_PICK_DISMISS_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedId, onDismiss]);

  // ESC dismiss
  useEffect(() => {
    if (!trigger) return;
    const onKey = (e) => { if (e.key === 'Escape') onDismiss && onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trigger, onDismiss]);

  if (!trigger) return null;

  const seconds = Math.ceil(remainingMs / 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const progress = remainingMs / AUTO_DISMISS_MS;

  const lines = trigger.prompt_lines || [];
  const recallMessage = isRecall && priorChoice
    ? trigger.recall_messages_by_prior?.[priorChoice.option_id]
    : null;

  const pickedOpt = pickedId ? trigger.options.find(o => o.id === pickedId) : null;

  // hover 显示 inner_voice；没 hover 时但已选 → 显示已选的 voice
  const voiceIdx = revealedIdx != null
    ? revealedIdx
    : (pickedId ? trigger.options.findIndex(o => o.id === pickedId) : -1);
  const voiceText = voiceIdx >= 0 ? trigger.options[voiceIdx]?.inner_voice : null;

  function handlePick(opt) {
    if (pickedId) return;
    setPickedId(opt.id);
    // 立刻落盘（不论后续是否展开推演）
    onChoose && onChoose(opt);
  }

  function handleOpenSpec() {
    if (!pickedOpt) return;
    const choice = {
      trigger_id: trigger.trigger_id,
      option_id: pickedOpt.id,
      option_label: pickedOpt.label,
      option_inner_voice: pickedOpt.inner_voice,
      scene_label: trigger.scene_label,
    };
    onOpenSpeculation && onOpenSpeculation(trigger, choice);
  }

  return (
    <div className={`stc-pill ${isRecall ? 'is-recall' : ''} ${pickedId ? 'is-post-vote' : ''}`} role="dialog" aria-label="立场抉择">
      <div className="stc-pill-head">
        <span className="stc-pill-badge">实时互动</span>
        <span className="stc-pill-title">{trigger.scene_label || '立场抉择'}</span>
        {!pickedId && (
          <span className="stc-pill-countdown" aria-live="polite">
            剩余 00:{pad2(seconds)}
          </span>
        )}
        <button className="stc-pill-close" onClick={onDismiss} title="跳过 (Esc)" aria-label="跳过">×</button>
      </div>

      {!pickedId && (
        <div className="stc-pill-progress">
          <div className="stc-pill-progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
      )}

      {!pickedId && (lines.length > 0 || recallMessage) && (
        <div className="stc-pill-prompt">
          {recallMessage && (
            <div className="stc-pill-recall-prior">{recallMessage}</div>
          )}
          {lines.map((ln, i) => (
            <span key={i} className="stc-pill-prompt-line">{ln}</span>
          ))}
        </div>
      )}

      {!pickedId && (
        <>
          <div className="stc-pill-options">
            {(trigger.options || []).map((opt, i) => {
              const isHovered = revealedIdx === i;
              return (
                <button
                  key={opt.id}
                  className={`stc-pill-option ${isHovered ? 'is-hovered' : ''}`}
                  onMouseEnter={() => setRevealedIdx(i)}
                  onMouseLeave={() => setRevealedIdx(null)}
                  onClick={() => handlePick(opt)}
                >
                  <span className="stc-pill-option-label">{opt.label}</span>
                </button>
              );
            })}
          </div>

          <div className={`stc-pill-voice ${voiceText ? 'is-shown' : ''}`}>
            {voiceText && <span>"{voiceText}"</span>}
          </div>
        </>
      )}

      {/* ── 投票后视图 ── */}
      {pickedId && pickedOpt && (
        <div className="stc-pill-postvote">
          <div className="stc-pill-postvote-summary">
            <span className="stc-pill-postvote-check">✓</span>
            <span className="stc-pill-postvote-label">你投了：{pickedOpt.label}</span>
          </div>
          {pickedOpt.inner_voice && (
            <div className="stc-pill-postvote-voice">"{pickedOpt.inner_voice}"</div>
          )}

          {speculationByOption[pickedId] && (
            <div className="stc-pill-cta">
              <div className="stc-pill-cta-text">
                <ForkIcon className="stc-pill-cta-icon" />
                想看看如果走这条路会怎样？
              </div>
              <div className="stc-pill-cta-actions">
                <button
                  className="stc-pill-cta-primary"
                  onClick={handleOpenSpec}
                >展开推演</button>
                <button
                  className="stc-pill-cta-ghost"
                  onClick={onDismiss}
                >关闭继续看</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
