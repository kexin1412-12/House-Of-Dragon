import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import axios from 'axios';
import './SeasonTimeline.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

/* SeasonTimeline —— 季级宏观时间轴卡（独立于 scene 卡 / 关系图）
   · 三层信息密度：episode chips → focused episode → causal links
   · 进度感知 spoiler-safe：cursor < ep 的节点 locked，灰显且不下发详情
   · 数据源：GET /api/agent/timeline/season（已 mask 过的安全响应）
*/

function epNumFromCursor(cursor) {
  if (!cursor) return 0;
  const m = String(cursor).match(/^S\d{2}E(\d{2})$/);
  return m ? parseInt(m[1], 10) : 0;
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const toRoman = (n) => ROMAN[n] || String(n);

export default function SeasonTimeline({ videoId, videoRef }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [focusEp, setFocusEp] = useState(null);
  const seqRef = useRef(0);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 拉数据：用 videoId + currentTime 让后端解析 cursor（与现有 relationship-graph 同模式）
  const fetchTimeline = useCallback(async () => {
    const t = videoRef?.current?.currentTime || 0;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const { data: resp } = await axios.get(`${API}/api/agent/timeline/season`, {
        params: { videoId: videoId || '', t: String(t), showId: 'house-of-the-dragon', season: 1 },
        timeout: 8000,
      });
      if (seq !== seqRef.current) return;
      setData(resp);
      // 默认聚焦在当前 cursor 对应的那一集（如没 cursor 就聚焦最后一个 unlocked）
      const cursorEp = epNumFromCursor(resp?.cursor_used);
      const lastUnlocked = (resp?.episodes || []).filter(e => !e.locked).slice(-1)[0];
      setFocusEp(cursorEp || (lastUnlocked ? lastUnlocked.ep_num : 1));
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err?.message || String(err));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [videoId, videoRef]);

  // 视频换了 → 清状态
  useEffect(() => {
    setData(null);
    setFocusEp(null);
  }, [videoId]);

  // 打开时拉一次
  useEffect(() => {
    if (open) fetchTimeline();
  }, [open, fetchTimeline]);

  const focused = useMemo(() => {
    if (!data || !focusEp) return null;
    return (data.episodes || []).find(e => e.ep_num === focusEp) || null;
  }, [data, focusEp]);

  // 把 episodes 按 arcs 切片；没有 arcs 配置时退回单组（保留原行为）
  const grouped = useMemo(() => {
    if (!data) return [];
    const eps = data.episodes || [];
    const arcs = data.arcs || [];
    if (!arcs.length) return [{ arc: null, episodes: eps }];
    const byEp = new Map(eps.map(e => [e.ep_num, e]));
    return arcs.map(arc => {
      const [start, end] = arc.ep_range || [0, 0];
      const groupEps = [];
      for (let n = start; n <= end; n++) {
        const ep = byEp.get(n);
        if (ep) groupEps.push(ep);
      }
      return { arc, episodes: groupEps };
    });
  }, [data]);

  // 把 manual key_events 与 KB enrich 出来的事件合并按时间排序
  // (与播放进度条的左→右一致；t=null 的集级事件放最前面，因为没有具体时刻)
  const sortedEvents = useMemo(() => {
    if (!focused?.key_events) return [];
    const toSec = (t) => {
      if (!t) return -1; // 无具体时间戳的集级事件置顶
      const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
      return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
    };
    return [...focused.key_events].sort((a, b) => {
      const ta = toSec(a.t);
      const tb = toSec(b.t);
      if (ta !== tb) return ta - tb;
      // 同时刻：人工写的事件排前，KB 自动抽的排后（让宏观陈述先于细节解读）
      return (a.from_kb ? 1 : 0) - (b.from_kb ? 1 : 0);
    });
  }, [focused]);

  return (
    <div className={`st-root ${open ? 'is-viewing' : ''}`}>
      {/* 浮动入口图标（与 rg 关系图按钮错开纵向位置） */}
      <div className="st-hud-edge">
        <div
          className="st-hud-icon"
          onClick={() => setOpen(true)}
          title="季时间轴"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <circle cx="6"  cy="12" r="1.6" fill="currentColor" />
            <circle cx="11" cy="12" r="1.6" fill="currentColor" />
            <circle cx="16" cy="12" r="1.6" fill="currentColor" />
            <circle cx="21" cy="12" r="1.6" fill="currentColor" />
            <path d="M3 7v10" />
          </svg>
        </div>
      </div>

      {/* 抽屉 */}
      <div className={`st-overlay ${open ? 'open' : ''}`}>
        <div className="st-scrim" onClick={() => setOpen(false)} />
        <div className="st-card" onClick={(e) => e.stopPropagation()}>
          <button className="st-close" onClick={() => setOpen(false)} title="关闭 (Esc)">×</button>

          <header className="st-header">
            <div className="st-eyebrow">SEASON TIMELINE · 脉络</div>
            <h2 className="st-title">
              {data?.season_label || 'Season 1'}
              <span className="st-cursor">
                {data?.cursor_used ? `进度 · ${data.cursor_used}` : '（未对齐进度，全集屏蔽）'}
              </span>
            </h2>
          </header>

          {loading && !data && <div className="st-status">检索时间轴 ……</div>}
          {error && !loading && (
            <div className="st-status st-status-error">网络异常: {error}</div>
          )}

          {data && (
            <>
              {/* Tier 1: 章节弧分组的横向 episode chips */}
              <div className="st-rail">
                {grouped.map((g, gi) => (
                  <div
                    key={g.arc?.id || `g-${gi}`}
                    className={`st-arc ${g.arc?.locked ? 'is-locked' : ''}`}
                  >
                    {g.arc && (
                      <div className="st-arc-head">
                        <span className="st-arc-roman">{toRoman(gi + 1)}</span>
                        <span className="st-arc-label">{g.arc.label_zh}</span>
                        {g.arc.subtitle_zh && (
                          <span className="st-arc-sub">— {g.arc.subtitle_zh}</span>
                        )}
                      </div>
                    )}
                    <div className="st-arc-bracket">
                      {g.episodes.map(ep => (
                        <button
                          key={ep.ep_num}
                          className={[
                            'st-chip',
                            ep.locked ? 'is-locked' : 'is-open',
                            focusEp === ep.ep_num ? 'is-focused' : '',
                          ].filter(Boolean).join(' ')}
                          disabled={ep.locked}
                          onClick={() => !ep.locked && setFocusEp(ep.ep_num)}
                          title={ep.locked ? '剧透屏蔽：尚未看到这一集' : (ep.title_zh || '')}
                        >
                          <span className="st-chip-num">E{ep.ep_num}</span>
                          {ep.locked
                            ? <span className="st-chip-lock">🔒</span>
                            : (
                              <>
                                <span className="st-chip-title">{ep.title_zh}</span>
                                {ep.tag && <span className="st-chip-tag">{ep.tag}</span>}
                              </>
                            )}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Tier 2: focused episode 详情 */}
              {focused && !focused.locked && (
                <section className="st-detail">
                  <div className="st-detail-head">
                    <h3 className="st-detail-title">
                      <span className="st-detail-num">E{focused.ep_num}</span>
                      {focused.title_zh}
                      {focused.title && (
                        <span className="st-detail-en">— {focused.title}</span>
                      )}
                    </h3>
                    {focused.tag && <span className="st-detail-tag">{focused.tag}</span>}
                  </div>

                  {focused.synopsis && (
                    <p className="st-synopsis">{focused.synopsis}</p>
                  )}

                  {sortedEvents.length > 0 && (
                    <div className="st-block">
                      <div className="st-block-label">关键事件</div>
                      <ol className="st-events">
                        {sortedEvents.map((ev, i) => {
                          // 仅当事件属于当前 cursor 命中的那一集时，跳转才落在视频时域里
                          const sec = (() => {
                            if (!ev.t) return -1;
                            const m = String(ev.t).match(/^(\d{1,2}):(\d{2})$/);
                            return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
                          })();
                          const cursorEp = epNumFromCursor(data?.cursor_used);
                          const seekable = sec >= 0 && focused?.ep_num === cursorEp;
                          const onSeek = () => {
                            if (!seekable) return;
                            const v = videoRef?.current;
                            if (!v) return;
                            v.currentTime = sec;
                            const playPromise = v.play?.();
                            if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
                            setOpen(false); // 跳转后收起抽屉看回视频
                          };
                          return (
                            <li
                              key={i}
                              className={[
                                'st-event',
                                ev.crit ? 'is-crit' : '',
                                ev.from_kb ? 'is-from-kb' : '',
                                seekable ? 'is-seekable' : '',
                              ].filter(Boolean).join(' ')}
                              onClick={seekable ? onSeek : undefined}
                              title={seekable ? `跳到 ${ev.t}` : (sec < 0 ? '集级事件，无具体时间戳' : '该集不是当前播放集')}
                            >
                              {ev.t && <span className="st-event-t">{ev.t}</span>}
                              <span className="st-event-text">{ev.text}</span>
                              {ev.from_kb && <span className="st-event-source" title={`来自 scene ${ev.scene_id} 的解读`}>KB</span>}
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  )}

                </section>
              )}

              {focused && focused.locked && (
                <section className="st-detail st-detail-locked">
                  <div className="st-locked-msg">
                    <span className="st-locked-icon">🔒</span>
                    剧透屏蔽：你还没看到这一集。继续观看后再回来查看。
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
