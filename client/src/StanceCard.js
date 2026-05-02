import React, { useEffect, useState } from 'react';
import './StanceCard.css';

// 立场抉择卡（faction_choice）和回顾卡（recall）共用一个组件。
//
// 形态：**画面左下角的小浮层**，不蒙黑、不暂停视频、不抢焦。
//   - 用户可以选 / 可以按"跳过" / 可以 ESC / 可以彻底无视（auto-fade）
//   - inner_voice 默认折叠，鼠标悬停时展开
//   - 25 秒无交互 → 自动 fade 掉，用户错过这次"窗口"
//
// 选完 onChoose(option) → 父组件落盘 + dismiss。

const AUTO_DISMISS_MS = 25000;

export default function StanceCard({ trigger, priorChoice, onChoose, onDismiss }) {
  const [revealedIdx, setRevealedIdx] = useState(null);
  const isRecall = trigger?.type === 'recall';

  useEffect(() => {
    if (!trigger) return;
    const onKey = (e) => { if (e.key === 'Escape') onDismiss && onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trigger, onDismiss]);

  // 自动 fade —— 25 秒不点就当用户错过本次叙事窗口
  useEffect(() => {
    if (!trigger) return;
    const t = setTimeout(() => onDismiss && onDismiss(), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [trigger, onDismiss]);

  if (!trigger) return null;

  const lines = trigger.prompt_lines || [];
  const recallMessage = isRecall && priorChoice
    ? trigger.recall_messages_by_prior?.[priorChoice.option_id]
    : null;

  return (
    <div className={`stc-inline ${isRecall ? 'is-recall' : ''}`} role="dialog" aria-label="立场抉择">
      <div className="stc-inline-head">
        <span className="stc-inline-eyebrow">{trigger.headline}</span>
        <button
          className="stc-inline-close"
          onClick={onDismiss}
          title="跳过本次 (Esc)"
          aria-label="跳过"
        >×</button>
      </div>

      {trigger.scene_label && (
        <div className="stc-inline-scene">{trigger.scene_label}</div>
      )}

      <div className="stc-inline-prompt">
        {recallMessage && (
          <div className="stc-inline-recall-prior">{recallMessage}</div>
        )}
        {lines.map((ln, i) => (
          <p key={i} className="stc-inline-line">{ln}</p>
        ))}
      </div>

      <div className="stc-inline-options">
        {(trigger.options || []).map((opt, i) => {
          const isHovered = revealedIdx === i;
          return (
            <button
              key={opt.id}
              className={`stc-inline-option ${isHovered ? 'is-hovered' : ''}`}
              onMouseEnter={() => setRevealedIdx(i)}
              onMouseLeave={() => setRevealedIdx(null)}
              onClick={() => onChoose && onChoose(opt)}
            >
              <div className="stc-inline-option-label">{opt.label}</div>
              {isHovered && opt.inner_voice && (
                <div className="stc-inline-option-voice">"{opt.inner_voice}"</div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
