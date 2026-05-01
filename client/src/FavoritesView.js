import React, { useEffect, useMemo, useState } from 'react';
import './FavoritesView.css';
import useMemeFavorites from './useMemeFavorites';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

function formatMMSS(seconds) {
  const s = Math.floor(seconds);
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// 从 video_id（如 "house_of_dragon_05"）匹配 videos 列表里的显示名
function findVideoForRiff(videos, videoId) {
  if (!videoId) return null;
  return videos.find(v => v.id && v.id.startsWith(videoId)) || null;
}

// 把 filename "house_of_dragon_05.mp4" → 友好剧名
function showNameFor(video) {
  if (!video) return '未知作品';
  return video.name || '未知作品';
}

function episodeTagFor(filename) {
  if (!filename) return '';
  const m1 = /s(\d{1,2})e(\d{1,2})/i.exec(filename);
  if (m1) return `S${m1[1].padStart(2, '0')}E${m1[2].padStart(2, '0')}`;
  const m2 = /[_-](\d{1,2})\.(mp4|mov|mkv|webm|m4v)$/i.exec(filename);
  if (m2) return `S01E${m2[1].padStart(2, '0')}`;
  return '';
}

// 顶部分类 tab —— 目前只有 riff 一种可收藏对象，所以 all / 文化梗 / 经典台词 由
// tag 过滤实现；片段还没有对应的源 UI，先占位。
// 线索（伏笔）后续整合进剧情线视图，不走"收藏"这条路径。
const FAV_TABS = [
  { key: 'all',     label: '全部收藏', enabled: true,  hint: '' },
  { key: 'meme',    label: '文化梗',   enabled: true,  hint: '' },
  { key: 'classic', label: '经典台词', enabled: true,  hint: '' },
  { key: 'clip',    label: '片段',     enabled: false, hint: '播放器加"保存当前片段"按钮后启用' },
];

function applyTabFilter(tabKey, riffs) {
  if (tabKey === 'all') return riffs;
  if (tabKey === 'meme') return riffs.filter(r => !(r.tags || []).includes('经典台词'));
  if (tabKey === 'classic') return riffs.filter(r => (r.tags || []).includes('经典台词'));
  return []; // 人物 / 线索 / 片段 还没数据
}

export default function FavoritesView({ videos, onClose, onJumpToRiff }) {
  const { entries, count, addedAt, toggle, orderedIds } = useMemeFavorites();
  const [allRiffs, setAllRiffs] = useState([]);
  const [activeTag, setActiveTag] = useState(null);
  const [activeTab, setActiveTab] = useState('all');
  const [sortBy, setSortBy] = useState('recent'); // 'recent' | 'oldest'
  const [openNoteId, setOpenNoteId] = useState(null); // 哪张卡片的"查看注释"展开了

  // 拉所有视频的所有 riffs（demo 范围只有 4 条）
  useEffect(() => {
    fetch(`${API}/api/riffs`)
      .then(r => r.json())
      .then(d => setAllRiffs(d.riffs || []))
      .catch(() => setAllRiffs([]));
  }, []);

  // 用户实际收藏过且 KB 里还存在的 riff
  const favoritedRiffs = useMemo(() => {
    const ids = orderedIds(); // 已按收藏时间倒序
    const byId = new Map(allRiffs.map(r => [r.riff_id, r]));
    return ids.map(id => byId.get(id)).filter(Boolean);
  }, [allRiffs, orderedIds]);

  // 标签计数
  const tagCounts = useMemo(() => {
    const m = new Map();
    for (const r of favoritedRiffs) {
      for (const t of (r.tags || [])) {
        m.set(t, (m.get(t) || 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [favoritedRiffs]);

  // 应用 tab + 标签筛选 + 排序
  const visibleRiffs = useMemo(() => {
    let list = applyTabFilter(activeTab, favoritedRiffs);
    if (activeTag) list = list.filter(r => (r.tags || []).includes(activeTag));
    if (sortBy === 'oldest') list = [...list].reverse();
    return list;
  }, [favoritedRiffs, activeTab, activeTag, sortBy]);

  const activeTabDef = FAV_TABS.find(t => t.key === activeTab) || FAV_TABS[0];

  const recentList = favoritedRiffs.slice(0, 3);

  if (count === 0) {
    return (
      <div className="fv-root fv-empty">
        <div className="fv-empty-card">
          <div className="fv-empty-spark">✦</div>
          <h2>你还没有收藏任何梗</h2>
          <p>播放时点 ♡ 收藏精彩台词，这里会留下你的所有标记。</p>
          <button className="fv-empty-back" onClick={onClose}>← 回到首页</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fv-root">
      {/* Header */}
      <header className="fv-header">
        <div className="fv-header-left">
          <h1>我的收藏</h1>
          <div className="fv-subtitle">找回你收藏的文化梗与经典台词</div>
        </div>
        <div className="fv-header-tabs">
          {FAV_TABS.map(t => (
            <button
              key={t.key}
              className={`fv-tab${activeTab === t.key ? ' is-active' : ''}${t.enabled ? '' : ' is-disabled'}`}
              onClick={() => t.enabled && setActiveTab(t.key)}
              title={t.enabled ? '' : t.hint}
            >{t.label}</button>
          ))}
        </div>
        <div className="fv-header-right">
          <span className="fv-count">共 <strong>{count}</strong> 条收藏</span>
          <button className="fv-back-btn" onClick={onClose}>← 回首页</button>
        </div>
      </header>

      <div className="fv-body">
        {/* LEFT —— 标签 + 排序 */}
        <aside className="fv-side fv-side-left">
          <div className="fv-side-block">
            <div className="fv-side-label">标签</div>
            <div className="fv-tag-chips">
              <button
                className={`fv-tag-chip${activeTag === null ? ' is-active' : ''}`}
                onClick={() => setActiveTag(null)}
              >全部 <span className="fv-tag-count">{count}</span></button>
              {tagCounts.map(([tag, n]) => (
                <button
                  key={tag}
                  className={`fv-tag-chip${activeTag === tag ? ' is-active' : ''}`}
                  onClick={() => setActiveTag(tag)}
                >{tag} <span className="fv-tag-count">{n}</span></button>
              ))}
            </div>
          </div>

          <div className="fv-side-block">
            <div className="fv-side-label">排序方式</div>
            <select
              className="fv-side-select"
              value={sortBy}
              onChange={e => setSortBy(e.target.value)}
            >
              <option value="recent">最近收藏</option>
              <option value="oldest">最早收藏</option>
            </select>
          </div>
        </aside>

        {/* CENTER —— 卡片列表 */}
        <main className="fv-list">
          {visibleRiffs.length === 0 && (
            <div className="fv-list-empty">
              {activeTab === 'all' && '没有匹配的收藏'}
              {activeTab === 'meme' && '还没有收藏文化梗类的台词'}
              {activeTab === 'classic' && '还没有收藏经典台词类的内容'}
            </div>
          )}
          {visibleRiffs.map(r => {
            const video = findVideoForRiff(videos, r.video_id);
            const showName = showNameFor(video);
            const epTag = (r.episode || episodeTagFor(video?.filename)).replace(/^S0?/, 'S');
            const noteOpen = openNoteId === r.riff_id;
            return (
              <article key={r.riff_id} className={`fv-card${noteOpen ? ' is-note-open' : ''}`}>
                <div className="fv-card-row">
                  <button
                    className="fv-card-bookmark"
                    onClick={() => toggle(r.riff_id)}
                    title="取消收藏"
                  >▮</button>
                  <div className="fv-card-thumb-wrap">
                    {r.anchor?.keyframe && (
                      <img className="fv-card-thumb" src={`/kb/${r.anchor.keyframe}`} alt="" />
                    )}
                  </div>
                  <div className="fv-card-body">
                    <div className="fv-card-quote-en">"{r.anchor?.subtitle_en}"</div>
                    {r.anchor?.subtitle_zh && (
                      <div className="fv-card-quote-zh">{r.anchor.subtitle_zh}</div>
                    )}
                    {r.tier2_punch && (
                      <div className="fv-card-punch">{r.tier2_punch}</div>
                    )}
                    <div className="fv-card-tags">
                      {(r.tags || []).map(t => (
                        <span key={t} className="fv-tag-pill">{t}</span>
                      ))}
                    </div>
                  </div>
                  <div className="fv-card-side">
                    <div className="fv-card-source">
                      《{showName}》 <span className="fv-card-ep">{epTag}</span> · {formatMMSS(r.anchor?.start_time || 0)}
                    </div>
                    <div className="fv-card-actions">
                      <button
                        className={`fv-action fv-action-secondary${noteOpen ? ' is-on' : ''}`}
                        onClick={() => setOpenNoteId(noteOpen ? null : r.riff_id)}
                      >{noteOpen ? '收起注释' : '查看注释'}</button>
                      <button
                        className="fv-action fv-action-primary"
                        onClick={() => video && onJumpToRiff(video, r, true)}
                      >▶ 跳转片段</button>
                    </div>
                  </div>
                </div>

                {noteOpen && r.tier3 && (
                  <div className="fv-card-notes">
                    {r.tier3.why_meme && (
                      <section className="fv-note-section">
                        <h4>为什么是个梗</h4>
                        <p>{r.tier3.why_meme}</p>
                      </section>
                    )}
                    {Array.isArray(r.tier3.background) && r.tier3.background.length > 0 && (
                      <section className="fv-note-section">
                        <h4>背景知识</h4>
                        <ul>
                          {r.tier3.background.map((b, idx) => (
                            <li key={idx}>{b}</li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {r.tier3.why_it_matters_now && (
                      <section className="fv-note-section">
                        <h4>剧情里为什么重要</h4>
                        <p>{r.tier3.why_it_matters_now}</p>
                      </section>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </main>

        {/* RIGHT —— 最近收藏 */}
        <aside className="fv-side fv-side-right">
          <div className="fv-side-block">
            <div className="fv-side-label">最近收藏</div>
            <div className="fv-recent-list">
              {recentList.map(r => {
                const video = findVideoForRiff(videos, r.video_id);
                const showName = showNameFor(video);
                const epTag = (r.episode || episodeTagFor(video?.filename));
                return (
                  <button
                    key={r.riff_id}
                    className="fv-recent-card"
                    onClick={() => video && onJumpToRiff(video, r, true)}
                  >
                    {r.anchor?.keyframe && (
                      <div className="fv-recent-thumb-wrap">
                        <img className="fv-recent-thumb" src={`/kb/${r.anchor.keyframe}`} alt="" />
                        <span className="fv-recent-bookmark">▮</span>
                      </div>
                    )}
                    <div className="fv-recent-meta">
                      <div className="fv-recent-quote">{r.anchor?.subtitle_en}</div>
                      <div className="fv-recent-source">《{showName}》 {epTag}</div>
                      <div className="fv-recent-time">{formatRelative(addedAt(r.riff_id))}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
