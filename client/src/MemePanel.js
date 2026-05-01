import React, { useEffect, useRef, useState } from 'react';
import './MemePanel.css';
import useMemeFavorites from './useMemeFavorites';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// mm:ss 格式化（floor 到整秒，前导零）
function formatMMSS(seconds) {
  const s = Math.floor(seconds);
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

export default function MemePanel({ videoId, videoRef, expandRiffId, onConsumeExpand }) {
  const [riffs, setRiffs] = useState([]);
  const [openId, setOpenId] = useState(null);
  const itemRefs = useRef({}); // riff_id -> DOM node
  const { isFav, toggle: toggleFav, count: favCount } = useMemeFavorites();

  useEffect(() => {
    if (!videoId) { setRiffs([]); return; }
    fetch(`${API}/api/riffs?videoId=${encodeURIComponent(videoId)}`)
      .then(r => r.json())
      .then(data => setRiffs(data.riffs || []))
      .catch(() => setRiffs([]));
  }, [videoId]);

  // MemeOverlay 触发"展开详情"时：自动滚动到对应条目并展开
  useEffect(() => {
    if (!expandRiffId) return;
    setOpenId(expandRiffId);
    const node = itemRefs.current[expandRiffId];
    if (node && node.scrollIntoView) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    onConsumeExpand && onConsumeExpand();
  }, [expandRiffId, onConsumeExpand]);

  const jumpTo = (t) => {
    const v = videoRef && videoRef.current;
    if (v) v.currentTime = t;
  };

  if (riffs.length === 0) {
    return (
      <div className="mp-empty">本集无文化梗</div>
    );
  }

  return (
    <div className="mp-root">
      <div className="mp-header">
        本集检测到 <strong>{riffs.length}</strong> 个文化梗
        {favCount > 0 && (
          <span className="mp-header-fav">· 已收藏 {favCount}</span>
        )}
      </div>
      <div className="mp-list">
        {riffs.map((r, i) => {
          const isOpen = openId === r.riff_id;
          return (
            <div
              key={r.riff_id}
              ref={el => { if (el) itemRefs.current[r.riff_id] = el; }}
              className={`mp-item${isOpen ? ' is-open' : ''}`}
            >
              <button
                className="mp-item-head"
                onClick={() => setOpenId(isOpen ? null : r.riff_id)}
              >
                <span className="mp-item-num">{i + 1}</span>
                {r.anchor && r.anchor.keyframe && (
                  <div className="mp-item-thumb-wrap">
                    <img
                      className="mp-item-thumb"
                      src={`${API}/kb/${r.anchor.keyframe}`}
                      alt=""
                    />
                    {isFav(r.riff_id) && (
                      <span className="mp-item-fav-badge" title="已收藏">♥</span>
                    )}
                  </div>
                )}
                <div className="mp-item-body">
                  <div className="mp-item-quote">
                    "{(r.anchor && r.anchor.subtitle_en) || ''}"
                  </div>
                  <div className="mp-item-meta">
                    <span className="mp-item-time">
                      {r.anchor ? formatMMSS(r.anchor.start_time) : ''}
                    </span>
                    {(r.tags || []).map(t => (
                      <span key={t} className="mp-tag">{t}</span>
                    ))}
                  </div>
                </div>
              </button>

              {isOpen && r.tier3 && (
                <div className="mp-item-detail">
                  <div className="mp-detail-quote">
                    <div className="mp-detail-quote-en">
                      "{r.anchor.subtitle_en}"
                    </div>
                    {r.anchor.subtitle_zh && (
                      <div className="mp-detail-quote-zh">
                        {r.anchor.subtitle_zh}
                      </div>
                    )}
                  </div>

                  {r.tier2_punch && (
                    <div className="mp-detail-punch">{r.tier2_punch}</div>
                  )}

                  {r.tier3.why_meme && (
                    <section className="mp-detail-section">
                      <h4>为什么是个梗</h4>
                      <p>{r.tier3.why_meme}</p>
                    </section>
                  )}

                  {Array.isArray(r.tier3.background) && r.tier3.background.length > 0 && (
                    <section className="mp-detail-section">
                      <h4>背景知识</h4>
                      <ul>
                        {r.tier3.background.map((b, idx) => (
                          <li key={idx}>{b}</li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {r.tier3.why_it_matters_now && (
                    <section className="mp-detail-section">
                      <h4>剧情里为什么重要</h4>
                      <p>{r.tier3.why_it_matters_now}</p>
                    </section>
                  )}

                  <div className="mp-detail-actions">
                    <button
                      className="mp-detail-jump"
                      onClick={() => jumpTo(r.anchor.start_time)}
                    >▶ 跳到此处</button>
                    <button
                      className={`mp-detail-fav${isFav(r.riff_id) ? ' is-on' : ''}`}
                      onClick={() => toggleFav(r.riff_id)}
                      title={isFav(r.riff_id) ? '取消收藏' : '收藏这条梗'}
                    >
                      {isFav(r.riff_id) ? '♥ 已收藏' : '♡ 收藏'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
