import React, { useEffect, useRef, useState } from 'react';
import './MemeOverlay.css';
import useMemeFavorites from './useMemeFavorites';
import MemeShareCard from './MemeShareCard';
import SceneShareCard from './SceneShareCard';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// 把 subtitle_en 切成 [前段 | 高亮 | 后段]，找不到关键词就返回 [整句]。
function splitHighlight(text, keyword) {
  if (!text || !keyword) return [{ text: text || '', highlight: false }];
  const idx = text.indexOf(keyword);
  if (idx < 0) return [{ text, highlight: false }];
  const before = text.slice(0, idx);
  const after = text.slice(idx + keyword.length);
  return [
    before && { text: before, highlight: false },
    { text: keyword, highlight: true },
    after && { text: after, highlight: false },
  ].filter(Boolean);
}

export default function MemeOverlay({ videoId, videoRef, videoUrl, enabled = true, onExpandRequest }) {
  const [riffs, setRiffs] = useState([]);
  const [activeRiff, setActiveRiff] = useState(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [shareRiff, setShareRiff] = useState(null);
  const [sceneRiff, setSceneRiff] = useState(null);
  const hoverCloseTimer = useRef(null);

  useEffect(() => {
    if (!videoId) { setRiffs([]); return; }
    fetch(`${API}/api/riffs?videoId=${encodeURIComponent(videoId)}`)
      .then(r => r.json())
      .then(data => setRiffs(data.riffs || []))
      .catch(() => setRiffs([]));
  }, [videoId]);

  useEffect(() => {
    const v = videoRef && videoRef.current;
    if (!v) return;
    const tick = () => {
      const t = v.currentTime;
      const hit = riffs.find(r =>
        r.anchor && t >= r.anchor.start_time && t <= r.anchor.end_time
      );
      setActiveRiff(prev => {
        if ((prev && prev.riff_id) === (hit && hit.riff_id)) return prev;
        // 切换 riff 时关闭悬停
        setHoverOpen(false);
        return hit || null;
      });
    };
    v.addEventListener('timeupdate', tick);
    tick();
    return () => v.removeEventListener('timeupdate', tick);
  }, [riffs, videoRef]);

  // 分享卡独立于 activeRiff 存活：即使播放越过该 riff 时段、字幕浮层下线，
  // 已打开的卡也不该被连带卸载。
  const modals = (
    <>
      {shareRiff && <MemeShareCard riff={shareRiff} onClose={() => setShareRiff(null)} />}
      {sceneRiff && (
        <SceneShareCard
          riff={sceneRiff}
          videoUrl={videoUrl}
          videoRef={videoRef}
          onClose={() => setSceneRiff(null)}
        />
      )}
    </>
  );

  if (!enabled || !activeRiff || !activeRiff.anchor) return modals;

  const { subtitle_en, subtitle_zh, highlight } = activeRiff.anchor;
  const parts = splitHighlight(subtitle_en, highlight);

  const onKeywordEnter = () => {
    if (hoverCloseTimer.current) {
      clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
    setHoverOpen(true);
  };
  const onKeywordLeave = () => {
    hoverCloseTimer.current = setTimeout(() => setHoverOpen(false), 100);
  };

  const handleExpand = () => {
    setHoverOpen(false);
    onExpandRequest && onExpandRequest(activeRiff.riff_id);
  };

  const handleShare = () => {
    setHoverOpen(false);
    setShareRiff(activeRiff);
  };

  const handleShareScene = () => {
    setHoverOpen(false);
    setSceneRiff(activeRiff);
  };

  return (
    <>
      <div className="mo-root">
        {/* 底部蒙板：盖住烧录字幕 */}
        <div className="mo-mask" />

        {/* HTML 字幕 */}
        <div className="mo-subs">
          <div className="mo-sub-en">
            {parts.map((p, i) =>
              p.highlight ? (
                <span
                  key={i}
                  className="mo-highlight"
                  onMouseEnter={onKeywordEnter}
                  onMouseLeave={onKeywordLeave}
                >
                  {p.text}
                  {hoverOpen && (
                    <MemePopover
                      riff={activeRiff}
                      onMouseEnter={onKeywordEnter}
                      onMouseLeave={onKeywordLeave}
                      onExpand={handleExpand}
                      onShare={handleShare}
                      onShareScene={handleShareScene}
                    />
                  )}
                </span>
              ) : (
                <span key={i}>{p.text}</span>
              )
            )}
          </div>
          {subtitle_zh && (
            <div className="mo-sub-zh">{subtitle_zh}</div>
          )}
        </div>
      </div>
      {modals}
    </>
  );
}

function MemePopover({ riff, onMouseEnter, onMouseLeave, onExpand, onShare, onShareScene }) {
  const { isFav, toggle: toggleFav } = useMemeFavorites();
  const fav = isFav(riff.riff_id);
  return (
    <div
      className="mo-popover"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={e => e.stopPropagation()}
    >
      <div className="mo-popover-head">
        <span className="mo-popover-spark">✦</span>
        <span>文化梗</span>
        <button
          className={`mo-popover-fav${fav ? ' is-on' : ''}`}
          onClick={() => toggleFav(riff.riff_id)}
          title={fav ? '取消收藏' : '收藏这条梗'}
        >
          {fav ? '♥' : '♡'}
        </button>
      </div>
      {riff.tier2_punch && (
        <div className="mo-popover-body">{riff.tier2_punch}</div>
      )}
      <div className="mo-popover-actions">
        <button className="mo-popover-share" onClick={onShareScene}>
          📷 片段
        </button>
        <button className="mo-popover-share" onClick={onShare}>
          ⤴ 金句
        </button>
        <button className="mo-popover-expand" onClick={onExpand}>
          展开 ›
        </button>
      </div>
    </div>
  );
}
