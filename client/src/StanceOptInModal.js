import React, { useEffect } from 'react';
import './StanceOptInModal.css';

// 第一次触发立场卡之前弹出 —— 让用户决定是否开启互动模式。
// "开启" → opt-in='yes'，立刻显示后续的立场卡。
// "暂时不要" → opt-in='no'，本季其余触发点都不再弹（但本季结束可以重新打开）。
//
// 默认 opt-in，避免互动疲劳：观看本质是被动的，强制弹卡会逼用户关掉整个产品。

export default function StanceOptInModal({ open, onAccept, onDecline }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onDecline && onDecline(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onDecline]);

  if (!open) return null;

  return (
    <div className="stom-root" role="dialog" aria-modal="true">
      <div className="stom-card" onClick={e => e.stopPropagation()}>
        <div className="stom-headline">⚔️ 立场追踪</div>

        <div className="stom-body">
          <p>
            从这里开始，我们会在剧情的几个真正的政治转折点上，让你做选择。
          </p>
          <p>
            你不是在投票，是在站队 —— 而你的选择会被剧情后面的反转<em>挑战</em>。
            等你看完整季，会拿到一张属于你的<strong>立场轨迹图</strong>。
          </p>
          <ul className="stom-bullets">
            <li>每集只会弹 1–2 次，不会打断关键剧情</li>
            <li>你的选择只存在你自己的浏览器里，不上传</li>
            <li>随时可以从设置里关掉</li>
          </ul>
        </div>

        <div className="stom-actions">
          <button className="stom-btn stom-btn-primary" onClick={onAccept}>
            开启互动观影
          </button>
          <button className="stom-btn stom-btn-ghost" onClick={onDecline}>
            暂时不要 (ESC)
          </button>
        </div>
      </div>
    </div>
  );
}
