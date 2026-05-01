import React, { useEffect, useRef, useState } from 'react';
import './MemeOverlay.css';

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

export default function MemeOverlay({ videoId, videoRef, enabled = true, onExpandRequest }) {
  const [riffs, setRiffs] = useState([]);
  const [activeRiff, setActiveRiff] = useState(null);
  const [hoverOpen, setHoverOpen] = useState(false);
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

  if (!enabled || !activeRiff || !activeRiff.anchor) return null;

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

  return (
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
  );
}

function MemePopover({ riff, onMouseEnter, onMouseLeave, onExpand }) {
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
      </div>
      {riff.tier2_punch && (
        <div className="mo-popover-body">{riff.tier2_punch}</div>
      )}
      <button className="mo-popover-expand" onClick={onExpand}>
        展开详情 ›
      </button>
    </div>
  );
}
