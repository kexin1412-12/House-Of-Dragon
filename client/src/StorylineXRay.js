import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import './StorylineXRay.css';
import StorylineTimeline from './StorylineTimeline';
import RelationshipGraph from './RelationshipGraph';
import EpisodeSymbolList from './EpisodeSymbolList';

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

// inline 模式下面板的开/收状态：持久化到 localStorage，默认收起。
// 用户反馈：常驻面板默认全展开占太多版面，做成可开关。
const INLINE_OPEN_KEY = 'storyline-xray-inline-open';
function readInlineOpen() {
  try {
    const v = window.localStorage.getItem(INLINE_OPEN_KEY);
    return v === '1';
  } catch (_) { return false; }
}
function writeInlineOpen(v) {
  try { window.localStorage.setItem(INLINE_OPEN_KEY, v ? '1' : '0'); } catch (_) {}
}

function fmtMMSS(s) {
  const t = Math.max(0, Math.floor(s || 0));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// 折叠态的节点卡条：横排主线节点缩略卡。点卡片就跳到那个时刻。
function NodeCardStrip({ storyline, currentTime, onJumpTo, onExpand }) {
  const ids = storyline?.main_track_node_ids || [];
  const byId = useMemo(() => {
    const m = {};
    for (const n of (storyline?.nodes || [])) m[n.node_id] = n;
    return m;
  }, [storyline]);

  if (ids.length === 0) return null;

  return (
    <div className="sx-strip">
      <div className="sx-strip-rail" aria-hidden="true" />
      <div className="sx-strip-cards">
        {ids.map((id, i) => {
          const n = byId[id];
          if (!n) return null;
          const watched = currentTime >= (n.end_time || 0);
          const current = currentTime >= (n.start_time || 0) && currentTime < (n.end_time || 0);
          const cls = [
            'sx-strip-card',
            watched ? 'is-watched' : '',
            current ? 'is-current' : '',
          ].filter(Boolean).join(' ');
          const num = String(i + 1).padStart(2, '0');
          return (
            <button
              key={id}
              className={cls}
              onClick={() => {
                onJumpTo?.(Math.max(0, (n.start_time || 0) - 1));
              }}
              onDoubleClick={() => onExpand?.()}
              title={`${n.title} · ${fmtMMSS(n.start_time)}（双击展开整图）`}
            >
              <span className="sx-strip-card-num">{num}</span>
              {n.keyframe ? (
                <img
                  className="sx-strip-card-thumb"
                  src={`${API}/kb/${n.keyframe}`}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span className="sx-strip-card-thumb is-placeholder" />
              )}
              <span className="sx-strip-card-body">
                <span className="sx-strip-card-title-row">
                  <span className="sx-strip-card-title">{n.title}</span>
                  <span className="sx-strip-card-time">{fmtMMSS(n.start_time)}</span>
                </span>
                <span className="sx-strip-card-summary">{n.summary || ''}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function StorylineXRay({ videoId, videoRef, inline = false }) {
  const [open, setOpen] = useState(false);
  const [inlineOpen, setInlineOpen] = useState(() => readInlineOpen());
  const [activeTab, setActiveTab] = useState('events'); // 'events' | 'graph' | 'symbols'
  const { storyline } = useStoryline(videoId);
  // inline 模式下 currentTime 只在面板展开时跑（收起时不浪费 setTimeout 链）；
  // HUD 模式只在 open=true 时跑
  const currentTime = useCurrentTime(videoRef, inline ? inlineOpen : open);

  const toggleInline = useCallback(() => {
    setInlineOpen(v => { writeInlineOpen(!v); return !v; });
  }, []);

  // tab 点击：切 tab；如果 inline 折叠态，顺便把面板展开（参考截图行为）。
  const handleTabClick = useCallback((tabId) => {
    setActiveTab(tabId);
    if (inline && !inlineOpen) {
      writeInlineOpen(true);
      setInlineOpen(true);
    }
  }, [inline, inlineOpen]);

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

  // ESC / 点蒙板关闭（只对 HUD 浮层模式生效；inline 常驻不关）
  useEffect(() => {
    if (inline || !open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, inline]);

  // 视频切换时关闭浮层（inline 模式无 open 概念）
  useEffect(() => { if (!inline) setOpen(false); }, [videoId, inline]);

  // 没数据 → HUD 按钮 / inline 面板都不渲染
  if (!storyline) return null;

  // inline 模式下：收起时整个 body + tabs + 完成度都隐藏，只留顶栏当 toggle 条
  const inlineCollapsed = inline && !inlineOpen;

  // 共用的面板内容（顶栏 + tab body）
  const panelInner = (
    <>
      <header className={`sx-topbar${inlineCollapsed ? ' is-collapsed' : ''}`}>
        <button
          type="button"
          className="sx-topbar-left"
          onClick={inline ? toggleInline : undefined}
          title={inline ? (inlineOpen ? '收起面板' : '展开面板') : undefined}
        >
          <span className="sx-topbar-title">叙事 X 光</span>
          <span className="sx-topbar-info" title="本集关键叙事节点 + 人物关系全景">ⓘ</span>
        </button>
        <nav className="sx-topbar-tabs">
          <button
            className={`sx-tab${activeTab === 'events' ? ' is-active' : ''}`}
            onClick={() => handleTabClick('events')}
          >
            <svg className="sx-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <circle cx="6" cy="12" r="1.6" fill="currentColor" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" />
              <circle cx="18" cy="12" r="1.6" fill="currentColor" />
              <path d="M 12 12 L 14 7" />
              <circle cx="14" cy="7" r="1.4" />
              <path d="M 6 12 L 8 17" strokeDasharray="1.5 1.5" />
              <circle cx="8" cy="17" r="1.4" fill="none" />
            </svg>
            <span>剧情脉络</span>
          </button>
          <button
            className={`sx-tab${activeTab === 'graph' ? ' is-active' : ''}`}
            onClick={() => handleTabClick('graph')}
          >
            <svg className="sx-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="8" r="3.2" />
              <circle cx="17" cy="9" r="2.4" />
              <path d="M 3 19 c 1.5 -3.5 4 -5 6 -5 s 4.5 1.5 6 5" />
              <path d="M 14.5 18 c 1 -2.4 2.5 -3.5 4 -3.5 s 3 1.1 4 3.5" />
            </svg>
            <span>角色关系</span>
          </button>
          <button
            className={`sx-tab${activeTab === 'symbols' ? ' is-active' : ''}`}
            onClick={() => handleTabClick('symbols')}
          >
            <svg className="sx-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="6" />
              <line x1="15.5" y1="15.5" x2="20" y2="20" />
              <circle cx="11" cy="11" r="1.6" fill="currentColor" stroke="none" />
            </svg>
            <span>关键线索</span>
          </button>
        </nav>
        <div className="sx-topbar-right">
          <span className="sx-completion-label">本集完成度</span>
          <span className="sx-completion-pct">{completion.pct}%</span>
          <span className="sx-completion-bar">
            <span className="sx-completion-bar-fill" style={{ width: `${completion.pct}%` }} />
          </span>
          {inline ? (
            <button
              className="sx-topbar-toggle"
              onClick={toggleInline}
              title={inlineOpen ? '收起面板' : '展开面板'}
              aria-expanded={inlineOpen}
            >
              <span className={`sx-topbar-toggle-caret${inlineOpen ? ' is-open' : ''}`}>⌃</span>
              <span className="sx-topbar-toggle-label">{inlineOpen ? '下滑收起' : '上滑展开'}</span>
            </button>
          ) : (
            <button className="sx-topbar-close" onClick={() => setOpen(false)} title="关闭 (Esc)">×</button>
          )}
        </div>
      </header>

      {inlineCollapsed && (
        <NodeCardStrip
          storyline={storyline}
          currentTime={currentTime}
          onJumpTo={onJumpTo}
          onExpand={() => { writeInlineOpen(true); setInlineOpen(true); }}
        />
      )}

      {!inlineCollapsed && (
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
            onCloseEmbedded={inline ? undefined : (() => setOpen(false))}
          />
        )}
        {activeTab === 'symbols' && (
          <EpisodeSymbolList
            videoId={videoId}
            currentTime={currentTime}
            onJumpTo={onJumpTo}
          />
        )}
      </div>
      )}
    </>
  );

  // inline：常驻面板，跟随页面滚动；不渲染 HUD 按钮和 scrim
  if (inline) {
    return (
      <section className={`sx-root sx-root--inline${inlineCollapsed ? ' is-collapsed' : ''}`}>
        <div className={`sx-panel sx-panel--inline${inlineCollapsed ? ' is-collapsed' : ''}`}>
          {panelInner}
        </div>
      </section>
    );
  }

  // 浮层模式（保留作为可能的小屏幕 fallback）
  return (
    <div className={`sx-root ${open ? 'is-open' : ''}`}>
      {!open && (
        <div className="sx-hud-edge">
          <button
            className="sx-hud-icon"
            onClick={() => setOpen(true)}
            title="叙事 X 光"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <circle cx="6" cy="12" r="1.6" fill="currentColor" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" />
              <circle cx="18" cy="12" r="1.6" fill="currentColor" />
              <path d="M 12 12 L 14 7" />
              <circle cx="14" cy="7" r="1.4" />
              <path d="M 6 12 L 8 17" strokeDasharray="1.5 1.5" />
              <circle cx="8" cy="17" r="1.4" fill="none" />
            </svg>
            <span className="sx-hud-icon-label">叙事</span>
          </button>
        </div>
      )}

      {open && (
        <div className="sx-overlay">
          <div className="sx-scrim" onClick={() => setOpen(false)} />
          <div className="sx-panel">
            {panelInner}
          </div>
        </div>
      )}
    </div>
  );
}
