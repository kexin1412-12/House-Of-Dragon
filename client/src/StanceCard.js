import React, { useEffect, useRef, useState } from 'react';
import './StanceCard.css';

// 立场抉择卡 / 回顾卡共组件 ——
// 横向 pill 布局，"实时互动" badge + 倒计时，画面右下角浮层。
//
//   [实时互动]  谷地 · 戴蒙杀妻             剩余 00:08   ×
//   戴蒙杀了自己的妻子来挣脱一段他从未想要的政治联姻。
//   [ 冷血但合理 ]   [ 不可接受 ]   [ 蕾雅死得不值 ]
//   (hover 时下面浮一行内心理由)
//
// 不暂停视频、不蒙黑。10 秒内不点 → 自动 fade，错过就过。

const AUTO_DISMISS_MS = 10000;

export default function StanceCard({ trigger, priorChoice, onChoose, onDismiss }) {
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
  }, [trigger?.trigger_id]);

  // 倒计时 tick
  useEffect(() => {
    if (!trigger) return;
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
  }, [trigger?.trigger_id, onDismiss]);

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

  // hover 显示 inner_voice；没 hover 时但已选 → 显示已选的 voice
  const voiceIdx = revealedIdx != null
    ? revealedIdx
    : (pickedId ? trigger.options.findIndex(o => o.id === pickedId) : -1);
  const voiceText = voiceIdx >= 0 ? trigger.options[voiceIdx]?.inner_voice : null;

  function handlePick(opt) {
    if (pickedId) return;
    setPickedId(opt.id);
    // 留 600ms 让 ✓ 状态可见，再落盘 + 关卡
    setTimeout(() => {
      onChoose && onChoose(opt);
    }, 600);
  }

  return (
    <div className={`stc-pill ${isRecall ? 'is-recall' : ''}`} role="dialog" aria-label="立场抉择">
      <div className="stc-pill-head">
        <span className="stc-pill-badge">实时互动</span>
        <span className="stc-pill-title">{trigger.scene_label || '立场抉择'}</span>
        <span className="stc-pill-countdown" aria-live="polite">
          剩余 00:{pad2(seconds)}
        </span>
        <button className="stc-pill-close" onClick={onDismiss} title="跳过 (Esc)" aria-label="跳过">×</button>
      </div>

      <div className="stc-pill-progress">
        <div className="stc-pill-progress-fill" style={{ width: `${progress * 100}%` }} />
      </div>

      {(lines.length > 0 || recallMessage) && (
        <div className="stc-pill-prompt">
          {recallMessage && (
            <div className="stc-pill-recall-prior">{recallMessage}</div>
          )}
          {lines.map((ln, i) => (
            <span key={i} className="stc-pill-prompt-line">{ln}</span>
          ))}
        </div>
      )}

      <div className="stc-pill-options">
        {(trigger.options || []).map((opt, i) => {
          const isHovered = revealedIdx === i;
          const isPicked = pickedId === opt.id;
          return (
            <button
              key={opt.id}
              className={`stc-pill-option ${isHovered ? 'is-hovered' : ''} ${isPicked ? 'is-picked' : ''} ${pickedId && !isPicked ? 'is-faded' : ''}`}
              onMouseEnter={() => setRevealedIdx(i)}
              onMouseLeave={() => setRevealedIdx(null)}
              onClick={() => handlePick(opt)}
              disabled={!!pickedId}
            >
              <span className="stc-pill-option-label">{opt.label}</span>
              {isPicked && <span className="stc-pill-option-check">✓</span>}
            </button>
          );
        })}
      </div>

      <div className={`stc-pill-voice ${voiceText ? 'is-shown' : ''}`}>
        {voiceText && <span>"{voiceText}"</span>}
      </div>
    </div>
  );
}
