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

// 从 video_id 推 show slug。demo 期只有 HotD 一部剧，按前缀简单映射；
// 接其他剧时再扩展或改由 App.js 显式传入 show prop。
function deriveShowFromVideoId(videoId) {
  if (!videoId) return null;
  if (videoId.startsWith('house_of_dragon_')) return 'house-of-the-dragon';
  return null;
}

// 设定百科分类图标——内联 SVG，跟整体金边深底审美一致；不再用 emoji。
// （JSON 里仍有 category_icon 字段，但渲染层忽略它）
const LORE_CATEGORY_ICON = {
  // 地点与建筑：城堡轮廓
  place: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 20 L3 11 L6 11 L6 8 L9 8 L9 11 L12 11 L12 6 L15 6 L15 11 L18 11 L18 8 L21 8 L21 20 Z" />
      <line x1="3" y1="20" x2="21" y2="20" />
      <line x1="11" y1="20" x2="11" y2="15" />
      <line x1="13" y1="20" x2="13" y2="15" />
    </svg>
  ),
  // 制度与传统：王冠
  institution: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17 L4 8 L9 12 L12 6 L15 12 L20 8 L21 17 Z" />
      <line x1="3" y1="20" x2="21" y2="20" />
      <circle cx="4" cy="8" r="0.9" fill="currentColor" />
      <circle cx="20" cy="8" r="0.9" fill="currentColor" />
      <circle cx="12" cy="6" r="0.9" fill="currentColor" />
    </svg>
  ),
  // 龙与龙骑：飞翼龙剪影
  dragon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13 C 5 10 8 9 11 11 L 13 11 C 16 9 19 10 21 13" />
      <path d="M11 11 L 12 16 L 14 18 L 16 17" />
      <path d="M5 13 L 7 16" />
      <path d="M19 13 L 17 16" />
      <circle cx="13" cy="11" r="0.7" fill="currentColor" />
    </svg>
  ),
  // 家族与阵营：交叉双剑
  house: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="5" x2="15" y2="15" />
      <line x1="19" y1="5" x2="9" y2="15" />
      <path d="M14 14 L 16 14 L 16 16 L 14 16 Z" />
      <path d="M8 14 L 10 14 L 10 16 L 8 16 Z" />
      <line x1="12" y1="17" x2="12" y2="20" />
      <line x1="10" y1="20" x2="14" y2="20" />
    </svg>
  ),
};

