import React, { useEffect, useRef, useState } from 'react';
import './MemePanel.css';
import useMemeFavorites from './useMemeFavorites';
import useMemeSocial from './useMemeSocial';
import MemeShareCard from './MemeShareCard';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// mm:ss 格式化（floor 到整秒，前导零）
function formatMMSS(seconds) {
  const s = Math.floor(seconds);
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

// 大数缩写：1243 → 1.2k，891 → 891。给反应种子数用。
function formatCount(n) {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 10 ? Math.round(k) : Number(k.toFixed(1))) + 'k';
  }
  return String(n);
}

// 网友昵称 → 头像首字（中文取首字，英文取首字母大写）
function noteInitial(author) {
  const c = (author || '?').trim().charAt(0) || '?';
  return /[a-z]/i.test(c) ? c.toUpperCase() : c;
}

// 头像底色——按昵称哈希分到一组语义色，避免清一色金（配色多样性）
const AVATAR_COLORS = ['#7c6bd4', '#3f9e7a', '#c78a3c', '#5a86c2', '#b06a8f'];
function avatarColor(author) {
  let h = 0;
  const s = author || '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// tag 按语义上色——别一直堆同一个金（对齐配色多样性偏好）。未列出回落琥珀。
const TAG_TONE = {
  双关: 'tone-amber', 暗指: 'tone-amber', 隐喻: 'tone-amber', 转喻: 'tone-amber', 时代委婉语: 'tone-amber',
  典故: 'tone-violet', 经典台词: 'tone-violet',
  戏剧反讽: 'tone-steel', 地域制度对照: 'tone-steel', 角色弧: 'tone-steel', 身份宣告: 'tone-steel', 演员高光: 'tone-steel',
};
function tagToneClass(t) { return TAG_TONE[t] || 'tone-amber'; }

// 反应键图标——简洁内联 SVG（不用花哨 emoji，跟面板审美一致）
const REACT_TIL_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 18h6" />
    <path d="M10 21h4" />
    <path d="M12 3a6 6 0 0 0-3.6 10.8c.4.3.6.8.6 1.2v1h6v-1c0-.4.2-.9.6-1.2A6 6 0 0 0 12 3Z" />
  </svg>
);
const REACT_KNEW_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5c1 1 6 1 7 0" />
    <path d="M8.7 9.5h.01" />
    <path d="M15.3 9.5h.01" />
  </svg>
);

// 从 video_id 推 show slug。demo 期只有 HotD 一部剧，按前缀简单映射；
// 接其他剧时再扩展或改由 App.js 显式传入 show prop。
function deriveShowFromVideoId(videoId) {
  if (!videoId) return null;
  if (videoId.startsWith('house_of_dragon_')) return 'house-of-the-dragon';
  return null;
}

// 设定百科分类图标——内联 SVG，跟整体金边深底审美一致；不再用 emoji。
// （JSON 里仍有 category_icon 字段，但渲染层忽略它）
// 风格：填充剪影（fill=currentColor），由外层 tile 给金色 + 暗底背景。
const LORE_CATEGORY_ICON = {
  // 地点与建筑：三塔城堡
  place: (
    <svg viewBox="0 0 32 32" fill="currentColor">
      <path d="M2 28 L2 14 L5 14 L5 11 L7 11 L7 14 L9 14 L9 11 L11 11 L11 16 L13 16 L13 8 L19 8 L19 16 L21 16 L21 11 L23 11 L23 14 L25 14 L25 11 L27 11 L27 14 L30 14 L30 28 Z" />
      <rect x="14" y="20" width="4" height="8" fill="#0b0805" />
      <rect x="6" y="22" width="3" height="3" fill="#0b0805" />
      <rect x="23" y="22" width="3" height="3" fill="#0b0805" />
    </svg>
  ),
  // 制度与传统：三尖王冠 + 宝石
  institution: (
    <svg viewBox="0 0 32 32" fill="currentColor">
      <path d="M3 23 L4 11 L10 16 L16 8 L22 16 L28 11 L29 23 Z" />
      <rect x="3" y="23" width="26" height="3" />
      <circle cx="4" cy="11" r="1.6" />
      <circle cx="16" cy="8" r="1.8" />
      <circle cx="28" cy="11" r="1.6" />
    </svg>
  ),
  // 龙与龙骑：盘踞的龙
  dragon: (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 25 C 9 17, 13 14, 17 16 C 21 18, 24 15, 22 11 C 20 7, 14 7, 12 11" />
      <path d="M22 25 C 22 22, 20 20, 17 20" />
      <circle cx="9" cy="25" r="2" fill="currentColor" stroke="none" />
      <path d="M22 8 L 24 6 M22 11 L 25 10" />
    </svg>
  ),
  // 家族与阵营：交叉双剑（带十字护手 + 圆首）
  house: (
    <svg viewBox="0 0 32 32" fill="currentColor">
      {/* sword 1: NW-SE blade */}
      <path d="M7 5 L11 5 L11 9 L23 21 L23 25 L19 25 L19 23 L7 11 Z" />
      <circle cx="9" cy="3.5" r="2" />
      {/* sword 2: NE-SW blade */}
      <path d="M25 5 L21 5 L21 9 L9 21 L9 25 L13 25 L13 23 L25 11 Z" />
      <circle cx="23" cy="3.5" r="2" />
    </svg>
  ),
};

