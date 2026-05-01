import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import './App.css';
import RelationshipGraph from './RelationshipGraph';
import SymbolHotspots from './SymbolHotspots';
import MemePanel from './MemePanel';
import MemeOverlay from './MemeOverlay';
import MemeToggle from './MemeToggle';
import DEMO_VIDEOS from './demoVideos';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';
// 视频源 CDN：生产环境一般是 Cloudflare R2；不设时回落到本地 Express 的 /uploads
const VIDEO_CDN = process.env.REACT_APP_VIDEO_CDN || API;

// 把 video.url（来自 /api/videos）解析成最终 src：
//   - 绝对 URL（http://... / https://...）→ 原样用
//   - 相对路径（/uploads/...）→ 前面补 VIDEO_CDN
// 这样不管后端返回相对还是绝对，前端都不会拼出 https://x/https://x/... 的破坏性结果
function resolveVideoSrc(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `${VIDEO_CDN}${url}`;
}

const HOME_NAV = ['首页', '发现', '我的列表', '社区'];

const HERO_FEATURES = [
  { id: 'hotspots', label: '剧情热点' },
  { id: 'graph',    label: '人物关系' },
  { id: 'memes',    label: '文化梗卡' },
  { id: 'clues',    label: '线索图谱' },
];

const HERO_CARD_CHIPS = [
  { id: 'graph', title: '人物关系', sub: '阿丽森与奈德的纠葛' },
  { id: 'memes', title: '文化梗',   sub: '瓦雷利亚钢的历史' },
  { id: 'tips',  title: '剧情提示', sub: '北境即将发生变故' },
];

const HERO_FEATURE_CARDS = [
  {
    id: 'memes',
    title: '文化梗卡片',
    desc: '一键了解剧中文化背景与历史细节。',
    sample: { title: '铁王座', tag: '文化梗',
      body: '维斯特洛七大王国的象征，由征服者伊耿使用瓦雷利亚钢铸造而成。' },
  },
  {
    id: 'graph',
    title: '人物关系图谱',
    desc: '可视化人物关系，理清复杂的权力与情感网络。',
  },
  {
    id: 'hotspots',
    title: '剧情热点注释',
    desc: 'AI 实时标注关键情节与伏笔，帮你不错过每个细节。',
    sample: [
      { t: '28:12', kind: '伏笔', tone: 'crit',  text: '瑟曦的表情暗示了她对权力的渴望。' },
      { t: '32:05', kind: '关键', tone: 'key',   text: '北境的信使带来了重要消息。' },
      { t: '34:47', kind: '疑问', tone: 'doubt', text: '这个角色的真实身份似乎并不简单。' },
    ],
  },
];

function heroFeatureIcon(id) {
  if (id === 'hotspots') return <IconHotspots />;
  if (id === 'graph')    return <IconHeroGraph />;
  if (id === 'memes')    return <IconHeroMeme />;
  if (id === 'clues')    return <IconHeroClues />;
  if (id === 'tips')     return <IconHeroClue />;
  return null;
}

export default function App() {
  const [videos, setVideos] = useState([]);
  const [featured, setFeatured] = useState(null);
  const [playing, setPlaying] = useState(null);
  const [search, setSearch] = useState('');
  const [notification, setNotification] = useState(null);

  const fetchVideos = useCallback(async () => {
    let list = [];
    try {
      const { data } = await axios.get(`${API}/api/videos`);
      if (Array.isArray(data)) list = data;
    } catch {
      // 后端不可达（典型：Vercel 静态部署没有配置 REACT_APP_API_URL）
      // 回落到打包进 bundle 的 demo 清单，让首页至少能播放展示视频
    }
    if (list.length === 0) list = DEMO_VIDEOS;
    setVideos(list);
  }, []);

  useEffect(() => { fetchVideos(); }, []);

  function notify(msg, type = 'success') {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3000);
  }

  const heroPreview = featured || videos[0];
  const enterPlayer = () => {
    if (!heroPreview) return;
    setFeatured(heroPreview);
    setPlaying(heroPreview);
  };

  return (
    <div className="app">
      {/* Notification */}
      {notification && (
        <div className={`notification ${notification.type}`}>
          {notification.type === 'success' ? '✓' : '✕'} {notification.msg}
        </div>
      )}

      {/* Navbar */}
      <nav className="navbar">
        <div className="nav-left">
          <div className="logo" onClick={() => setPlaying(null)}>
            <span className="logo-play">▶</span>
            <span className="logo-text">
              共谋者 <span className="logo-sep">|</span> Co-Conspirator
            </span>
          </div>
          <div className="searchbar">
            <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              placeholder="搜索作品、人物、文化梗、线索…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <span className="searchbar-kbd">⌘K</span>
          </div>
        </div>
        <div className="nav-center">
          {HOME_NAV.map((label, i) => (
            <span key={label} className={`nav-link ${i === 0 ? 'is-active' : ''}`}>
              {label}
            </span>
          ))}
        </div>
        <div className="nav-right">
          <button className="nav-icon-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
          </button>
          <div className="avatar">U</div>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero">
        <div className="hero-bg" />
        <div className="hero-content">
          <div className="hero-badge">
            <span className="star">★</span>
            AI 原生 · 长视频交互层
          </div>
          <h1 className="hero-title">共谋者</h1>
          <div className="hero-subtitle">Co-Conspirator</div>
          <p className="hero-desc">
            视频不再是一条线，而是一个可探索的世界。<br />
            共谋者将 AI 与长视频深度融合，让你在观看的同时<br />
            探索人物、线索、文化梗与剧情结构，发现更多可能。
          </p>
          <div className="hero-actions">
            <button className="btn-primary" onClick={enterPlayer}>
              <span>▶</span>
              立即体验
            </button>
            <button className="btn-secondary" onClick={enterPlayer}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="5" width="18" height="14" rx="2"/>
                <path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/>
              </svg>
              查看 Demo
            </button>
          </div>
          <div className="hero-features">
            {HERO_FEATURES.map(f => (
              <div key={f.id} className="hero-feature-pill">
                <span className="hero-feature-icon">{heroFeatureIcon(f.id)}</span>
                <span>{f.label}</span>
              </div>
            ))}
          </div>
        </div>

        {heroPreview && (
          <div className="hero-preview" onClick={enterPlayer}>
            <video
              key={heroPreview.id}
              src={`${resolveVideoSrc(heroPreview.url)}#t=60`}
              autoPlay loop muted playsInline
            />
            <div className="hero-preview-mask" />

            <div className="hero-preview-meta">
              <div className="hero-preview-title-row">
                <span className="hero-preview-name">龙之家族</span>
                <span className="hero-preview-ep">S1·E05</span>
              </div>
              <div className="hero-preview-sub">迎光赴礼</div>
              <div className="hero-preview-progress-text">已观看 32:18 / 51:42</div>
            </div>

            <button className="hero-preview-add" onClick={(e) => e.stopPropagation()}>
              <span>+</span> 加入列表
            </button>

            <div className="hero-card-chips" onClick={(e) => e.stopPropagation()}>
              {HERO_CARD_CHIPS.map(c => (
                <div key={c.id} className="hero-card-chip">
                  <span className="hero-card-chip-icon">{heroFeatureIcon(c.id)}</span>
                  <span className="hero-card-chip-text">
                    <span className="hero-card-chip-title">{c.title}</span>
                    <span className="hero-card-chip-sub">{c.sub}</span>
                  </span>
                </div>
              ))}
            </div>

            <div className="hero-preview-progress">
              <div className="hero-preview-progress-fill" />
              <div className="hero-preview-progress-thumb" />
            </div>

            <div className="hero-preview-controls" onClick={(e) => e.stopPropagation()}>
              <div className="hero-preview-controls-left">
                <button><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
                <button><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 17l-5-5 5-5"/><path d="M19 17l-5-5 5-5"/></svg></button>
                <button><svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/></svg></button>
                <span className="hero-preview-time">32:18 / 51:42</span>
              </div>
              <div className="hero-preview-controls-right">
                <button><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>
                <button><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82 2 2 0 1 1-2.83 2.83 1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33 2 2 0 1 1-2.83-2.83 1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82 2 2 0 1 1 2.83-2.83 1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33 2 2 0 1 1 2.83 2.83 1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
                <button><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Feature cards row */}
      <section className="feature-cards">
        {HERO_FEATURE_CARDS.map(card => (
          <div key={card.id} className="feature-card" onClick={enterPlayer}>
            <div className="feature-card-head">
              <h3>{card.title}</h3>
              <p>{card.desc}</p>
            </div>
            <div className="feature-card-body">
              {card.id === 'memes' && (
                <div className="meme-card-sample">
                  <div className="meme-card-thumb">
                    <span className="meme-card-thumb-glyph">⚔</span>
                  </div>
                  <div className="meme-card-body">
                    <div className="meme-card-title-row">
                      <span className="meme-card-title">{card.sample.title}</span>
                      <span className="meme-card-tag">{card.sample.tag}</span>
                    </div>
                    <div className="meme-card-desc">{card.sample.body}</div>
                    <div className="meme-card-link">查看详情 →</div>
                  </div>
                </div>
              )}
              {card.id === 'graph' && (
                <svg className="graph-sample" viewBox="0 0 280 150">
                  {/* 韦赛里斯（上）—雷尼拉（左）：父女 */}
                  <line x1="140" y1="42"  x2="80"  y2="84" />
                  {/* 韦赛里斯—阿莉森特（右）：夫妻 */}
                  <line x1="140" y1="42"  x2="200" y2="84" />
                  {/* 雷尼拉—戴蒙（下）：后来的婚姻 */}
                  <line x1="80"  y1="84"  x2="140" y2="120" />
                  {/* 阿莉森特—戴蒙：政敌 */}
                  <line x1="200" y1="84"  x2="140" y2="120" />
                  {/* 雷尼拉 ↔ 阿莉森特：黑绿之争（dashed） */}
                  <line x1="80"  y1="84"  x2="200" y2="84"  strokeDasharray="3 4" />
                  <g className="graph-sample-node"><circle cx="140" cy="42"  r="14"/><text x="140" y="24">韦赛里斯</text></g>
                  <g className="graph-sample-node"><circle cx="80"  cy="84"  r="14"/><text x="44"  y="88">雷尼拉</text></g>
                  <g className="graph-sample-node"><circle cx="200" cy="84"  r="14"/><text x="240" y="88">阿莉森特</text></g>
                  <g className="graph-sample-node"><circle cx="140" cy="120" r="14"/><text x="140" y="146">戴蒙</text></g>
                </svg>
              )}
              {card.id === 'hotspots' && (
                <ul className="hotspot-sample">
                  {card.sample.map((row, i) => (
                    <li key={i}>
                      <span className="hotspot-time">{row.t}</span>
                      <span className={`hotspot-tag hotspot-tag-${row.tone}`}>{row.kind}</span>
                      <span className="hotspot-text">{row.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ))}
      </section>

      {/* Tencent Video Player Page */}
      {playing && (
        <TencentPlayer
          playing={playing}
          videos={videos}
          onClose={() => setPlaying(null)}
          onSelect={setPlaying}
        />
      )}
    </div>
  );
}

/* Hero feature SVGs (used both in hero-features pill row and on the video card chips) */
function IconHotspots() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12h3l2-6 4 14 2-7 2 3h5"/>
  </svg>);
}
function IconHeroGraph() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="7" r="2.4"/><circle cx="18" cy="7" r="2.4"/>
    <circle cx="12" cy="17" r="2.4"/>
    <path d="M7.7 8.4 16.3 8.4 M7.5 9 11 15 M16.5 9 13 15"/>
  </svg>);
}
function IconHeroMeme() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3"  y="5" width="13" height="11" rx="1.6"/>
    <rect x="8"  y="9" width="13" height="11" rx="1.6"/>
  </svg>);
}
function IconHeroClues() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="6" cy="6"  r="2.4"/><circle cx="18" cy="6" r="2.4"/>
    <circle cx="12" cy="18" r="2.4"/>
    <path d="M7.6 7.5 11.2 16 M16.4 7.5 12.8 16 M8.4 6 H15.6"/>
  </svg>);
}
function IconHeroClue() {
  return (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l9 5v8l-9 5-9-5V8z"/>
    <path d="M9 11h6 M9 14h4"/>
  </svg>);
}

