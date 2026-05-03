import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import './EpisodeSymbolList.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

const CATEGORY_ICON = {
  prop: '◆',
  color_code: '◉',
  omission: '◌',
  editing: '◈',
  micro_signal: '◎',
  lore: '✦',
  cta: '↗',
};
const CATEGORY_LABEL = {
  prop: '道具',
  color_code: '色码',
  omission: '缺席',
  editing: '剪辑',
  micro_signal: '暗示',
  lore: '文化',
  cta: '引导',
};

const ALL_TAB = '全部';
const TAB_ORDER = [ALL_TAB, '道具', '剪辑', '暗示', '色码', '缺席', '文化', '引导'];

const fmt = (s) => {
  const t = Math.max(0, Math.floor(s || 0));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export default function EpisodeSymbolList({ videoId, currentTime, onJumpTo }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [activeCat, setActiveCat] = useState(ALL_TAB);

  useEffect(() => {
    if (!videoId) { setItems(null); return; }
    let cancelled = false;
    setItems(null); setError(null);
    axios.get(`${API}/api/agent/episode/symbols`, { params: { videoId }, timeout: 8000 })
      .then(r => { if (!cancelled) setItems(r.data?.items || []); })
      .catch(e => { if (!cancelled) setError(e?.message || String(e)); });
    return () => { cancelled = true; };
  }, [videoId]);

  const grouped = useMemo(() => {
    if (!items) return null;
    const counts = { [ALL_TAB]: items.length };
    for (const it of items) {
      const lbl = CATEGORY_LABEL[it.category] || '其他';
      counts[lbl] = (counts[lbl] || 0) + 1;
    }
    return counts;
  }, [items]);

  const filtered = useMemo(() => {
    if (!items) return [];
    if (activeCat === ALL_TAB) return items;
    return items.filter(it => (CATEGORY_LABEL[it.category] || '其他') === activeCat);
  }, [items, activeCat]);

  // upcoming（未播到）的项目对所有 symbol_id 都展示同一条"等播到这里再揭晓"，
  // 同一 scene 里挂了多个 symbol_id 时会出现两条/三条一模一样的行 —— 视觉上是
  // 重复。按 scene_id（兜底用 floor(scene_start)）折叠：每个 scene 只保留一行，
  // 视频播到那一刻之后所有 symbol 各自展开。
  const display = useMemo(() => {
    if (!filtered.length) return [];
    const t = currentTime || 0;
    const out = [];
    const seenUpcomingScenes = new Set();
    for (const it of filtered) {
      const watched = t >= (it.scene_end ?? it.scene_start);
      if (!watched) {
        const key = it.scene_id || `t${Math.floor(it.scene_start || 0)}`;
        if (seenUpcomingScenes.has(key)) continue;
        seenUpcomingScenes.add(key);
      }
      out.push(it);
    }
    return out;
  }, [filtered, currentTime]);

  const completion = useMemo(() => {
    if (!items || items.length === 0) return { watched: 0, total: 0, pct: 0 };
    const t = currentTime || 0;
    const w = items.filter(it => t >= (it.scene_end ?? it.scene_start)).length;
    return { watched: w, total: items.length, pct: Math.round((w / items.length) * 100) };
  }, [items, currentTime]);

  if (!items && !error) return <div className="esl-loading">载入符号清单……</div>;
  if (error) return <div className="esl-error">载入失败：{error}</div>;
  if (items.length === 0) return <div className="esl-empty">本集还没有标记任何符号。</div>;

  return (
    <div className="esl-root">
      <div className="esl-header">
        <div className="esl-header-blurb">
          本集所有暗藏的视觉/文化信号。<span className="esl-header-spoiler">未播到的镜头会被淡化避免剧透；点哪一行就跳到那一刻。</span>
        </div>
        <div className="esl-completion">
          <span className="esl-comp-label">已观看</span>
          <span className="esl-comp-pct">{completion.watched}/{completion.total}</span>
        </div>
      </div>

      <nav className="esl-tabs">
        {TAB_ORDER.filter(t => grouped && grouped[t] > 0).map(t => (
          <button
            key={t}
            className={`esl-tab${activeCat === t ? ' is-active' : ''}`}
            onClick={() => setActiveCat(t)}
          >
            {t}<span className="esl-tab-count">{grouped[t]}</span>
          </button>
        ))}
      </nav>

      <ul className="esl-list">
        {display.map((it, idx) => {
          const t = currentTime || 0;
          const watched = t >= (it.scene_end ?? it.scene_start);
          const upcoming = !watched;
          const seekTarget = Math.max(0, (it.scene_start || 0) - 1);
          return (
            <li
              key={`${it.scene_id}-${it.symbol_id}-${idx}`}
              className={`esl-item${upcoming ? ' is-upcoming' : ''}`}
              onClick={() => onJumpTo && onJumpTo(seekTarget)}
              title={upcoming ? '点击跳到这一刻 (尚未播放)' : '点击重看这一刻'}
            >
              <span className={`esl-cat esl-cat-${it.category || 'other'}`} aria-hidden="true">
                {CATEGORY_ICON[it.category] || '◈'}
              </span>
              <span className="esl-time">{fmt(it.scene_start)}</span>
              <span className="esl-body">
                <span className="esl-takeaway">
                  {upcoming ? <span className="esl-veil">「等播到这里再揭晓」</span>
                            : (it.viewer_takeaway ? `「${it.viewer_takeaway}」` : it.symbol_id.replace(/_/g, ' '))}
                </span>
                {!upcoming && it.meaning_zh && (
                  <span className="esl-meaning">{it.meaning_zh}</span>
                )}
              </span>
              <span className="esl-status" aria-hidden="true">
                {watched ? '✓' : '·'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
