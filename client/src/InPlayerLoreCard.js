import React, { useEffect, useState } from 'react';
import './InPlayerLoreCard.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// 从 video_id 推 show slug —— 跟 MemePanel 同一份逻辑（demo 期单剧）
function deriveShow(videoId) {
  if (!videoId) return null;
  if (videoId.startsWith('house_of_dragon_')) return 'house-of-the-dragon';
  return null;
}

/**
 * 全屏 / 放大视频模式下的设定百科浮层。
 * 不要走外面右栏（aside.tx-right 在全屏时已经被 hidden）——直接在画面内
 * 右侧浮一张半透明卡片，背景做得透一些，让视频还能看到。
 *
 * Mount 在 .tx-player-wrap 里，跟 MemeOverlay / SceneHotspots 同级。
 */
export default function InPlayerLoreCard({
  videoId,
  loreId,                 // 受控：null 时不渲染
  onClose,
}) {
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!loreId || !videoId) { setCard(null); return; }
    const show = deriveShow(videoId);
    if (!show) { setCard(null); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`${API}/api/lore?show=${encodeURIComponent(show)}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        // 在所有 group 里找该 lore_id
        let hit = null;
        for (const g of (data.groups || [])) {
          const c = (g.cards || []).find(x => x.lore_id === loreId);
          if (c) { hit = c; break; }
        }
        setCard(hit);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setCard(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [loreId, videoId]);

  // ESC 关闭
  useEffect(() => {
    if (!loreId) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loreId, onClose]);

  if (!loreId) return null;

  return (
    <div className="iplc-root" role="dialog" aria-modal="false">
      <div className="iplc-card">
        <button
          className="iplc-close"
          onClick={onClose}
          title="关闭 (Esc)"
          aria-label="关闭"
        >×</button>

        {loading && <div className="iplc-loading">载入中…</div>}

        {!loading && !card && (
          <div className="iplc-empty">这张设定百科卡暂时找不到。</div>
        )}

        {!loading && card && (
          <>
            <div className="iplc-header">
              <div className="iplc-title-row">
                <h3 className="iplc-title">{card.title}</h3>
                {card.title_en && (
                  <span className="iplc-title-en">{card.title_en}</span>
                )}
              </div>
              {card.tag && <span className="iplc-tag">{card.tag}</span>}
            </div>

            <div className="iplc-body">
              <p className="iplc-summary">{card.summary}</p>
              <div className="iplc-divider" />
              <p className="iplc-detail">{card.detail}</p>

              {Array.isArray(card.see_also) && card.see_also.length > 0 && (
                <div className="iplc-see-also">
                  <span className="iplc-see-also-label">延伸：</span>
                  {card.see_also.map((s, idx) => (
                    <React.Fragment key={idx}>
                      {idx > 0 && <span className="iplc-see-also-sep"> / </span>}
                      <span className="iplc-see-also-item">{s}</span>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