export default function MemePanel({ videoId, videoRef, expandRiffId, onConsumeExpand }) {
  const [riffs, setRiffs] = useState([]);
  const [openId, setOpenId] = useState(null);
  const itemRefs = useRef({}); // riff_id -> DOM node
  const { isFav, toggle: toggleFav, count: favCount } = useMemeFavorites();

  // 段 B：设定百科
  const [loreGroups, setLoreGroups] = useState([]);
  const [loreOpen, setLoreOpen] = useState(false); // 顶级折叠
  const [loreCatOpen, setLoreCatOpen] = useState({}); // category -> bool（二级折叠）
  const [loreCardOpen, setLoreCardOpen] = useState(null); // lore_id（三级展开）

  useEffect(() => {
    if (!videoId) { setRiffs([]); return; }
    fetch(`${API}/api/riffs?videoId=${encodeURIComponent(videoId)}`)
      .then(r => r.json())
      .then(data => setRiffs(data.riffs || []))
      .catch(() => setRiffs([]));
  }, [videoId]);

  // 拉设定百科。视频切换时重置所有折叠状态（spec §3.4 第 9 条）。
  useEffect(() => {
    const show = deriveShowFromVideoId(videoId);
    setLoreOpen(false);
    setLoreCatOpen({});
    setLoreCardOpen(null);
    if (!show) { setLoreGroups([]); return; }
    fetch(`${API}/api/lore?show=${encodeURIComponent(show)}`)
      .then(r => r.json())
      .then(data => setLoreGroups(data.groups || []))
      .catch(() => setLoreGroups([]));
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

  const loreTotal = loreGroups.reduce((n, g) => n + g.cards.length, 0);

  // 全空 → 空态。否则即使台词梗为空，只要有设定百科也照常渲染。
  if (riffs.length === 0 && loreTotal === 0) {
    return <div className="mp-empty">本集无文化梗</div>;
  }

  // 设定百科段独立渲染——拎出来好让它在「台词梗」之上下灵活放置。
  const loreSection = loreTotal > 0 && (
    <div className="mp-lore-section">
      <button
        className={`mp-lore-toggle${loreOpen ? ' is-open' : ''}`}
        onClick={() => setLoreOpen(o => !o)}
        aria-expanded={loreOpen}
      >
        <span className="mp-lore-caret">{loreOpen ? '▼' : '▶'}</span>
        <span className="mp-lore-toggle-label">设定百科</span>
        <span className="mp-lore-count">{loreTotal}</span>
      </button>

      {loreOpen && (
        <div className="mp-lore-groups">
          {loreGroups.map(g => {
            const catOpen = !!loreCatOpen[g.category];
            return (
              <div key={g.category} className={`mp-lore-group${catOpen ? ' is-open' : ''}`}>
                <button
                  className="mp-lore-group-toggle"
                  onClick={() => setLoreCatOpen(s => ({ ...s, [g.category]: !s[g.category] }))}
                  aria-expanded={catOpen}
                >
                  <span className="mp-lore-caret mp-lore-caret-sm">{catOpen ? '▼' : '▶'}</span>
                  {LORE_CATEGORY_ICON[g.category] && (
                    <span className="mp-lore-group-icon" aria-hidden="true">
                      {LORE_CATEGORY_ICON[g.category]}
                    </span>
                  )}
                  <span className="mp-lore-group-label">{g.label}</span>
                  <span className="mp-lore-group-count">{g.cards.length}</span>
                </button>

                {catOpen && (
                  <div className="mp-lore-cards">
                    {g.cards.map(c => {
                      const cardOpen = loreCardOpen === c.lore_id;
                      return (
                        <div key={c.lore_id} className={`mp-lore-card${cardOpen ? ' is-open' : ''}`}>
                          <div className="mp-lore-card-head">
                            <div className="mp-lore-card-title">
                              {c.title}
                              {c.title_en && (
                                <span className="mp-lore-card-title-en">（{c.title_en}）</span>
                              )}
                              {c.tag && <span className="mp-tag mp-lore-tag">{c.tag}</span>}
                            </div>
                            <div className="mp-lore-card-summary">{c.summary}</div>
                            {!cardOpen && (
                              <button
                                className="mp-lore-detail-link"
                                onClick={() => setLoreCardOpen(c.lore_id)}
                              >查看详情 →</button>
                            )}
                          </div>

                          {cardOpen && (
                            <div className="mp-lore-card-detail">
                              <p className="mp-lore-card-body">{c.detail}</p>
                              {Array.isArray(c.see_also) && c.see_also.length > 0 && (
                                <div className="mp-lore-see-also">
                                  <span className="mp-lore-see-also-label">延伸：</span>
                                  {c.see_also.map((s, idx) => (
                                    <React.Fragment key={idx}>
                                      {idx > 0 && <span className="mp-lore-see-also-sep"> / </span>}
                                      <span className="mp-lore-see-also-item">{s}</span>
                                    </React.Fragment>
                                  ))}
                                </div>
                              )}
                              <button
                                className="mp-lore-collapse-link"
                                onClick={() => setLoreCardOpen(null)}
                              >↑ 收起</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className="mp-root">
      {/* ─── 段 B：设定百科（移到顶部，按用户反馈） ─────────────── */}
      {loreSection}

      {/* ─── 段 A：台词梗 ──────────────────── */}
      {riffs.length > 0 && (
        <>
          <div className="mp-header">
            本集 · 台词梗 <strong>{riffs.length}</strong>
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
                          src={`/kb/${r.anchor.keyframe}`}
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
        </>
      )}

    </div>
  );
}
