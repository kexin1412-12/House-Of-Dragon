import React, { useEffect, useState } from 'react';
import './TrajectoryChart.css';
import { getChoices, resetAll } from './stanceStore';

// 立场轨迹图 = 一份你做过的选择的清单。
// 不打分、不归类、不画曲线 —— 选择本身就是产物。
//
// 每条记录展示：场景 + 你选了哪个 + 你当时的内心理由。
// 让用户重温自己当时的判断，仅此而已。

export default function TrajectoryChart({ open, onClose }) {
  const [choices, setChoices] = useState([]);

  useEffect(() => {
    if (!open) return;
    setChoices(getChoices().filter(c => c.type === 'faction_choice' || c.type === 'recall'));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function handleReset() {
    if (!window.confirm('确定要清空你所有的立场选择？此操作不可撤销。')) return;
    resetAll();
    setChoices([]);
  }

  return (
    <div className="trc-root" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="trc-card" onClick={e => e.stopPropagation()}>

        <button className="trc-close" onClick={onClose} title="关闭 (Esc)" aria-label="关闭">×</button>

        <div className="trc-header">
          <div className="trc-eyebrow">你做过的选择</div>
          <h2 className="trc-title">第一季 · 你站过的立场</h2>
        </div>

        {choices.length === 0 ? (
          <div className="trc-empty">
            <p>还没有立场记录。</p>
            <p className="trc-empty-sub">在剧情的关键转折点做出第一次选择，就会出现在这里。</p>
          </div>
        ) : (
          <>
            <ChoiceList choices={choices} />

            <div className="trc-actions">
              <button className="trc-btn trc-btn-ghost" onClick={handleReset}>
                重置我的轨迹
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChoiceList({ choices }) {
  return (
    <ul className="trc-list">
      {choices.map((c, i) => (
        <li key={i} className="trc-list-item">
          <div className="trc-list-marker">
            <span className="trc-list-dot" />
            {i < choices.length - 1 && <span className="trc-list-line" />}
          </div>
          <div className="trc-list-text">
            <div className="trc-list-scene">{c.scene_label}</div>
            {c.option_label && (
              <div className="trc-list-choice">你选了：{c.option_label}</div>
            )}
            {c.option_inner_voice && (
              <div className="trc-list-voice">"{c.option_inner_voice}"</div>
            )}
            {c.type === 'recall' && (
              <div className="trc-list-recall">回顾打脸 · 你重新做了选择</div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