// 分类副标题（固定文案，不在 JSON 里——presentation 层）
const LORE_CATEGORY_SUBTITLE = {
  place:       '探索维斯特洛的城堡、城市与地标',
  institution: '了解七大国的政治、律法与社会习俗',
  dragon:      '深入龙族、巨龙与龙骑士的传奇',
  house:       '王室家族、权力派系与复杂盟约',
};

// 设定百科 header 旁的小书图标
const LORE_HEADER_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5 C 4 4 5 4 6 4 L 11 4 C 12 4 12 5 12 5 L 12 19 C 12 19 12 18 11 18 L 6 18 C 5 18 4 18 4 19 Z" />
    <path d="M20 5 C 20 4 19 4 18 4 L 13 4 C 12 4 12 5 12 5 L 12 19 C 12 19 12 18 13 18 L 18 18 C 19 18 20 18 20 19 Z" />
  </svg>
);

export default function MemePanel({
  videoId, videoRef,
  expandRiffId, onConsumeExpand,
  expandLoreId, onConsumeExpandLore,
}) {
  const [riffs, setRiffs] = useState([]);
  const [openId, setOpenId] = useState(null);
  const itemRefs = useRef({}); // riff_id -> DOM node
  const { isFav, count: favCount } = useMemeFavorites();

  // 段 B：设定百科
  const [loreGroups, setLoreGroups] = useState([]);
  const [loreOpen, setLoreOpen] = useState(false); // 顶级折叠
  const [loreCatOpen, setLoreCatOpen] = useState({}); // category -> bool（二级折叠）
  const [loreCardOpen, setLoreCardOpen] = useState(null); // lore_id（三级展开）
  const loreCardRefs = useRef({}); // lore_id -> DOM node

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

  // SceneHotspots 触发"了解详情"指向 lore 卡时：连开三级（顶级 → category → 卡），滚到卡
  useEffect(() => {
    if (!expandLoreId || loreGroups.length === 0) return;
    // 找该 lore_id 在哪个 category 下
    let targetCat = null;
    for (const g of loreGroups) {
      if (g.cards.some(c => c.lore_id === expandLoreId)) { targetCat = g.category; break; }
    }
    if (!targetCat) {
      // 数据里没这条卡——直接消费信号，避免重复触发
      onConsumeExpandLore && onConsumeExpandLore();
      return;
    }
    setLoreOpen(true);
    setLoreCatOpen(s => ({ ...s, [targetCat]: true }));
    setLoreCardOpen(expandLoreId);
    // 等下一帧 DOM 渲染出新展开的卡再滚
    requestAnimationFrame(() => {
      const node = loreCardRefs.current[expandLoreId];
      if (node && node.scrollIntoView) {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
    onConsumeExpandLore && onConsumeExpandLore();
  }, [expandLoreId, loreGroups, onConsumeExpandLore]);

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
        <span className="mp-lore-toggle-icon" aria-hidden="true">{LORE_HEADER_ICON}</span>
        <span className="mp-lore-toggle-label">设定百科</span>
        <span className="mp-lore-count">{loreTotal}</span>
        <span className="mp-lore-caret">{loreOpen ? '▾' : '▸'}</span>
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
                  {LORE_CATEGORY_ICON[g.category] && (
                    <span className="mp-lore-group-icon" aria-hidden="true">
                      {LORE_CATEGORY_ICON[g.category]}
                    </span>
                  )}
                  <span className="mp-lore-group-text">
                    <span className="mp-lore-group-label">{g.label}</span>
                    {LORE_CATEGORY_SUBTITLE[g.category] && (
                      <span className="mp-lore-group-subtitle">{LORE_CATEGORY_SUBTITLE[g.category]}</span>
                    )}
                  </span>
                  <span className="mp-lore-group-count">{g.cards.length}</span>
                  <span className="mp-lore-group-caret">{catOpen ? '▾' : '▸'}</span>
                </button>

                {catOpen && (
                  <div className="mp-lore-cards">
                    {g.cards.map(c => {
                      const cardOpen = loreCardOpen === c.lore_id;
                      return (
                        <div
                          key={c.lore_id}
                          ref={el => { if (el) loreCardRefs.current[c.lore_id] = el; }}
                          className={`mp-lore-card${cardOpen ? ' is-open' : ''}`}
                        >
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
                          <span key={t} className={`mp-tag ${tagToneClass(t)}`}>{t}</span>
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

                      <MemeSocial
                        riff={r}
                        onJump={() => jumpTo(r.anchor.start_time)}
                      />
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

// ─── 社交层：反应键 / 分享 / viewer notes ───────────────
// 接在条目展开详情底部。三种社交冲动各一块：
//   涨知识了·早就知道（想知道别人懂没懂）/ 分享（炫耀）/ viewer notes（补充欲）。
function MemeSocial({ riff, onJump }) {
  const social = riff.social || {};
  const seedReactions = social.reactions || {};
  const seedNotes = social.notes || [];

  const { reactionOf, setReaction, isUpvoted, toggleUpvote, userNotesFor, addNote } = useMemeSocial();
  const { isFav, toggle: toggleFav } = useMemeFavorites();

  const [shareOpen, setShareOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');

  const pick = reactionOf(riff.riff_id);
  const tilCount = (seedReactions.til || 0) + (pick === 'til' ? 1 : 0);
  const knewCount = (seedReactions.knew || 0) + (pick === 'knew' ? 1 : 0);

  // 投票排序取代时间排序——高赞补充自然浮顶（含本地点赞 +1 与我新增的）。
  const notes = [...seedNotes, ...userNotesFor(riff.riff_id)]
    .map(n => ({ ...n, _up: (n.upvotes || 0) + (isUpvoted(n.note_id) ? 1 : 0) }))
    .sort((a, b) => b._up - a._up);
  const fav = isFav(riff.riff_id);

  const submitNote = () => {
    const body = draft.trim();
    if (!body) return;
    addNote(riff.riff_id, body);
    setDraft('');
    setComposing(false);
  };

  return (
    <div className="mp-social">
      {social.reactions && (
        <div className="mp-react-row">
          <button
            className={`mp-react${pick === 'til' ? ' is-on' : ''}`}
            onClick={() => setReaction(riff.riff_id, 'til')}
          >
            <span className="mp-react-ic" aria-hidden="true">{REACT_TIL_ICON}</span>
            涨知识了
            <span className="mp-react-n">{formatCount(tilCount)}</span>
          </button>
          <button
            className={`mp-react${pick === 'knew' ? ' is-on' : ''}`}
            onClick={() => setReaction(riff.riff_id, 'knew')}
          >
            <span className="mp-react-ic" aria-hidden="true">{REACT_KNEW_ICON}</span>
            早就知道
            <span className="mp-react-n">{formatCount(knewCount)}</span>
          </button>
        </div>
      )}

      <div className="mp-detail-actions">
        <button className="mp-detail-jump" onClick={onJump}>▶ 跳到此处</button>
        <button className="mp-social-share" onClick={() => setShareOpen(true)}>
          ⤴ 分享
        </button>
        <button
          className={`mp-detail-fav${fav ? ' is-on' : ''}`}
          onClick={() => toggleFav(riff.riff_id)}
          title={fav ? '取消收藏' : '收藏这条梗'}
        >
          {fav ? '♥ 已收藏' : '♡ 收藏'}
        </button>
      </div>

      <div className="mp-notes">
        <div className="mp-notes-head">
          <span className="mp-notes-title">viewer notes</span>
          <span className="mp-notes-count">{notes.length}</span>
        </div>

        <div className="mp-notes-list">
          {notes.map(n => (
            <div key={n.note_id} className={`mp-note${n.mine ? ' is-mine' : ''}`}>
              <span
                className="mp-note-avatar"
                style={{ background: n.mine ? '#e0b160' : avatarColor(n.author) }}
              >
                {noteInitial(n.author)}
              </span>
              <div className="mp-note-body">
                <div className="mp-note-meta">
                  <span className="mp-note-author">{n.author}</span>
                  <span className="mp-note-time">· {n.time}</span>
                </div>
                <NoteText text={n.text} />
                <button
                  className={`mp-note-up${isUpvoted(n.note_id) ? ' is-on' : ''}`}
                  onClick={() => toggleUpvote(n.note_id)}
                  title="赞同这条补充"
                >
                  <span className="mp-note-up-ic" aria-hidden="true">▲</span>
                  {n._up}
                </button>
              </div>
            </div>
          ))}
        </div>

        {composing ? (
          <div className="mp-note-compose">
            <textarea
              className="mp-note-input"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="补充你知道的——典故、双关、被字幕吃掉的细节…"
              rows={3}
              autoFocus
            />
            <div className="mp-note-compose-actions">
              <button
                className="mp-note-cancel"
                onClick={() => { setComposing(false); setDraft(''); }}
              >取消</button>
              <button
                className="mp-note-submit"
                onClick={submitNote}
                disabled={!draft.trim()}
              >发布</button>
            </div>
          </div>
        ) : (
          <button className="mp-note-add" onClick={() => setComposing(true)}>
            <span aria-hidden="true">+</span> add your note
          </button>
        )}
      </div>

      {shareOpen && (
        <MemeShareCard riff={riff} onClose={() => setShareOpen(false)} />
      )}
    </div>
  );
}

// 单条 note 文本：默认 clamp 到约 3 行，溢出才出现「展开/收起」——
// 注释区不喧宾夺主，但长补充仍读得全。
function NoteText({ text }) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text]);

  return (
    <>
      <div ref={ref} className={`mp-note-text${expanded ? ' is-expanded' : ''}`}>
        {text}
      </div>
      {overflowing && (
        <button className="mp-note-more" onClick={() => setExpanded(e => !e)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </>
  );
}
