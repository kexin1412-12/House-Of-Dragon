import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import './StorylineXRay.css';
import StorylineTimeline from './StorylineTimeline';
import RelationshipGraph from './RelationshipGraph';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// 拉一次 /api/storyline，缓存（视频不切就不重拉）
function useStoryline(videoId) {
  const [storyline, setStoryline] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!videoId) { setStoryline(null); return; }
    let cancelled = false;
    setStoryline(null); setError(null);
    axios.get(`${API}/api/storyline`, { params: { videoId }, timeout: 8000 })
      .then(r => { if (!cancelled) setStoryline(r.data); })
      .catch(e => {
        if (cancelled) return;
        // 404 = 这个视频没 storyline → 不算错，按"无数据"处理（HUD 按钮隐藏）
        if (e?.response?.status === 404) setStoryline(null);
        else setError(e?.message || String(e));
      });
    return () => { cancelled = true; };
  }, [videoId]);

  return { storyline, error };
}

// 250ms 轮询一次 currentTime —— 跟 MemeOverlay / RelationshipGraph 同节奏
function useCurrentTime(videoRef, active) {
  const [currentTime, setCurrentTime] = useState(0);
  useEffect(() => {
    if (!active) return;
    const v = videoRef?.current;
    if (!v) return;
    let id = 0;
    const tick = () => {
      const vNow = videoRef.current;
      if (vNow) setCurrentTime(vNow.currentTime || 0);
      id = window.setTimeout(tick, 250);
    };
    tick();
    return () => clearTimeout(id);
  }, [videoRef, active]);
  return currentTime;
}

export default function StorylineXRay({ videoId, videoRef }) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('events'); // 'events' | 'graph'
  const { storyline } = useStoryline(videoId);
  // 即使没打开也轻量轮询 currentTime——这样 HUD 按钮可以常显进度（暂未做），
  // 同时关掉再开会立刻显示正确状态。但只在 open=true 时才真的拉。
  const currentTime = useCurrentTime(videoRef, open);

  // 完成度：已观看主线节点数 / 主线总数
  const completion = useMemo(() => {
    if (!storyline) return { watched: 0, total: 0, pct: 0 };
    const ids = storyline.main_track_node_ids || [];
    const byId = {};
    for (const n of (storyline.nodes || [])) byId[n.node_id] = n;
    let watched = 0;
    for (const id of ids) {
      const n = byId[id];
      if (n && currentTime >= n.end_time) watched++;
    }
    const pct = ids.length ? Math.round((watched / ids.length) * 100) : 0;
    return { watched, total: ids.length, pct };
  }, [storyline, currentTime]);

  const onJumpTo = useCallback((t) => {
    const v = videoRef?.current;
    if (!v) return;
    try { v.currentTime = t; } catch (_) {}
  }, [videoRef]);

  // ESC / 点蒙板关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 视频切换时关闭
  useEffect(() => { setOpen(false); }, [videoId]);

  // 没数据 → HUD 按钮隐藏
  if (!storyline) return null;

  return (
    <div className={`sx-root ${open ? 'is-open' : ''}`}>
      {/* HUD 入口按钮（沿用 RelationshipGraph 的右栏边带位置） */}
      {!open && (
        <div className="sx-hud-edge">
          <button
            className="sx-hud-icon"
            onClick={() => setOpen(true)}
            title="叙事 X 光"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              {/* 主线 */}
              <line x1="3" y1="12" x2="21" y2="12" />
              {/* 主线节点 */}
              <circle cx="6" cy="12" r="1.6" fill="currentColor" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" />
              <circle cx="18" cy="12" r="1.6" fill="currentColor" />
              {/* 支线分叉 */}
              <path d="M 12 12 L 14 7" />
              <circle cx="14" cy="7" r="1.4" />
              <path d="M 6 12 L 8 17" strokeDasharray="1.5 1.5" />
              <circle cx="8" cy="17" r="1.4" fill="none" />
            </svg>
            <span className="sx-hud-icon-label">叙事</span>
          </button>
        </div>
      )}

      {/* 全屏覆盖 */}
      {open && (
        <div className="sx-overlay">
          <div className="sx-scrim" onClick={() => setOpen(false)} />
          <div className="sx-panel">
            {/* 顶栏 */}
            <header className="sx-topbar">
              <div className="sx-topbar-left">
                <span className="sx-topbar-title">叙事 X 光</span>
                <span className="sx-topbar-info" title="本集关键叙事节点 + 人物关系全景">ⓘ</span>
              </div>
              <nav className="sx-topbar-tabs">
                <button
                  className={`sx-tab${activeTab === 'events' ? ' is-active' : ''}`}
                  onClick={() => setActiveTab('events')}
                >关键事件结构图</button>
                <button
                  className={`sx-tab${activeTab === 'graph' ? ' is-active' : ''}`}
                  onClick={() => setActiveTab('graph')}
                >人物关系</button>
              </nav>
              <div className="sx-topbar-right">
                <span className="sx-completion-label">本集完成度</span>
                <span className="sx-completion-pct">{completion.pct}%</span>
                <span className="sx-completion-bar">
                  <span className="sx-completion-bar-fill" style={{ width: `${completion.pct}%` }} />
                </span>
                <button className="sx-topbar-close" onClick={() => setOpen(false)} title="关闭 (Esc)">×</button>
              </div>
            </header>

            {/* Tab body */}
            <div className="sx-body">
              {activeTab === 'events' && (
                <StorylineTimeline
                  storyline={storyline}
                  currentTime={currentTime}
                  videoId={videoId}
                  onJumpTo={onJumpTo}
                />
              )}
              {activeTab === 'graph' && (
                <RelationshipGraph
                  videoId={videoId}
                  videoRef={videoRef}
                  embedded
                  onCloseEmbedded={() => setOpen(false)}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
