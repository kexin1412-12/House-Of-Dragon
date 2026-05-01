import React, { useEffect, useRef, useState } from 'react';
import './SceneHotspots.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';
const FADE_TIMEOUT_MS = 10000;    // popover → badge 自动过渡（用户反馈 3s 来不及反应，特别是放大视频时）
const TICK_INTERVAL_MS = 250;     // 跟 MemeOverlay / RelationshipGraph 同节奏
const DEFAULT_WINDOW_SEC = 8;

// 类型 → 图标 + 中文标签。和右栏设定百科的 SVG 图标分两套：弹窗用 emoji
// 因为弹窗本身已经有金色描边和类型色，emoji 在视频上更易辨识。
const TYPE_META = {
  place:    { icon: '📍', label: '地点' },
  concept:  { icon: '📜', label: '概念' },
  event:    { icon: '⚔️', label: '事件' },
  callback: { icon: '🔗', label: '关联' },
};

export default function SceneHotspots({
  videoId, videoRef, enabled = true,
  onLoreClick, onRiffClick, onCallbackClick,
}) {
  const [hotspots, setHotspots] = useState([]);
  const [windowSec, setWindowSec] = useState(DEFAULT_WINDOW_SEC);
  const [activeId, setActiveId] = useState(null);
  const [phase, setPhase] = useState('hidden'); // 'popover' | 'badge' | 'hidden'

  // 单值 ref：当前进入窗口期内被显式 dismiss / 触发 action 的 hotspot_id。
  // activeId 离开窗口（变 null）时清空，下次再进可再次触发。
  const dismissedIdRef = useRef(null);
  const fadeTimerRef = useRef(null);

  // 拉数据
  useEffect(() => {
    if (!videoId) { setHotspots([]); return; }
    fetch(`${API}/api/scene-hotspots?videoId=${encodeURIComponent(videoId)}`)
      .then(r => r.json())
      .then(data => {
        setHotspots(data.hotspots || []);
        if (typeof data.default_window_seconds === 'number') {
          setWindowSec(data.default_window_seconds);
        }
      })
      .catch(() => setHotspots([]));
  }, [videoId]);

  // 主时钟：每 250ms 看 currentTime 落在哪个 hotspot 的窗口里
  useEffect(() => {
    if (!enabled || hotspots.length === 0) {
      setActiveId(null);
      setPhase('hidden');
      return;
    }
    let cancelled = false;
    let timer = null;

    const tick = () => {
      if (cancelled) return;
      const v = videoRef?.current;
      const t = v ? v.currentTime : 0;
      let hit = null;
      for (const h of hotspots) {
        const start = h.time;
        const end = start + (h.window_seconds || windowSec);
        if (t >= start && t < end) { hit = h; break; }
      }
      const hitId = hit ? hit.hotspot_id : null;

      setActiveId(prev => {
        if (prev === hitId) return prev;
        // 离开当前窗口 → 清掉 dismissed 标记，让下次再进可再次触发
        if (prev != null && hitId == null) {
          dismissedIdRef.current = null;
        }
        // 决定新 phase
        if (hitId == null) {
          setPhase('hidden');
          if (fadeTimerRef.current) { clearTimeout(fadeTimerRef.current); fadeTimerRef.current = null; }
        } else if (dismissedIdRef.current === hitId) {
          // 同一个进入期内已被 dismiss → 不再显示
          setPhase('hidden');
        } else {
          setPhase('popover');
          if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
          fadeTimerRef.current = setTimeout(() => setPhase('badge'), FADE_TIMEOUT_MS);
        }
        return hitId;
      });

      timer = setTimeout(tick, TICK_INTERVAL_MS);
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (fadeTimerRef.current) { clearTimeout(fadeTimerRef.current); fadeTimerRef.current = null; }
    };
  }, [enabled, hotspots, videoRef, windowSec]);

  // 视频切换时全部重置
  useEffect(() => {
    setActiveId(null);
    setPhase('hidden');
    dismissedIdRef.current = null;
  }, [videoId]);

  if (!enabled) return null;

  const active = activeId ? hotspots.find(h => h.hotspot_id === activeId) : null;
  if (!active || phase === 'hidden') return null;

  const meta = TYPE_META[active.type] || TYPE_META.concept;

  const handleAction = () => {
    const ref = active.ref || {};
    if (ref.kind === 'lore' && onLoreClick) onLoreClick(ref.id);
    else if (ref.kind === 'riff' && onRiffClick) onRiffClick(ref.id);
    else if (ref.kind === 'callback' && onCallbackClick) onCallbackClick(ref);
    // 触发后立即收起，标记 dismissed —— 此次进入期内不再显示
    dismissedIdRef.current = active.hotspot_id;
    setPhase('hidden');
    if (fadeTimerRef.current) { clearTimeout(fadeTimerRef.current); fadeTimerRef.current = null; }
  };

  const handleClose = () => {
    dismissedIdRef.current = active.hotspot_id;
    setPhase('hidden');
    if (fadeTimerRef.current) { clearTimeout(fadeTimerRef.current); fadeTimerRef.current = null; }
  };

  const handleBadgeRecall = () => {
    setPhase('popover');
    // 用户主动召回 → 不再自动 fade，留给用户手动 dismiss
    if (fadeTimerRef.current) { clearTimeout(fadeTimerRef.current); fadeTimerRef.current = null; }
  };

  const ctaLabel = active.ref?.kind === 'callback' ? '回看 →' : '了解详情 →';

  return (
    <div className={`sh-root sh-type-${active.type}`}>
      {phase === 'popover' && (
        <div className="sh-popover" role="dialog">
          <div className="sh-popover-icon" aria-hidden="true">{meta.icon}</div>
          <div className="sh-popover-body">
            <div className="sh-popover-typebar">
              <span className="sh-popover-type">{meta.label}</span>
              <span className="sh-popover-title">{active.title}</span>
            </div>
            <div className="sh-popover-context">{active.context}</div>
          </div>
          <div className="sh-popover-actions">
            <button className="sh-popover-cta" onClick={handleAction}>{ctaLabel}</button>
            <button className="sh-popover-close" onClick={handleClose} title="收起 (3 秒后自动收起)">×</button>
          </div>
        </div>
      )}
      {phase === 'badge' && (
        <button
          className="sh-badge"
          onClick={handleBadgeRecall}
          onMouseEnter={handleBadgeRecall}
          title={`${meta.label}: ${active.title} — 点击展开`}
          aria-label={`场景热点：${active.title}`}
        >
          <span className="sh-badge-icon">{meta.icon}</span>
        </button>
      )}
    </div>
  );
}