/* ─── Tencent Video Player Page ─────────────────────── */

function TencentPlayer({ playing, videos, onClose, onSelect }) {
  const [search, setSearch] = useState('');

  const videoRef = useRef(null);
  const [aiKb, setAiKb] = useState('');
  const [aiBehavior, setAiBehavior] = useState('normal');
  const [aiMessages, setAiMessages] = useState([]);
  const [aiInput, setAiInput] = useState('');
  const [aiDepth, setAiDepth] = useState('brief'); // 'brief' | 'deep'
  // 全屏模式：右边浮一个 icon 按钮，点击展开 AgentPanel 抽屉
  // （非全屏时 aside 里那块 chat 还在原位，无需此抽屉）
  const [aiChatOpen, setAiChatOpen] = useState(false);
  // 右栏 tab：'agent'（AI 助手）| 'meme'（文化梗）
  const [rightTab, setRightTab] = useState('agent');
  // 当 MemeOverlay 触发"展开详情"时，设置这个 id；MemePanel 监听后自动展开 + 滚动
  const [pendingExpandRiffId, setPendingExpandRiffId] = useState(null);
  // 文化注释总开关（localStorage 由 MemeToggle 自维护初值）
  const [memeEnabled, setMemeEnabled] = useState(true);
  // 没有 riffs 时直接隐藏 toggle —— fetch 一次同样的端点判断
  const [hasRiffs, setHasRiffs] = useState(false);
  // 鼠标长时间不动 → 隐藏底部进度条 + 顶部浮动按钮 + 鼠标本体；
  // 任意鼠标移动 / 进入播放区都立即恢复，鼠标离开播放区也立即隐藏。
  const [playerIdle, setPlayerIdle] = useState(false);
  const playerWrapRef = useRef(null);
  const idleTimerRef = useRef(null);
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setAiChatOpen(false);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  useEffect(() => {
    if (!aiChatOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setAiChatOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [aiChatOpen]);
  // 鼠标空闲 / 离开播放区 → 隐藏控件；任何 mousemove 立即恢复 + 重置 3 秒计时。
  useEffect(() => {
    const wrap = playerWrapRef.current;
    if (!wrap) return;
    const IDLE_MS = 3000;
    const wakeup = () => {
      setPlayerIdle(false);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => setPlayerIdle(true), IDLE_MS);
    };
    const sleep = () => {
      if (idleTimerRef.current) { clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
      setPlayerIdle(true);
    };
    wrap.addEventListener('mousemove', wakeup);
    wrap.addEventListener('mouseenter', wakeup);
    wrap.addEventListener('mouseleave', sleep);
    // 初始进入：等 3s 自动隐藏（避免开屏就盖一层 chrome）
    wakeup();
    return () => {
      wrap.removeEventListener('mousemove', wakeup);
      wrap.removeEventListener('mouseenter', wakeup);
      wrap.removeEventListener('mouseleave', sleep);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [playing.id]); // 视频换了重挂监听
  // 检测本视频是否有 riffs，决定 MemeToggle 是否显示
  useEffect(() => {
    if (!aiKb) { setHasRiffs(false); return; }
    fetch(`${API}/api/riffs?videoId=${encodeURIComponent(aiKb)}`)
      .then(r => r.json())
      .then(d => setHasRiffs((d.riffs || []).length > 0))
      .catch(() => setHasRiffs(false));
  }, [aiKb]);
  const [aiSending, setAiSending] = useState(false);
  const [aiOnScreenChars, setAiOnScreenChars] = useState([]);
  const [aiHoveredCharId, setAiHoveredCharId] = useState(null);
  const [aiFirstTimeChars, setAiFirstTimeChars] = useState({}); // { charId: timestamp }
  const aiSeenCharsRef = useRef(new Set());
  // 角色出场 / 状态变化 popup 队列（独立于 bbox 标签）
  const [aiAnnouncements, setAiAnnouncements] = useState([]); // [{id, type, name, subtitle}]
  const aiCharStateRef = useRef(new Map()); // charId → last seen short_identity（用于检测状态变化）
  const aiLastPopupAtRef = useRef(new Map()); // charId → ms timestamp of last popup（cooldown）
  const aiLogRef = useRef(null);
  const aiPrevTimeRef = useRef(0);
  const aiBehaviorTimerRef = useRef(null);

  // ─── 共谋者 · 机制 A：分支推演 ─────────────────────────────────
  const [branchPoints, setBranchPoints] = useState([]);            // [{branch_id, timestamp, label, options, ...}]
  const [branchCues, setBranchCues] = useState({});                // { branch_id: { headline, sub } } —— LLM 写的字幕旁白
  const [branchInvitation, setBranchInvitation] = useState(null);  // 到点了但用户还没点击"介入" —— 沉浸不打断
  const [branchPending, setBranchPending] = useState(null);        // 用户点击介入后才进入决策态
  const [branchChoice, setBranchChoice] = useState('');            // 用户选择字符串
  const [branchSimulation, setBranchSimulation] = useState('');    // 流式累积的"替代世界线"文本
  const [branchSimulating, setBranchSimulating] = useState(false);
  const [branchPhase, setBranchPhase] = useState('idle');          // idle | choose | simulate | done
  const branchTriggeredRef = useRef(new Set());                    // 已自动触发过的 branch_id —— 避免重复弹窗
  const branchInvitationTimerRef = useRef(null);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Discover available KBs once per video. Only activate if there's an EXACT
  // filename match — never fall back to some unrelated KB, which would render
  // fictional scene data over the wrong video.
  useEffect(() => {
    axios.get(`${API}/api/agent/kb`).then(r => {
      const list = r.data.videos || [];
      const base = (playing.filename || '').replace(/\.[^.]+$/, '');
      setAiKb(list.includes(base) ? base : '');
    }).catch(() => {});
  }, [playing.id]);

  // 拉本视频的分支决策点（共谋者机制 A）+ 让 LLM 给每个分支写一条旁白 cue
  useEffect(() => {
    branchTriggeredRef.current = new Set();
    setBranchCues({});
    if (!aiKb) { setBranchPoints([]); return; }
    let cancelled = false;
    axios.get(`${API}/api/agent/branch/list?videoId=${encodeURIComponent(aiKb)}`)
      .then(r => {
        if (cancelled) return;
        const pts = r.data.branch_points || [];
        setBranchPoints(pts);
        // 并行预拉每个分支的字幕旁白；返回了再 merge
        for (const bp of pts) {
          axios
            .get(`${API}/api/agent/branch/cue?videoId=${encodeURIComponent(aiKb)}&branchId=${encodeURIComponent(bp.branch_id)}`)
            .then(({ data }) => {
              if (cancelled) return;
              if (data?.headline && data?.sub) {
                setBranchCues(prev => ({ ...prev, [bp.branch_id]: { headline: data.headline, sub: data.sub } }));
              }
            })
            .catch(() => { /* 拉不到就用 DiegeticCue 内置 fallback */ });
        }
      })
      .catch(() => setBranchPoints([]));
    return () => { cancelled = true; };
  }, [aiKb]);

  // 监听 currentTime 越过 branch_point 时：不打断观看，只在屏幕一角放一个"你能介入"暗示
  // （视频继续播；用户点了 invitation 才暂停 + 打开决策模态）
  useEffect(() => {
    const v = videoRef.current;
    if (!v || branchPoints.length === 0) return;
    const onTime = () => {
      // 已经处于决策态 / 已经有未消化的邀请 → 不再叠加
      if (branchPhase !== 'idle' || branchInvitation) return;
      const now = v.currentTime;
      for (const bp of branchPoints) {
        if (branchTriggeredRef.current.has(bp.branch_id)) continue;
        if (now >= bp.timestamp && now < bp.timestamp + 1.5) {
          branchTriggeredRef.current.add(bp.branch_id);
          setBranchInvitation(bp);
          // 18 秒不点 → 默认错过这次"叙事窗口"，邀请 fade 掉
          if (branchInvitationTimerRef.current) clearTimeout(branchInvitationTimerRef.current);
          branchInvitationTimerRef.current = setTimeout(() => {
            setBranchInvitation(null);
          }, 18000);
          break;
        }
      }
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [branchPoints, branchPhase, branchInvitation]);

  // 用户点击 invitation → 进入决策态
  function acceptBranchInvitation() {
    const bp = branchInvitation;
    if (!bp) return;
    if (branchInvitationTimerRef.current) clearTimeout(branchInvitationTimerRef.current);
    const v = videoRef.current;
    if (v && !v.paused) v.pause();
    setBranchInvitation(null);
    setBranchPending(bp);
    setBranchChoice('');
    setBranchSimulation('');
    setBranchPhase('choose');
  }
  function dismissBranchInvitation() {
    if (branchInvitationTimerRef.current) clearTimeout(branchInvitationTimerRef.current);
    setBranchInvitation(null);
  }

  async function submitBranchChoice() {
    if (!branchPending || !branchChoice.trim() || branchSimulating) return;
    setBranchSimulating(true);
    setBranchPhase('simulate');
    setBranchSimulation('');
    try {
      const resp = await fetch(`${API}/api/agent/branch/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: aiKb,
          branchId: branchPending.branch_id,
          choice: branchChoice.trim(),
        }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let evtType = 'message', dataStr = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) evtType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }
          if (evtType === 'text') setBranchSimulation(prev => prev + (data.delta || ''));
          else if (evtType === 'done') { /* metadata only */ }
        }
      }
      setBranchPhase('done');
    } catch (err) {
      setBranchSimulation(`推演失败：${err.message}`);
      setBranchPhase('done');
    } finally {
      setBranchSimulating(false);
    }
  }

  function dismissBranch() {
    setBranchPending(null);
    setBranchChoice('');
    setBranchSimulation('');
    setBranchPhase('idle');
    const v = videoRef.current;
    if (v && v.paused) v.play().catch(() => {});
  }

  // 切视频时清掉分支状态
  useEffect(() => {
    branchTriggeredRef.current = new Set();
    setBranchInvitation(null);
    setBranchPending(null);
    setBranchChoice('');
    setBranchSimulation('');
    setBranchPhase('idle');
    if (branchInvitationTimerRef.current) clearTimeout(branchInvitationTimerRef.current);
  }, [playing.id]);

  // Track user-behavior signals (skip / fast_forward / rewind / pause) so
  // the agent can explain what was missed. Resets to 'normal' after 10s idle.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const bumpBehavior = (b) => {
      setAiBehavior(b);
      if (aiBehaviorTimerRef.current) clearTimeout(aiBehaviorTimerRef.current);
      aiBehaviorTimerRef.current = setTimeout(() => setAiBehavior('normal'), 10000);
    };
    const onTime = () => { aiPrevTimeRef.current = v.currentTime; };
    const onSeeked = () => {
      const delta = v.currentTime - aiPrevTimeRef.current;
      if (Math.abs(delta) < 2) return;
      bumpBehavior(delta > 0 ? 'skip' : 'rewind');
    };
    const onRate = () => {
      if (v.playbackRate > 1) bumpBehavior('fast_forward');
    };
    const onPause = () => bumpBehavior('pause');
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ratechange', onRate);
    v.addEventListener('pause', onPause);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('ratechange', onRate);
      v.removeEventListener('pause', onPause);
      if (aiBehaviorTimerRef.current) clearTimeout(aiBehaviorTimerRef.current);
    };
  }, []);

  // 人物识别改为按钮触发：点一次跑一次，标签自动 6 秒后消失。
  // 不再自动轮询 → 不会自动弹名字 / 状态变化 popup。
  const [aiRecognizing, setAiRecognizing] = useState(false);
  const aiClearLabelsTimerRef = useRef(null);

  const triggerRecognition = async () => {
    const v = videoRef.current;
    if (!v || v.readyState < 2 || !v.videoWidth || aiRecognizing) return;
    setAiRecognizing(true);
    try {
      const W = 640;
      const H = Math.max(1, Math.round(v.videoHeight / v.videoWidth * W));
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      canvas.getContext('2d').drawImage(v, 0, 0, W, H);
      const image = canvas.toDataURL('image/jpeg', 0.6);
      const t = v.currentTime;

      const { data } = await axios.post(`${API}/api/agent/characters/recognize`, {
        videoId: aiKb || null,
        t,
        image,
      }, { timeout: 30000 });
      setAiOnScreenChars(data.characters || []);

      // 6 秒后自动清掉标签 + popup
      if (aiClearLabelsTimerRef.current) clearTimeout(aiClearLabelsTimerRef.current);
      aiClearLabelsTimerRef.current = setTimeout(() => {
        setAiOnScreenChars([]);
      }, 6000);
    } catch (err) {
      // 静默对用户，但落到 console —— 之前因为跨域 canvas 污染 toDataURL
      // 抛了 SecurityError，被吞掉之后调试没线索。
      console.warn('[recognize] failed:', err?.message || err);
    }
    finally { setAiRecognizing(false); }
  };

  // 切视频时重置已见集合 + 清掉残留标签
  useEffect(() => {
    aiSeenCharsRef.current = new Set();
    aiCharStateRef.current = new Map();
    aiLastPopupAtRef.current = new Map();
    setAiOnScreenChars([]);
    setAiAnnouncements([]);
    if (aiClearLabelsTimerRef.current) clearTimeout(aiClearLabelsTimerRef.current);
  }, [playing.id]);

  // 首次出现：bbox 标签的 first-time 高亮（保持原行为）+ 触发独立 announcement popup
  useEffect(() => {
    const CONFIDENCE_THRESHOLD = 0.85;
    const POPUP_COOLDOWN_MS = 60_000;
    const POPUP_DURATION_MS = 3000;
    const now = Date.now();

    const newFirstTime = {};
    const newAnnouncements = [];

    for (const c of aiOnScreenChars) {
      const key = c.character_id || c.display_name;
      if (!key) continue;
      const conf = typeof c.confidence === 'number' ? c.confidence : 0;
      const lastPopup = aiLastPopupAtRef.current.get(key) || 0;
      const inCooldown = now - lastPopup < POPUP_COOLDOWN_MS;

      if (!aiSeenCharsRef.current.has(key)) {
        aiSeenCharsRef.current.add(key);
        newFirstTime[key] = now;
        // 独立 popup：只在 confidence 够 + 不在冷却 + 有名字时触发
        if (conf >= CONFIDENCE_THRESHOLD && !inCooldown && c.display_name) {
          newAnnouncements.push({
            id: `${key}-first-${now}`,
            type: 'first-appearance',
            name: c.display_name,
            subtitle: c.short_identity || null,
          });
          aiLastPopupAtRef.current.set(key, now);
        }
      } else {
        // 已知角色：检测 short_identity 变化（即 state_timeline 在 cursor 处发生变化）
        const prevIdentity = aiCharStateRef.current.get(key);
        const currIdentity = c.short_identity || null;
        if (
          prevIdentity != null && currIdentity != null && prevIdentity !== currIdentity &&
          conf >= CONFIDENCE_THRESHOLD && !inCooldown
        ) {
          newAnnouncements.push({
            id: `${key}-state-${now}`,
            type: 'state-change',
            name: c.display_name,
            subtitle: `现在：${currIdentity}`,
            previous: prevIdentity,
          });
          aiLastPopupAtRef.current.set(key, now);
        }
      }
      // 始终更新最近一次看到的 identity
      if (c.short_identity) aiCharStateRef.current.set(key, c.short_identity);
    }

    if (Object.keys(newFirstTime).length > 0) {
      setAiFirstTimeChars(prev => ({ ...prev, ...newFirstTime }));
    }
    if (newAnnouncements.length > 0) {
      setAiAnnouncements(prev => [...prev, ...newAnnouncements]);
    }

    // 清理 first-time 高亮（保持原 3s）
    let firstTimer = null;
    if (Object.keys(newFirstTime).length > 0) {
      firstTimer = setTimeout(() => {
        setAiFirstTimeChars(prev => {
          const copy = { ...prev };
          for (const k of Object.keys(newFirstTime)) delete copy[k];
          return copy;
        });
      }, 3000);
    }
    // 清理 announcement popup
    let popupTimer = null;
    if (newAnnouncements.length > 0) {
      const idsToRemove = new Set(newAnnouncements.map(a => a.id));
      popupTimer = setTimeout(() => {
        setAiAnnouncements(prev => prev.filter(a => !idsToRemove.has(a.id)));
      }, POPUP_DURATION_MS);
    }
    return () => {
      if (firstTimer) clearTimeout(firstTimer);
      if (popupTimer) clearTimeout(popupTimer);
    };
  }, [aiOnScreenChars]);

  // Auto-scroll chat to bottom on new message.
  useEffect(() => {
    if (aiLogRef.current) aiLogRef.current.scrollTop = aiLogRef.current.scrollHeight;
  }, [aiMessages, aiSending]);

  function clearAiMessages() {
    setAiMessages([]);
    setAiInput('');
  }

  async function submitAiQuestion(forcedQuestion) {
    const candidate = typeof forcedQuestion === 'string' ? forcedQuestion : aiInput;
    const q = candidate.trim();
    if (!q) { console.warn('[submitAiQuestion] aborted: empty input'); return; }
    if (aiSending) { console.warn('[submitAiQuestion] aborted: already sending'); return; }
    // 无 KB 也允许 —— 走纯视觉模式（图像 + 问题）
    const t = videoRef.current?.currentTime || 0;

    setAiMessages(prev => [
      ...prev,
      { role: 'user', text: q, t },
      { role: 'agent', text: '', source: 'loading', t, streaming: true },
    ]);
    setAiInput('');
    setAiSending(true);

    // 严格打字机：每 18ms 吐 1 个字。即使后端把整段一次性 flush 过来，
    // 前端仍然按"敲字"节奏呈现，不会出现"等几秒然后全砸出来"。
    // 仅当队列堆得很大时（>80 / >200）才允许小幅加速到 2 / 3 字，避免
    // 长回复的尾巴拖太久。stream 结束后让 tick 自己继续敲完队列。
    const TYPE_INTERVAL_MS = 18;
    let queue = '';
    let typing = false;
    const flushChunk = (chunk) => setAiMessages(prev => {
      const copy = prev.slice();
      const last = copy[copy.length - 1];
      if (last?.role === 'agent' && last.streaming) {
        copy[copy.length - 1] = { ...last, text: last.text + chunk };
      }
      return copy;
    });
    const tick = () => {
      if (!queue.length) { typing = false; return; }
      const n = queue.length > 200 ? 3 : queue.length > 80 ? 2 : 1;
      flushChunk(queue.slice(0, n));
      queue = queue.slice(n);
      typing = true;
      setTimeout(tick, TYPE_INTERVAL_MS);
    };
    const appendDelta = (delta) => {
      if (!delta) return;
      queue += delta;
      if (!typing) tick();
    };
    // stream 结束后让打字机自然敲完，不在 stream done 时立刻砸完。
    // finalize 等到队列真正排空 + 当前 tick 不在跑了，再把消息标记为
    // streaming=false（这时光标 / loading 才真正消失）。
    const finalizeMsg = (patch) => {
      const apply = () => {
        setAiMessages(prev => {
          const copy = prev.slice();
          const last = copy[copy.length - 1];
          if (last?.role === 'agent' && last.streaming) {
            copy[copy.length - 1] = { ...last, streaming: false, ...patch };
          }
          return copy;
        });
      };
      const wait = () => {
        if (queue.length || typing) setTimeout(wait, 40);
        else apply();
      };
      wait();
    };

    // 抓当前画面一起送给 LLM —— 让回答以图像为事实，KB 只作背景参考
    let imageDataUrl = null;
    const v = videoRef.current;
    if (v && v.videoWidth) {
      try {
        const W = 640;
        const H = Math.max(1, Math.round(v.videoHeight / v.videoWidth * W));
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        canvas.getContext('2d').drawImage(v, 0, 0, W, H);
        imageDataUrl = canvas.toDataURL('image/jpeg', 0.6);
      } catch { /* canvas tainted or other capture failure */ }
    }

    try {
      const lastQuestions = aiMessages
        .filter(m => m.role === 'user')
        .slice(-3)
        .map(m => m.text);
      // 完整最近 6 条交替（用户问 + AI 答），让模型看到上下文连贯性
      const lastExchanges = aiMessages
        .filter(m => (m.role === 'user' && m.text) || (m.role === 'agent' && m.text && !m.streaming))
        .slice(-6)
        .map(m => ({ role: m.role, text: m.text, t: m.t }));
      const resp = await fetch(`${API}/api/agent/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: aiKb || null,
          videoFile: playing.filename,
          t,
          previousTime: aiPrevTimeRef.current,
          question: q,
          behavior: aiBehavior,
          mode: 'casual',
          depth: aiDepth,
          image: imageDataUrl,
          session: { last_questions: lastQuestions, last_exchanges: lastExchanges },
        }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let meta = { cursor_time: t };
      let source = 'template';
      let provider = null;
      let model = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are delimited by a blank line.
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          let evtType = 'message', dataStr = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) evtType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }

          if (evtType === 'meta') meta = { ...meta, ...data };
          else if (evtType === 'text') appendDelta(data.delta || '');
          else if (evtType === 'done') {
            if (data.source) source = data.source;
            if (data.provider) provider = data.provider;
            if (data.model) model = data.model;
            finalizeMsg({ source, provider, model, t: meta.cursor_time });
          }
        }
      }
    } catch {
      finalizeMsg({ text: '流式请求失败，检查后端是否启动。', source: 'error' });
    } finally {
      setAiSending(false);
    }
  }


  return (
    <div className="tx-page">
      {/* Nav */}
      <nav className="tx-nav">
        <div className="tx-nav-section tx-nav-left">
          <div className="tx-logo" onClick={onClose}>
            <span className="tx-logo-icon">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </span>
            <span className="tx-logo-text">腾讯视频</span>
          </div>
          <a className="tx-nav-link">电视剧</a>
          <a className="tx-nav-link">电影</a>
          <a className="tx-nav-link">动漫 <span className="tx-caret">▾</span></a>
        </div>

        <div className="tx-search">
          <input
            placeholder="奔跑吧 第10季"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="tx-search-btn" aria-label="搜索">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
          </button>
        </div>

        <div className="tx-nav-section tx-nav-right">
          <NavIconBtn active label="会员专区" icon={<span className="tx-v-icon">V</span>} />
          <NavIconBtn label="游戏" icon={<IconGame />} />
          <NavIconBtn label="快捷访问" icon={<IconBolt />} />
          <NavIconBtn label="历史" icon={<IconHistory />} />
          <NavIconBtn label="创作" icon={<IconCreate />} />
          <NavIconBtn label="应用" icon={<IconApps />} />
          <button className="tx-download-btn">
            <IconDownloadSmall /> 下载客户端
          </button>
          <div className="tx-avatar-wrap">
            <div className="tx-avatar" />
            <span className="tx-vip-tag">VIP0</span>
          </div>
          <button className="tx-close" onClick={onClose} title="返回">✕</button>
        </div>
      </nav>

      {/* Main */}
      <main className="tx-main">
        <div className="tx-left">
          <div
            ref={playerWrapRef}
            className={`tx-player-wrap ${playerIdle ? 'is-idle' : ''}`}
          >
            <video
              ref={videoRef}
              key={playing.id}
              src={resolveVideoSrc(playing.url)}
              // 必须设 crossOrigin —— 否则跨域 CDN（R2）的帧被画进 canvas
              // 后会污染 canvas，triggerRecognition 里的 toDataURL 直接抛
              // SecurityError，「人物识别」按钮就静默失败了。R2 公共桶默认
              // 回 Access-Control-Allow-Origin: *，配 anonymous 即可走通。
              crossOrigin="anonymous"
              autoPlay
              className="tx-player-video"
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                if (v.paused) v.play(); else v.pause();
              }}
            />

            {/* top-right pill: 人物识别（按钮触发） */}
            <button
              className="tx-player-recognize-btn"
              onClick={triggerRecognition}
              disabled={aiRecognizing}
              title="识别画面里的人物（标签 6 秒后消失）"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="8" r="4"/>
                <path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>
              </svg>
              {aiRecognizing ? '识别中…' : '人物识别'}
            </button>

            {/* 右边浮 icon → 展开 AgentPanel 抽屉（常驻，与关系图/对谈同族） */}
            <button
                className={`tx-player-aichat-btn ${aiChatOpen ? 'is-open' : ''}`}
                onClick={() => setAiChatOpen(o => !o)}
                title={aiChatOpen ? '收起 AI 解说（ESC）' : '展开 AI 解说'}
              >
                {aiChatOpen ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="6" y1="6" x2="18" y2="18"/>
                    <line x1="18" y1="6" x2="6" y2="18"/>
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                  </svg>
                )}
                <span className="tx-player-aichat-btn-label">解说</span>
            </button>

            {aiChatOpen && (
              <>
                {/* 画面 scrim：点画面任意位置即关闭抽屉（与关系图 rg-scrim 同款交互） */}
                <div
                  className="tx-player-aichat-scrim"
                  onClick={() => setAiChatOpen(false)}
                />
                <div className="tx-player-aichat-drawer" onClick={e => e.stopPropagation()}>
                  <AgentPanel
                    behavior={aiBehavior}
                    messages={aiMessages}
                    input={aiInput}
                    setInput={setAiInput}
                    sending={aiSending}
                    onSubmit={submitAiQuestion}
                    logRef={aiLogRef}
                    depth={aiDepth}
                    setDepth={setAiDepth}
                    onClear={clearAiMessages}
                  />
                </div>
              </>
            )}

            {/* 出场 / 状态变化 announcement popup（独立于 bbox 标签） */}
            {aiAnnouncements.length > 0 && (
              <div className="tx-char-announce-stack">
                {aiAnnouncements.map(a => (
                  <div
                    key={a.id}
                    className={`tx-char-announce tx-char-announce-${a.type}`}
                  >
                    <div className="tx-char-announce-name">{a.name}</div>
                    {a.subtitle && (
                      <div className="tx-char-announce-subtitle">
                        {a.type === 'state-change' && a.previous
                          ? <><span className="tx-char-announce-prev">{a.previous}</span> → {a.subtitle.replace(/^现在：/, '')}</>
                          : a.subtitle}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Character labels overlay：
                - 首次出现 (3s 内)：自动显示标签，自动淡出
                - 之后：bbox 上有透明热点，鼠标悬停脸 → 显示标签；无 bbox 则不再显示
                - 始终可点（点标签或脸） → 详情卡 */}
            {aiOnScreenChars.length > 0 && (
              <div className="tx-char-overlay">
                {aiOnScreenChars.map((c, i) => {
                  const key = c.character_id || c.display_name || i;
                  const hasBbox = Array.isArray(c.bbox) && c.bbox.length === 4;
                  const isFirstTime = !!aiFirstTimeChars[c.character_id || c.display_name];
                  const isHovered = aiHoveredCharId === (c.character_id || c.display_name);
                  const visible = isFirstTime || isHovered;

                  // 1) 脸部 hover 热点（仅有 bbox 时；透明，不挡画面）
                  //    悬停 → 浮出姓名标签；不再有点击行为，档案改在关系图里看
                  const hotspot = hasBbox ? (
                    <div
                      key={`hot-${key}`}
                      className="tx-char-hotspot"
                      style={{
                        left: `${c.bbox[0] * 100}%`,
                        top: `${c.bbox[1] * 100}%`,
                        width: `${(c.bbox[2] - c.bbox[0]) * 100}%`,
                        height: `${(c.bbox[3] - c.bbox[1]) * 100}%`,
                      }}
                      onMouseEnter={() => setAiHoveredCharId(c.character_id || c.display_name)}
                      onMouseLeave={() => setAiHoveredCharId(null)}
                      title={c.display_name}
                    />
                  ) : null;

                  // 2) 标签本体（首次或悬停时显示）
                  if (!visible) return hotspot;

                  const labelStyle = hasBbox ? {
                    position: 'absolute',
                    left: `${((c.bbox[0] + c.bbox[2]) / 2) * 100}%`,
                    top: `${c.bbox[3] * 100}%`,
                    transform: 'translate(-50%, 8px)',
                  } : undefined;

                  return (
                    <React.Fragment key={key}>
                      {hotspot}
                      <div
                        className={`tx-char-label ${hasBbox ? 'tx-char-label-bbox' : 'tx-char-label-stack'} ${isFirstTime ? 'tx-char-label-first' : ''}`}
                        style={labelStyle}
                        onMouseEnter={() => hasBbox && setAiHoveredCharId(c.character_id || c.display_name)}
                        onMouseLeave={() => hasBbox && setAiHoveredCharId(null)}
                        title={c.display_name}
                      >
                        <div className="tx-char-label-name">{c.display_name}</div>
                        {c.short_identity && (
                          <div className="tx-char-label-identity">{c.short_identity}</div>
                        )}
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            )}

            {/* 共谋者 · 分支「叙事低语」—— 字幕由 LLM 按本场情绪现写 */}
            {branchInvitation && (
              <DiegeticCue
                headline={branchCues[branchInvitation.branch_id]?.headline}
                sub={branchCues[branchInvitation.branch_id]?.sub}
                onAccept={acceptBranchInvitation}
                onDismiss={dismissBranchInvitation}
              />
            )}

            {/* 共谋者 · 隐藏符号热点 —— 脉冲小点 + 角标 pill，点击查看深度解读 */}
            <SymbolHotspots videoId={aiKb} videoRef={videoRef} />


            {/* 人物关系图 v2 —— HUD 入口 + Focus Card，按真实 videoTime + 角色 KB 动态出图 */}
            <RelationshipGraph videoId={aiKb} videoRef={videoRef} />

            {/* 文化注释总开关 —— 没 riff 不显示 */}
            <MemeToggle
              enabled={memeEnabled}
              onChange={setMemeEnabled}
              hidden={!hasRiffs}
            />

            {/* 共谋者 · 文化梗浮层 —— 4 条 riff 命中时段：底部蒙板 + HTML 字幕 + 金色高亮 + hover 浮窗 */}
            <MemeOverlay
              videoId={aiKb}
              videoRef={videoRef}
              enabled={memeEnabled}
              onExpandRequest={(riffId) => {
                setRightTab('meme');
                setPendingExpandRiffId(riffId);
              }}
            />

            <PlayerControls
              videoRef={videoRef}
              videoId={aiKb}
              hasNext={videos.length > 1}
              onNext={() => {
                const idx = videos.findIndex(v => v.id === playing.id);
                if (idx >= 0 && idx < videos.length - 1) onSelect(videos[idx + 1]);
              }}
            />

          </div>

        </div>

        {/* Right info panel */}
        <aside className="tx-right">
          <div className="tx-title-row">
            <h1 className="tx-title" title={playing.name}>{playing.name || '未选择视频'}</h1>
            {episodeTag(playing.filename) && (
              <span className="tx-lang">{episodeTag(playing.filename)}</span>
            )}
            <span className="conspirator-badge" title="共谋者 · Co-Conspirator">
              共谋者
            </span>
          </div>

          {/* 右栏 tab 切换 */}
          <div className="tx-right-tabs">
            <button
              className={`tx-right-tab${rightTab === 'agent' ? ' is-active' : ''}`}
              onClick={() => setRightTab('agent')}
            >AI 助手</button>
            <button
              className={`tx-right-tab${rightTab === 'meme' ? ' is-active' : ''}`}
              onClick={() => setRightTab('meme')}
            >文化梗</button>
          </div>

          {rightTab === 'agent' && (
            <AgentPanel
              behavior={aiBehavior}
              messages={aiMessages}
              input={aiInput}
              setInput={setAiInput}
              sending={aiSending}
              onSubmit={submitAiQuestion}
              logRef={aiLogRef}
              depth={aiDepth}
              setDepth={setAiDepth}
              onClear={clearAiMessages}
            />
          )}
          {rightTab === 'meme' && (
            <MemePanel
              videoId={aiKb}
              videoRef={videoRef}
              expandRiffId={pendingExpandRiffId}
              onConsumeExpand={() => setPendingExpandRiffId(null)}
            />
          )}
        </aside>
      </main>

      {/* Floating side icons */}
      <div className="tx-floating">
        <button title="反馈"><IconFeedback /></button>
      </div>

      {/* 共谋者 · 机制 A：分支推演模态 */}
      {branchPending && (
        <BranchModal
          branch={branchPending}
          phase={branchPhase}
          choice={branchChoice}
          setChoice={setBranchChoice}
          simulation={branchSimulation}
          simulating={branchSimulating}
          onSubmit={submitBranchChoice}
          onDismiss={dismissBranch}
        />
      )}

      {/* 机制 B/C 不再全屏 —— 改成画面内浮层，挂在 .tx-player-wrap 里 */}
    </div>
  );
}

function NavIconBtn({ icon, label, active }) {
  return (
    <button className={`tx-nav-icon ${active ? 'active' : ''}`}>
      <span className="tx-nav-icon-svg">{icon}</span>
      <small>{label}</small>
    </button>
  );
}

/* ─── AI 导演注 Panel ─────────────────────────────────── */
function episodeTag(filename) {
  if (!filename) return null;
  const m1 = /s(\d{1,2})e(\d{1,2})/i.exec(filename);
  if (m1) return `S${m1[1].padStart(2, '0')}E${m1[2].padStart(2, '0')}`;
  const m2 = /[_-](\d{1,2})\.(mp4|mov|mkv|webm|m4v)$/i.exec(filename);
  if (m2) return `S01E${m2[1].padStart(2, '0')}`;
  return null;
}

const BEHAVIOR_LABEL = {
  normal: null,
  pause: '已暂停',
  skip: '刚快进',
  rewind: '刚回看',
  fast_forward: '倍速中',
  replay: '重看',
};

// 把 [事实]/[解读]/[推测] 标签的回答切成段。任何 tag 之前的纯文本视为 [事实]。
// 同一 tag 重复出现的话取第一段（system prompt 里要求每个 tag 最多一次）。
function parseTaggedAnswer(text) {
  if (!text) return [];
  const TAGS = ['[事实]', '[解读]', '[推测]'];
  const positions = [];
  for (const tag of TAGS) {
    const idx = text.indexOf(tag);
    if (idx !== -1) positions.push({ tag, idx });
  }
  positions.sort((a, b) => a.idx - b.idx);
  const segments = [];
  // 第一个 tag 之前的内容当作 [事实]
  if (positions.length === 0) {
    return [{ kind: '事实', text: text.trim() }];
  }
  if (positions[0].idx > 0) {
    const head = text.slice(0, positions[0].idx).trim();
    if (head) segments.push({ kind: '事实', text: head });
  }
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].idx : text.length;
    const body = text.slice(p.idx + p.tag.length, end).trim();
    if (body) segments.push({ kind: p.tag.slice(1, -1), text: body });
  }
  return segments;
}

// 三层标注 → 用字体色（+ 推测斜体）区分。Disco Elysium 风格：去掉小标签和左 border，
// 让回答像台词流动，而不是 UI 表格。

const QUICK_QUESTIONS = [
  '这个角色是谁',
  '解释这个镜头',
  '这是什么梗',
  '这句台词什么意思',
];

const DEPTH_OPTIONS = [
  { id: 'brief', label: '简明' },
  { id: 'deep',  label: '深挖' },
];

/* DE 风格 · 一行叙事（user / agent） —— 不要气泡，平面文本流。
   user：  你 — "..."           (你=白米色加粗 / 引文=暖灰斜体)
   agent： 导演注 — 三层标注     ([事实]暖灰 / [解读]灰蓝 / [推测]琥珀斜体) */
function DELine({ message }) {
  const m = message;
  if (m.role === 'user') {
    return (
      <div className="de-line de-line-user">
        <span className="de-name de-name-you">你</span>
        <span className="de-dash">—</span>
        <span className="de-body de-body-you">"{m.text}"</span>
      </div>
    );
  }
  const segs = m.text ? parseTaggedAnswer(m.text) : [];
  const showThinking = !m.text && m.streaming;
  return (
    <div className="de-line de-line-agent">
      <div className="de-body de-body-agent">
        {showThinking && <span className="de-thinking">思考中…</span>}
        {segs.map((s, i) => (
          <p key={i} className={`de-seg de-seg-${s.kind}`}>{s.text}</p>
        ))}
        {m.streaming && m.text && <span className="de-cursor">▍</span>}
      </div>
    </div>
  );
}

function AgentPanel({
  messages, input, setInput,
  sending, behavior, onSubmit, logRef,
  depth = 'brief', setDepth = () => {},
  onClear,
}) {
  const behaviorLabel = BEHAVIOR_LABEL[behavior];
  // 决策位的"重量"提示：深挖模式下选项标记成 weighted（橙红）
  const weighted = depth === 'deep';

  return (
    <div className="tx-agent-de">
      {/* 极淡侧栏页码（DE 是 01A11；这里沿用 S01·A05·turn 计数） */}
      <div className="tx-agent-de-rail" aria-hidden="true">
        <span className="tx-agent-de-page">S01·A05·{String(messages.length).padStart(2, '0')}</span>
      </div>

      {behaviorLabel && (
        <div className="tx-agent-de-behavior">{behaviorLabel}</div>
      )}

      {/* 上半区：纯阅读，纵向叙事流 —— scrollbar 走 .tx-agent-log（DE 风格 4px 细金线） */}
      <div ref={logRef} className="tx-agent-log tx-agent-de-log">
        {messages.length === 0 && (
          <div className="tx-agent-de-empty">
            随时问点什么，比如<em>"这个镜头什么意思"</em>、<em>"我刚才错过了什么"</em>
          </div>
        )}
        {messages.map((m, i) => <DELine key={i} message={m} />)}
      </div>

      {/* 下半区：决策位 —— 深度档 + 编号选项 + 自由输入 */}
      <div className="tx-agent-de-decision">
        <div className="tx-agent-de-depth">
          <span className="tx-agent-de-meta">深度</span>
          {DEPTH_OPTIONS.map(opt => (
            <button
              key={opt.id}
              className={`tx-agent-de-depth-btn ${depth === opt.id ? 'is-active' : ''}`}
              onClick={() => setDepth(opt.id)}
              disabled={sending}
            >{opt.label}</button>
          ))}
          {onClear && messages.length > 0 && (
            <button
              className="tx-agent-de-clear"
              onClick={onClear}
              disabled={sending}
              title="清空对话记录"
            >↺ 清空</button>
          )}
        </div>

        <div className="tx-agent-de-chips">
          {QUICK_QUESTIONS.map(q => (
            <button
              key={q}
              type="button"
              className={`tx-agent-de-chip ${weighted ? 'is-weighted' : ''}`}
              onClick={() => !sending && onSubmit(q)}
              disabled={sending}
              title="点击直接发送"
            >{q}</button>
          ))}
        </div>

        {/* 自由输入：平面下划线，不是实色卡片 */}
        <div className="tx-agent-de-input">
          <span className="tx-agent-de-prompt">你 —</span>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
            placeholder="问点什么……"
            disabled={sending}
          />
          <button
            className="tx-agent-de-send"
            onClick={() => onSubmit()}
            disabled={sending || !input.trim()}
          >发送</button>
        </div>
      </div>
    </div>
  );
}

/* ─── 共谋者 · 叙事低语（diegetic cue）────────────────────────
   分支点到来时不再用浮动卡片，而是从画面里浮出一句金色衬线字幕，
   像剧本身在对你低语。空格介入；ESC 视而不见。 */
function DiegeticCue({ headline, sub, onAccept, onDismiss }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        onAccept();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAccept, onDismiss]);

  // LLM 还没拉到时给一个静态兜底（演示时一般会在 branchInvitation 触发前就到位）
  const hl = headline || '这一秒，谁都没动。';
  const sb = sub || '你能动一下。';
  // headline 缺时（即使用 fallback）也避免空白；动画 key 让换 cue 时重放入场
  const animKey = `${hl}|${sb}`;

  return (
    <>
      <div className="diegetic-vignette" />
      <div
        className="diegetic-cue"
        onClick={onAccept}
        role="button"
        tabIndex={0}
        key={animKey}
      >
        <div className="diegetic-cue-rule" />
        <div className="diegetic-cue-line">{hl}</div>
        <div className="diegetic-cue-sub">{sb}</div>
        <div className="diegetic-cue-hint">空格　执笔　│　ESC　听凭史书既定</div>
      </div>
    </>
  );
}

/* ─── 共谋者 · 分支推演 · 羊皮卷风格 ───────────────────────── */
function BranchModal({ branch, phase, choice, setChoice, simulation, simulating, onSubmit, onDismiss }) {
  const isCustom = !branch.options.includes(choice) && choice.length > 0;
  return (
    <div className="branch-scroll-backdrop">
      <button className="branch-scroll-exit" onClick={onDismiss} title="ESC">
        <span className="branch-scroll-exit-mark">×</span>
        <span className="branch-scroll-exit-text">视而不见</span>
      </button>

      <div className="branch-scroll">
        <div className="branch-scroll-header">
          <div className="branch-scroll-eyebrow">{branch.decision_holder_display} · 此时此刻</div>
          <h2 className="branch-scroll-title">{branch.label}</h2>
          <div className="branch-scroll-rule" />
          <p className="branch-scroll-desc">{branch.description}</p>
        </div>

        {phase === 'choose' && (
          <>
            <div className="branch-scroll-question">若由你执笔 ——</div>
            <div className="branch-scroll-options">
              {branch.options.map((opt, i) => (
                <button
                  key={i}
                  className={`branch-scroll-option ${choice === opt ? 'selected' : ''}`}
                  onClick={() => setChoice(opt)}
                >
                  <span className="branch-scroll-option-marker">·</span>
                  <span className="branch-scroll-option-text">{opt}</span>
                </button>
              ))}
              <div className={`branch-scroll-option branch-scroll-option-custom ${isCustom ? 'selected' : ''}`}>
                <span className="branch-scroll-option-marker">·</span>
                <input
                  className="branch-scroll-option-custom-input"
                  placeholder="或者，写下未曾设想的那一种 ……"
                  value={isCustom ? choice : ''}
                  onChange={e => setChoice(e.target.value)}
                />
              </div>
            </div>
            <div className="branch-scroll-actions">
              <button
                className="branch-scroll-go"
                onClick={onSubmit}
                disabled={!choice.trim()}
              >
                <span>见证选择的代价</span>
                <span className="branch-scroll-go-mark">⟶</span>
              </button>
            </div>
          </>
        )}

        {(phase === 'simulate' || phase === 'done') && (
          <>
            <div className="branch-scroll-chosen">
              <span className="branch-scroll-chosen-mark">你的决断</span>
              <span className="branch-scroll-chosen-text">{choice}</span>
            </div>
            <div className="branch-scroll-simulation">
              <div className="branch-scroll-sim-eyebrow">
                ── 另一卷未定之史 ──{simulating && <span className="branch-scroll-typing"> · 渡鸦正在传信</span>}
              </div>
              <div className="branch-scroll-sim-body">
                {simulation || (simulating ? ' ' : '')}
                {simulating && simulation && <span className="branch-scroll-caret">▌</span>}
              </div>
            </div>
            <div className="branch-scroll-actions">
              <button
                className="branch-scroll-go"
                onClick={onDismiss}
                disabled={simulating && !simulation}
              >
                <span>{simulating ? '渡鸦未归 ……' : '接受既定命运'}</span>
                {!simulating && <span className="branch-scroll-go-mark">↺</span>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* Nav icons */
const IconGame = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="2" y="7" width="20" height="12" rx="4"/>
    <circle cx="8" cy="13" r="1" fill="currentColor"/>
    <circle cx="16" cy="13" r="1" fill="currentColor"/>
    <path d="M7 10v2M6 11h2"/>
  </svg>
);
const IconBolt = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/>
  </svg>
);
const IconHistory = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>
  </svg>
);
const IconCreate = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <rect x="2" y="6" width="14" height="12" rx="2"/>
    <polygon points="22 8 16 12 22 16 22 8" fill="currentColor"/>
  </svg>
);
const IconApps = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <rect x="3" y="3" width="7" height="7" rx="1.5"/>
    <rect x="14" y="3" width="7" height="7" rx="1.5"/>
    <rect x="3" y="14" width="7" height="7" rx="1.5"/>
    <rect x="14" y="14" width="7" height="7" rx="1.5"/>
  </svg>
);
const IconDownloadSmall = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
);
const IconFeedback = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);

/* ─── Custom Tencent-style player controls ───────────────── */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const QUALITIES = ['蓝光 4K', '超清 1080P', '高清 720P', '标清 480P'];
const SUBTITLES = ['中文', '日语', '关闭'];
const AUDIOS = ['默认', '国语', '日语'];
function fmtTime(s) {
  if (!s || !isFinite(s)) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function PlayerControls({ videoRef, videoId, hasNext, onNext }) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quality, setQuality] = useState('标清 480P');
  const [subtitle, setSubtitle] = useState('中文');
  const [audioTrack, setAudioTrack] = useState('默认');
  const [dragPreview, setDragPreview] = useState(null); // {time, leftPct} while dragging
  // 进度条 chapter ticks —— 来自 KB 的章节锚点（act + branch_point）。
  // 没 videoId / 后端 / KB 时静默为 []，进度条退化成普通 progress。
  const [chapters, setChapters] = useState([]);
  const [hoveredChapter, setHoveredChapter] = useState(null); // 整个 chapter 对象，含 t/label/kind

  const progressRef = useRef(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onLoaded = () => setDuration(v.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVol = () => { setVolume(v.volume); setMuted(v.muted); };
    const onRate = () => setRate(v.playbackRate);
    const onProgress = () => {
      if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1));
    };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onLoaded);
    v.addEventListener('durationchange', onLoaded);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('volumechange', onVol);
    v.addEventListener('ratechange', onRate);
    v.addEventListener('progress', onProgress);
    onLoaded(); onVol(); onRate();
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onLoaded);
      v.removeEventListener('durationchange', onLoaded);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('volumechange', onVol);
      v.removeEventListener('ratechange', onRate);
      v.removeEventListener('progress', onProgress);
    };
  }, [videoRef]);

  // 拉 /api/agent/timeline/season 当前集的 key_events，每条带 t="MM:SS" +
  // text + crit + from_kb；把 t 可解析的转成进度条 ticks。集级（无 t）
  // 事件留给后续的「前情提要」组件处理，进度条用不上。
  // 没 videoId / 后端不可达 / 没 KB 时静默置空，进度条退化成普通 progress。
  useEffect(() => {
    if (!videoId) { setChapters([]); return; }
    let cancelled = false;
    axios.get(`${API}/api/agent/timeline/season`, {
      params: { videoId, t: '0', showId: 'house-of-the-dragon', season: 1 },
      timeout: 8000,
    }).then(r => {
      if (cancelled) return;
      const cursor = r.data?.cursor_used;
      const ep = (r.data?.episodes || []).find(e =>
        cursor && String(cursor).endsWith(`E${String(e.ep_num).padStart(2, '0')}`)
      );
      const events = ep?.key_events || [];
      const all = [];
      for (const ev of events) {
        const m = typeof ev.t === 'string' && ev.t.match(/^(\d{1,2}):(\d{2})$/);
        if (!m) continue; // 没时间戳的集级事件跳过 —— 它们没法落到进度条上
        const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        all.push({
          t: sec,
          label: ev.text || '',
          kind: ev.crit ? 'crit' : (ev.from_kb ? 'kb' : 'manual'),
          scene_id: ev.scene_id || null,
        });
      }
      all.sort((a, b) => a.t - b.t);

      // 精简：crit 全保留（人工挑过的关键节点），KB/manual 离任何已保留
      // tick < MIN_GAP 秒的丢掉 —— 主要是杀掉同一分钟内连续 3-4 条 KB 解读
      // 在进度条上糊在一起的视觉拥堵。
      const MIN_GAP = 90;
      const kept = [];
      for (const tick of all) {
        if (tick.kind === 'crit') { kept.push(tick); continue; }
        if (kept.some(k => Math.abs(k.t - tick.t) < MIN_GAP)) continue;
        kept.push(tick);
      }
      setChapters(kept);
    }).catch(() => { if (!cancelled) setChapters([]); });
    return () => { cancelled = true; };
  }, [videoId]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play(); else v.pause();
  };
  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  };

  // Progress bar: single handler covers click AND drag. Dragging while paused
  // doesn't trigger layout thrash because we only update video.currentTime on
  // mouse move, and use a local preview state for UI.
  const timeFromClientX = (clientX) => {
    const v = videoRef.current;
    const bar = progressRef.current;
    if (!v || !bar || !v.duration) return null;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return { time: pct * v.duration, pct };
  };
  const onProgressMouseDown = (e) => {
    const hit = timeFromClientX(e.clientX);
    if (!hit) return;
    draggingRef.current = true;
    setDragPreview({ time: hit.time, leftPct: hit.pct * 100 });
    const v = videoRef.current;
    if (v) v.currentTime = hit.time;

    const onMove = (me) => {
      if (!draggingRef.current) return;
      const h = timeFromClientX(me.clientX);
      if (!h) return;
      setDragPreview({ time: h.time, leftPct: h.pct * 100 });
      if (videoRef.current) videoRef.current.currentTime = h.time;
    };
    const onUp = () => {
      draggingRef.current = false;
      setDragPreview(null);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const setPlayRate = (r) => {
    const v = videoRef.current;
    if (v) v.playbackRate = r;
    setSpeedMenuOpen(false);
  };
  const toggleFullscreen = () => {
    const wrap = videoRef.current?.parentElement;
    if (!wrap) return;
    if (!document.fullscreenElement) wrap.requestFullscreen?.();
    else document.exitFullscreen?.();
  };
  const togglePip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture?.();
    } catch { /* unsupported */ }
  };

  const playedPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0;
  const qualityShort = quality.split(' ').pop(); // "480P" from "标清 480P"

  return (
    <>
      <div className="tx-controls">
        <div className="tx-controls-progress-row">
          <span className="tx-controls-time">
            {fmtTime(dragPreview ? dragPreview.time : currentTime)}
          </span>
          <div
            ref={progressRef}
            className={`tx-controls-progress ${dragPreview ? 'is-dragging' : ''}`}
            onMouseDown={onProgressMouseDown}
          >
            <div className="tx-controls-progress-buffered" style={{ width: `${bufferedPct}%` }} />
            <div className="tx-controls-progress-played" style={{ width: `${playedPct}%` }} />
            {/* 章节 ticks：act = 灰色细条；branch = 橙色粗条（剧情分支锚点）。
                pointer-events: none 在 CSS 里关掉，让点击穿透到底下进度条仍能 seek。*/}
            {duration > 0 && chapters.map(c => {
              const left = Math.max(0, Math.min(100, (c.t / duration) * 100));
              return (
                <div
                  key={`${c.kind}-${c.t}`}
                  className={`tx-controls-progress-tick tx-controls-progress-tick-${c.kind}`}
                  style={{ left: `${left}%` }}
                  onMouseEnter={() => setHoveredChapter(c)}
                  onMouseLeave={() => setHoveredChapter(prev => prev === c ? null : prev)}
                />
              );
            })}
            <div className="tx-controls-progress-thumb" style={{ left: `${playedPct}%` }} />
            {dragPreview && (
              <div className="tx-controls-progress-tooltip" style={{ left: `${dragPreview.leftPct}%` }}>
                {fmtTime(dragPreview.time)}
              </div>
            )}
            {/* hover chapter 时显示 label tooltip（drag 时让位给时间 tooltip）*/}
            {!dragPreview && hoveredChapter && duration > 0 && (
              <div
                className={`tx-controls-progress-chapter-tip tx-controls-progress-chapter-tip-${hoveredChapter.kind}`}
                style={{ left: `${(hoveredChapter.t / duration) * 100}%` }}
              >
                <span className="tx-controls-progress-chapter-tip-time">{fmtTime(hoveredChapter.t)}</span>
                <span className="tx-controls-progress-chapter-tip-label">{hoveredChapter.label}</span>
              </div>
            )}
          </div>
          <span className="tx-controls-time">{fmtTime(duration)}</span>
        </div>

        <div className="tx-controls-row">
          <div className="tx-controls-left">
            <button className="tx-ctl-btn tx-ctl-play" onClick={togglePlay} title={playing ? '暂停' : '播放'}>
              {playing
                ? <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>}
            </button>
            {hasNext && (
              <button className="tx-ctl-btn" onClick={onNext} title="下一集">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
              </button>
            )}
          </div>

          <div className="tx-controls-middle" />

          <div className="tx-controls-right">
            <button className="tx-ctl-btn tx-ctl-text" title="语言">语言</button>
            <button className="tx-ctl-btn tx-ctl-text" title="画质">{qualityShort}</button>
            <div
              className="tx-ctl-speed"
              onMouseEnter={() => setSpeedMenuOpen(true)}
              onMouseLeave={() => setSpeedMenuOpen(false)}
            >
              <button className="tx-ctl-btn tx-ctl-text">
                {rate === 1 ? '倍速' : `${rate}x`}
              </button>
              {speedMenuOpen && (
                <div className="tx-ctl-speed-menu">
                  {SPEEDS.slice().reverse().map(r => (
                    <button
                      key={r}
                      className={r === rate ? 'active' : ''}
                      onClick={() => setPlayRate(r)}
                    >{r === 1 ? '1.0x（正常）' : `${r}x`}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="tx-ctl-volume">
              <button className="tx-ctl-btn" onClick={toggleMute} title="音量">
                {muted || volume === 0
                  ? <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12A4.5 4.5 0 0014 8.05v2.06l2.45 2.45c.03-.18.05-.37.05-.56zM19 12a7 7 0 01-.67 3l1.48 1.48A8.96 8.96 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.17v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                  : <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 8.05v7.9c1.48-.73 2.5-2.25 2.5-3.95zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>}
              </button>
              <div className="tx-ctl-volume-slider">
                <input
                  type="range" min="0" max="1" step="0.01"
                  value={muted ? 0 : volume}
                  onChange={e => {
                    const v = videoRef.current;
                    if (!v) return;
                    const val = parseFloat(e.target.value);
                    v.volume = val;
                    if (val > 0 && v.muted) v.muted = false;
                    if (val === 0 && !v.muted) v.muted = true;
                  }}
                />
              </div>
            </div>
            <div
              className="tx-ctl-settings"
              onMouseEnter={() => setSettingsOpen(true)}
              onMouseLeave={() => setSettingsOpen(false)}
            >
              <button className="tx-ctl-btn" title="设置">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>
                </svg>
              </button>
              {settingsOpen && (
                <div className="tx-ctl-settings-panel">
                  <SettingsSection label="清晰度" options={QUALITIES} value={quality} onChange={setQuality} />
                  <SettingsSection label="字幕" options={SUBTITLES} value={subtitle} onChange={setSubtitle} />
                  <SettingsSection label="音轨" options={AUDIOS} value={audioTrack} onChange={setAudioTrack} />
                </div>
              )}
            </div>
            <button className="tx-ctl-btn" onClick={togglePip} title="画中画">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="5" width="18" height="14" rx="2"/>
                <rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor"/>
              </svg>
            </button>
            <button className="tx-ctl-btn" title="网页全屏">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="6" width="18" height="12" rx="1"/>
              </svg>
            </button>
            <button className="tx-ctl-btn" onClick={toggleFullscreen} title="全屏">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SettingsSection({ label, options, value, onChange }) {
  return (
    <div className="tx-settings-section">
      <div className="tx-settings-label">{label}</div>
      <div className="tx-settings-options">
        {options.map(o => (
          <button
            key={o}
            className={o === value ? 'active' : ''}
            onClick={() => onChange(o)}
          >{o}</button>
        ))}
      </div>
    </div>
  );
}
