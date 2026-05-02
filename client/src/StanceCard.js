import React, { useEffect, useState } from 'react';
import './StanceCard.css';

// 立场抉择卡（faction_choice）和回顾卡（recall）共用一个组件，type 区分。
//
// faction_choice 模式：3 个阵营选项（站绿党 / 站黑党 / 观望），每项带"内心理由"。
// recall 模式：基于用户前一次选择，引用一段打脸文案 + 3 个反应选项。
//
// 选完 onChoose(option) → 父组件落盘 + 关闭 + 恢复播放。

export default function StanceCard({ trigger, priorChoice, onChoose, onDismiss }) {
  const [revealedIdx, setRevealedIdx] = useState(null);  // hover 时展开"内心理由"
  const isRecall = trigger?.type === 'recall';

  useEffect(() => {
    if (!trigger) return;
    const onKey = (e) => { if (e.key === 'Escape') onDismiss && onDismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trigger, onDismiss]);

  if (!trigger) return null;

  const lines = trigger.prompt_lines || [];
  const recallMessage = isRecall && priorChoice
    ? trigger.recall_messages_by_prior?.[priorChoice.option_id]
    : null;

  return (
    <div className={`stc-root ${isRecall ? 'is-recall' : ''}`} role="dialog" aria-modal="true">
      <div className="stc-card" onClick={e => e.stopPropagation()}>

        <div className="stc-headline">{trigger.headline}</div>
        {trigger.scene_label && (
          <div className="stc-scene-label">{trigger.scene_label}</div>
        )}

        <div className="stc-prompt">
          {recallMessage && (
            <div className="stc-recall-prior">
              {recallMessage}
            </div>
          )}
          {lines.map((ln, i) => (
            <p key={i} className="stc-prompt-line">{ln}</p>
          ))}
        </div>

        <div className="stc-options">
          {(trigger.options || []).map((opt, i) => {
            const isHovered = revealedIdx === i;
            const factionClass = opt.faction
              ? `stc-option-${opt.faction}`
              : (opt.id === 'defect_to_other' ? 'stc-option-flip'
                : opt.id === 'shaken_drift' ? 'stc-option-shake'
                : 'stc-option-neutral');
            return (
              <button
                key={opt.id}
                className={`stc-option ${factionClass} ${isHovered ? 'is-hovered' : ''}`}
                onMouseEnter={() => setRevealedIdx(i)}
                onMouseLeave={() => setRevealedIdx(null)}
                onClick={() => onChoose && onChoose(opt)}
              >
                <div className="stc-option-row">
                  <span className="stc-option-label">{opt.label}</span>
                  {opt.sublabel && (
                    <span className="stc-option-sublabel">— {opt.sublabel}</span>
                  )}
                </div>
                {opt.inner_voice && (
                  <div className="stc-option-voice">"{opt.inner_voice}"</div>
                )}
              </button>
            );
          })}
        </div>

        <div className="stc-footer">
          <button className="stc-skip" onClick={onDismiss}>这次跳过</button>
          <span className="stc-hint">ESC 关闭</span>
        </div>
      </div>
    </div>
  );
}
