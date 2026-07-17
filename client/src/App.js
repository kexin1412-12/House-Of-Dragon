import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { Analytics } from '@vercel/analytics/react';
import './App.css';
import RelationshipGraph from './RelationshipGraph';
import StorylineXRay from './StorylineXRay';
import SymbolHotspots from './SymbolHotspots';
import MemePanel from './MemePanel';
import DiscussionPanel from './DiscussionPanel';
import MemeOverlay from './MemeOverlay';
import MemeToggle from './MemeToggle';
import InPlayerLoreCard from './InPlayerLoreCard';
import FavoritesView from './FavoritesView';
import DEMO_VIDEOS from './demoVideos';
import StanceCard from './StanceCard';
import useStanceTriggers from './useStanceTriggers';
import { getEpisodeConfig } from './episodes';
import {
  recordFactionChoice,
  recordRecallResolution,
  getChoices as getStanceChoices,
} from './stanceStore';

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

function resolveSubtitleSrc(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/uploads/')) return `${VIDEO_CDN}${url}`;
  return url;
}

function getVideoSubtitleTracks(video) {
  if (Array.isArray(video?.subtitles) && video.subtitles.length > 0) {
    return video.subtitles;
  }
  if (video?.subtitleUrl) {
    return [{
      src: video.subtitleUrl,
      srcLang: 'zh-CN',
      label: '简体中文',
      default: true,
    }];
  }
  return [];
}

function videoEpisodeTag(video) {
  return video?.episodeTag || episodeTag(video?.filename);
}

// 从 allTriggers + localStorage 选择记录拼出 AgentPanel "你的立场推演" 入口列表。
// 一项 = { trigger, choice }；只收 (a) trigger 配了 speculation.by_option (b) 用户
// 投的那个 option_id 在 by_option 里 —— 即 "与剧情不一样" 的选项。投了 canonical
// 那项不入这里。
function computeSpeculationEntries(allTriggers) {
  if (!allTriggers || allTriggers.length === 0) return [];
  const choices = getStanceChoices();
  const choiceByTrigger = {};
  for (const c of choices) choiceByTrigger[c.trigger_id] = c;
  const out = [];
  for (const tg of allTriggers) {
    const byOpt = tg.speculation?.by_option;
    if (!byOpt) continue;
    const ch = choiceByTrigger[tg.trigger_id];
    if (!ch) continue;
    if (!byOpt[ch.option_id]) continue;  // canonical / 非 by_option → 跳过
    out.push({ trigger: tg, choice: ch });
  }
  return out;
}

const HOME_NAV = [
  { label: '首页',     view: 'home' },
  { label: '发现',     view: null },
  { label: '我的收藏', view: 'favorites' },
  { label: '我的列表', view: null },
  { label: '社区',     view: null },
];

const HERO_FEATURES = [
  { id: 'hotspots', label: '剧情热点' },
  { id: 'graph',    label: '人物关系' },
  { id: 'memes',    label: '文化梗卡' },
  { id: 'clues',    label: '线索图谱' },
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
      { t: '08:27', kind: '关键', tone: 'key',   text: '奥托·海塔尔被解除「国王之手」职务。' },
      { t: '42:36', kind: '伏笔', tone: 'crit',  text: '阿莉森特首次身穿海塔尔家族绿色礼服入婚宴。' },
      { t: '55:07', kind: '疑问', tone: 'doubt', text: '克里斯顿在婚宴当众打死乔弗里——失控？预谋？' },
    ],
  },
];

// 人物关系示意图：S01 核心四角 + 家族肖像
const GRAPH_SAMPLE_NODES = [
  { id: 'viserys',  name: '韦赛里斯',  cx: 140, cy: 42,  portrait:
      '/kb/characters/face_refs/viserys_targaryen/default/fd_01_Viserys_I_Targaryen_Official_G.jpg',
    labelX: 140, labelY: 18 },
  { id: 'rhaenyra', name: '雷尼拉',    cx: 80,  cy: 84,  portrait:
      '/kb/characters/face_refs/rhaenyra_targaryen/adult/fd_01_Queen_Rhaenyra.jpg.jpg',
    labelX: 30,  labelY: 88 },
  { id: 'alicent',  name: '阿莉森特',  cx: 200, cy: 84,  portrait:
      '/kb/characters/face_refs/alicent_hightower/adult/fd_01_AlicentASfASInfobox.PNG.png',
    labelX: 250, labelY: 88 },
  { id: 'daemon',   name: '戴蒙',      cx: 140, cy: 120, portrait:
      '/kb/characters/face_refs/daemon_targaryen/default/fd_01_Daemon_Targaryen_S2_Infobox.pn.png',
    labelX: 140, labelY: 152 },
];

function heroFeatureIcon(id) {
  if (id === 'hotspots') return <IconHotspots />;
  if (id === 'graph')    return <IconHeroGraph />;
  if (id === 'memes')    return <IconHeroMeme />;
  if (id === 'clues')    return <IconHeroClues />;
  return null;
}

export default function App() {
  const [videos, setVideos] = useState([]);
  const [featured, setFeatured] = useState(null);
  const [playing, setPlaying] = useState(null);
  const [search, setSearch] = useState('');
  // 我的收藏页（覆盖首页 hero+grid，不影响 player）
  const [showFavorites, setShowFavorites] = useState(false);
  // 从收藏页"跳转片段"传给 player 的初始 seek + 自动展开 riff
  const [pendingSeekTime, setPendingSeekTime] = useState(null);
  const [pendingExpandRiffId, setPendingExpandRiffId] = useState(null);
  const [pendingRightTab, setPendingRightTab] = useState(null);

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

  useEffect(() => { fetchVideos(); }, [fetchVideos]);

  const heroEpisodes = [...videos].sort((a, b) => {
    const tagA = videoEpisodeTag(a) || '';
    const tagB = videoEpisodeTag(b) || '';
    return tagA.localeCompare(tagB, undefined, { numeric: true }) || String(a.name || '').localeCompare(String(b.name || ''));
  });
  const heroPreview = featured || heroEpisodes[heroEpisodes.length - 1] || videos[videos.length - 1];
  const enterPlayer = () => {
    if (!heroPreview) return;
    setFeatured(heroPreview);
    setPlaying(heroPreview);
  };

  return (
    <div className="app">
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
          {HOME_NAV.map(item => {
            const isActive =
              (item.view === 'favorites' && showFavorites) ||
              (item.view === 'home' && !showFavorites);
            const clickable = item.view !== null;
            return (
              <span
                key={item.label}
                className={`nav-link${isActive ? ' is-active' : ''}${clickable ? '' : ' is-disabled'}`}
                onClick={() => {
                  if (item.view === 'favorites') setShowFavorites(true);
                  if (item.view === 'home') setShowFavorites(false);
                }}
              >
                {item.label}
              </span>
            );
          })}
        </div>
        <div className="nav-right">
          <button
            className={`nav-fav-btn${showFavorites ? ' is-active' : ''}`}
            onClick={() => setShowFavorites(s => !s)}
            title="我的收藏"
          >
            <span className="nav-fav-icon">♥</span>
            <span>我的收藏</span>
          </button>
          <button className="nav-icon-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
          </button>
          <div className="avatar">U</div>
        </div>
      </nav>

      {/* Hero —— 在我的收藏页时隐藏 */}
      {!showFavorites && (<>
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
            <button className="btn-secondary" onClick={() => setShowFavorites(true)}>
              <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <path d="M12 21s-7-4.35-7-10a4.5 4.5 0 0 1 8-2.85A4.5 4.5 0 0 1 19 11c0 5.65-7 10-7 10z"/>
              </svg>
              我的收藏
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
          <div className="hero-preview-stack">
            <div className="hero-preview" onClick={enterPlayer}>
              <video
                key={heroPreview.id}
                src={`${resolveVideoSrc(heroPreview.url)}#t=60`}
                autoPlay loop muted playsInline
              />
              <div className="hero-preview-mask" />

              <div className="hero-preview-meta">
                <div className="hero-preview-title-row">
                  <span className="hero-preview-name">{heroPreview.name || '龙之家族'}</span>
                  {videoEpisodeTag(heroPreview) && (
                    <span className="hero-preview-ep">{videoEpisodeTag(heroPreview)}</span>
                  )}
                </div>
                <div className="hero-preview-sub">{heroPreview.episodeTitle || '长视频 AI 互动体验'}</div>
              </div>

              <button className="hero-preview-add" onClick={(e) => e.stopPropagation()}>
                <span>+</span> 加入列表
              </button>

              <button
                className="hero-preview-watch"
                onClick={(e) => { e.stopPropagation(); enterPlayer(); }}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M8 5v14l11-7z"/>
                </svg>
                立刻观看
              </button>
            </div>

            {heroEpisodes.length > 1 && (
              <div className="hero-episode-rail" aria-label="剧集切换">
                <div className="hero-episode-rail-head">
                  <span>选集</span>
                  <small>{heroEpisodes.length} 集可看</small>
                </div>
                <div className="hero-episode-list">
                  {heroEpisodes.map((video, index) => {
                    const active = video.id === heroPreview.id;
                    const tag = videoEpisodeTag(video) || `EP${String(index + 1).padStart(2, '0')}`;
                    return (
                      <button
                        key={video.id || video.filename || index}
                        className={`hero-episode-card${active ? ' is-active' : ''}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setFeatured(video);
                        }}
                      >
                        <span className="hero-episode-tag">{tag}</span>
                        <span className="hero-episode-title">{video.episodeTitle || video.name || '龙之家族'}</span>
                        {active && <span className="hero-episode-now">当前</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Feature cards row */}
      <section className="feature-cards">
        {HERO_FEATURE_CARDS.map(card => (
          <div key={card.id} className="feature-card">
            <div className="feature-card-head">
              <h3>{card.title}</h3>
              <p>{card.desc}</p>
            </div>
            <div className="feature-card-body">
              {card.id === 'memes' && (
                <div className="meme-card-sample">
                  <div className="meme-card-thumb">
                    <IronThroneArt />
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
                <svg className="graph-sample" viewBox="0 0 280 170">
                  <defs>
                    {GRAPH_SAMPLE_NODES.map(n => (
                      <clipPath key={n.id} id={`graph-sample-clip-${n.id}`}>
                        <circle cx={n.cx} cy={n.cy} r={15} />
                      </clipPath>
                    ))}
                  </defs>
                  {/* 实线：父女 / 夫妻 / 婚姻 / 政敌 */}
                  <line x1="140" y1="42"  x2="80"  y2="84" />
                  <line x1="140" y1="42"  x2="200" y2="84" />
                  <line x1="80"  y1="84"  x2="140" y2="120" />
                  <line x1="200" y1="84"  x2="140" y2="120" />
                  {/* 虚线：雷尼拉 ↔ 阿莉森特 黑绿之争 */}
                  <line x1="80"  y1="84"  x2="200" y2="84"  strokeDasharray="3 4" />
                  {GRAPH_SAMPLE_NODES.map(n => (
                    <g key={n.id} className="graph-sample-node">
                      <circle cx={n.cx} cy={n.cy} r={17} className="graph-sample-ring" />
                      <image
                        href={n.portrait}
                        xlinkHref={n.portrait}
                        x={n.cx - 15} y={n.cy - 15}
                        width={30} height={30}
                        preserveAspectRatio="xMidYMid slice"
                        clipPath={`url(#graph-sample-clip-${n.id})`}
                      />
                      <text x={n.labelX} y={n.labelY}>{n.name}</text>
                    </g>
                  ))}
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
      </>)}

      {/* 我的收藏页（覆盖 hero + feature-cards） */}
      {showFavorites && !playing && (
        <FavoritesView
          videos={videos}
          onClose={() => setShowFavorites(false)}
          onJumpToRiff={(video, riff, seek) => {
            setShowFavorites(false);
            setPendingExpandRiffId(riff.riff_id);
            setPendingRightTab('meme');
            setPendingSeekTime(seek ? riff.anchor.start_time : null);
            setFeatured(video);
            setPlaying(video);
          }}
        />
      )}

      {/* Tencent Video Player Page */}
      {playing && (
        <TencentPlayer
          key={playing.id}
          playing={playing}
          videos={videos}
          onClose={() => {
            setPlaying(null);
            setPendingSeekTime(null);
            setPendingExpandRiffId(null);
            setPendingRightTab(null);
          }}
          onSelect={video => {
            setFeatured(video);
            setPlaying(video);
          }}
          initialSeekTime={pendingSeekTime}
          initialExpandRiffId={pendingExpandRiffId}
          initialRightTab={pendingRightTab}
        />
      )}
      <Analytics />
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
/* 铁王座 stylized SVG illustration — sword crown over throne silhouette,
   used as the 文化梗卡片 thumbnail on the landing page. */
function IronThroneArt() {
  return (
    <svg className="iron-throne-art" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="throne-bg-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#1f1a14" />
          <stop offset="100%" stopColor="#0a0a0d" />
        </linearGradient>
        <linearGradient id="throne-blade-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#d6b572" />
          <stop offset="55%" stopColor="#b58a3e" />
          <stop offset="100%" stopColor="#5b4220" />
        </linearGradient>
        <radialGradient id="throne-glow" cx="50%" cy="38%" r="55%">
          <stop offset="0%"  stopColor="rgba(245,166,35,0.35)" />
          <stop offset="70%" stopColor="rgba(245,166,35,0)" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="100" height="100" fill="url(#throne-bg-grad)" />
      <rect x="0" y="0" width="100" height="100" fill="url(#throne-glow)" />

      {/* Top crown of swords — 7 blades fanning out */}
      <g fill="url(#throne-blade-grad)" stroke="#7a5a2a" strokeWidth="0.4" strokeLinejoin="miter">
        <polygon points="50,10  52,38  48,38" />
        <polygon points="38,14  44,40  40,40"  transform="rotate(-12 38 14)" />
        <polygon points="62,14  60,40  56,40"  transform="rotate(12 62 14)" />
        <polygon points="28,22  38,42  34,42"  transform="rotate(-22 28 22)" />
        <polygon points="72,22  66,42  62,42"  transform="rotate(22 72 22)" />
        <polygon points="20,32  32,46  28,46"  transform="rotate(-34 20 32)" />
        <polygon points="80,32  72,46  68,46"  transform="rotate(34 80 32)" />
      </g>

      {/* Throne body — wide trapezoid base + armrests */}
      <g fill="#2d2622" stroke="#7a5a2a" strokeWidth="0.6">
        <polygon points="22,46 78,46 82,80 18,80" />
        <rect x="20" y="62" width="8"  height="18" />
        <rect x="72" y="62" width="8"  height="18" />
      </g>

      {/* Embedded blade slits in the throne body */}
      <g stroke="#b58a3e" strokeWidth="0.7" strokeLinecap="round" opacity="0.85">
        <line x1="34" y1="50" x2="34" y2="74" />
        <line x1="42" y1="50" x2="42" y2="74" />
        <line x1="50" y1="50" x2="50" y2="74" />
        <line x1="58" y1="50" x2="58" y2="74" />
        <line x1="66" y1="50" x2="66" y2="74" />
      </g>

      {/* Floor shadow */}
      <ellipse cx="50" cy="84" rx="32" ry="3" fill="rgba(0,0,0,0.65)" />
    </svg>
  );
}

/* ─── Tencent Video Player Page ─────────────────────── */

function TencentPlayer({
  playing,
  videos,
  onClose,
  onSelect,
  initialSeekTime = null,
  initialExpandRiffId = null,
  initialRightTab = null,
}) {
  const [search, setSearch] = useState('');
  const subtitleTracks = getVideoSubtitleTracks(playing);

  const videoRef = useRef(null);
  const [aiKb, setAiKb] = useState('');
  const requestedVideoId = (playing.filename || '').replace(/\.[^.]+$/, '');
  const episodeConfig = getEpisodeConfig(aiKb || requestedVideoId);
  const [aiMessages, setAiMessages] = useState([]);
  const [aiInput, setAiInput] = useState('');
  const [aiDepth, setAiDepth] = useState('brief'); // 'brief' | 'deep'
  // 立场推演会话：null = 未开启；活跃时 free-text + chip 都路由到 /continue 端点
  // history 是 [{role:'user'|'assistant', content}] —— 给 server 续推 prompt 用
  const [speculationThread, setSpeculationThread] = useState(null);
  // 全屏模式：右边浮一个 icon 按钮，点击展开 AgentPanel 抽屉
  // （非全屏时 aside 里那块 chat 还在原位，无需此抽屉）
  const [aiChatOpen, setAiChatOpen] = useState(false);
  // 右栏 tab：'agent'（AI 助手）| 'meme'（文化梗）| 'discuss'（讨论）—— 可由 App.js 通过 prop 预设（从我的收藏跳进来时）
  const [rightTab, setRightTab] = useState(initialRightTab || 'agent');
  // 当 MemeOverlay 触发"展开详情"时，设置这个 id；MemePanel 监听后自动展开 + 滚动
  const [pendingExpandRiffId, setPendingExpandRiffId] = useState(initialExpandRiffId || null);
  // 当 SceneHotspots 触发"了解详情"指向 lore 卡时，设置这个 id；MemePanel 同样监听
  const [pendingExpandLoreId, setPendingExpandLoreId] = useState(null);
  // App 重新派发新的初始值时（player 已打开但用户又从收藏跳了一条），同步进来
  useEffect(() => { if (initialRightTab) setRightTab(initialRightTab); }, [initialRightTab]);
  useEffect(() => { if (initialExpandRiffId) setPendingExpandRiffId(initialExpandRiffId); }, [initialExpandRiffId]);
  // 初始 seek：从我的收藏跳进来时把视频拨到 riff 的 start_time
  useEffect(() => {
    if (initialSeekTime == null) return;
    const v = videoRef.current;
    if (!v) return;
    const seek = () => { try { v.currentTime = initialSeekTime; } catch {} };
    if (v.readyState >= 1) seek();
    else v.addEventListener('loadedmetadata', seek, { once: true });
    return () => { try { v.removeEventListener('loadedmetadata', seek); } catch {} };
  }, [initialSeekTime, playing.id]);
  // 共谋模式总开关：覆盖文化注释 + 符号热点 + 场景热点。localStorage 由 MemeToggle 自维护初值。
  const [conspiratorMode, setConspiratorMode] = useState(true);
  // 没有 riffs 时直接隐藏 toggle —— fetch 一次同样的端点判断
  const [hasRiffs, setHasRiffs] = useState(false);
  // 鼠标长时间不动 → 隐藏底部进度条 + 顶部浮动按钮 + 鼠标本体；
  // 任意鼠标移动 / 进入播放区都立即恢复，鼠标离开播放区也立即隐藏。
  const [playerIdle, setPlayerIdle] = useState(false);
  const playerWrapRef = useRef(null);
  const idleTimerRef = useRef(null);
  // 全屏状态：SceneHotspots → "了解详情" 时根据这个判断走外栏 MemePanel 还是画面内 InPlayerLoreCard
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 全屏 / 放大模式下被 SceneHotspots 触发的设定百科 id（独立于外栏的 pendingExpandLoreId）
  const [inlineLoreId, setInlineLoreId] = useState(null);

  // ─── 立场追踪 / Stance Tracking ───────────────────────────────────────
  // 关键转折点（戴蒙杀妻 / 私奔 / 绿裙登场）触发立场选择卡。选择存 localStorage。
  // 形态：画面左下角小浮层，**不暂停视频、不蒙黑** —— 看见就选，没看见就过。
  // 总开关跟共谋模式绑在一起：conspiratorMode=false 时整组功能下线。
  const stance = useStanceTriggers({ videoId: aiKb, videoRef, enabled: conspiratorMode });

  // 立场推演 —— 不再走单独的模态，结果直接喷到 AI 对话流里。
  // 推演的 per-option eligibility 直接从 trigger.speculation.by_option 读，
  // useStanceTriggers 拉的 trigger 配置里已经有这个字段。

  // 用户在 StanceCard 里选完 —— 立刻落盘（不论后续会不会展开推演）
  function handleStanceChoose(option) {
    const tg = stance.activeTrigger;
    if (!tg) return;
    if (tg.type === 'recall') {
      recordRecallResolution({
        trigger_id: tg.trigger_id,
        video_id: aiKb,
        prior_trigger_id: tg.requires_prior_choice,
        option_id: option.id,
        option_label: option.label,
        option_inner_voice: option.inner_voice,
        scene_label: tg.scene_label,
      });
    } else {
      recordFactionChoice({
        trigger_id: tg.trigger_id,
        video_id: aiKb,
        option_id: option.id,
        option_label: option.label,
        option_inner_voice: option.inner_voice,
        scene_label: tg.scene_label,
      });
    }
    // 不在这里 dismiss —— StanceCard 自己会显示 post-vote CTA，让用户决定
    // 是"展开推演"还是"关闭继续看"。
  }

  function handleStanceDismiss() {
    stance.dismiss();
  }

  // 用户在 StanceCard / AgentPanel / TrajectoryChart 任一处点了"展开推演" ——
  // 收掉立场卡，把推演直接喷到 AI 对话里（submitStanceSpeculation 自己会
  // 打开抽屉 + 切 analysis 模式）。
  function handleOpenSpeculation(trigger, choice) {
    stance.dismiss();
    submitStanceSpeculation(trigger, choice);
  }

  // 立场推演 chooser（panelMode='speculation'）用：拼一个 trigger_id → choice 的映射，
  // 让 chooser 卡上能标"已投"/"你的票"角标。每次 render 重读一次 localStorage 即可
  // —— 投票后立场卡 dismiss 也会触发 re-render，这里始终是新鲜的。
  function buildVotedMap() {
    const out = {};
    for (const c of getStanceChoices()) out[c.trigger_id] = c;
    return out;
  }

  useEffect(() => {
    const onFs = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      if (!fs) {
        setAiChatOpen(false);
        setInlineLoreId(null); // 退出全屏时关掉画面内 lore 浮层
      }
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

  // ─── 角色内心模态（AgentPanel 第二种模态）─────────────
  // 'analysis'  → 现有 AI 解析（QUICK_QUESTIONS + 自由问）
  // 'character' → 选一个在场角色，钻进 TA 的内心和 TA 对话
  const [panelMode, setPanelMode] = useState('analysis');
  const [charSelected, setCharSelected] = useState(null);     // { character_id, display_name, short_identity, core_traits }
  const [charCandidates, setCharCandidates] = useState([]);   // 当前场景里有 profile 的角色
  const [charSceneBeat, setCharSceneBeat] = useState(null);   // { scene_id, fact, reading, start_time, end_time }
  const [charMessages, setCharMessages] = useState([]);       // [{role, text, parsed, streaming, t}]
  const [charInput, setCharInput] = useState('');
  const [charSending, setCharSending] = useState(false);
  // { surface: string, depth: string, questions: [{text, stance}] }
  // 进入角色那一刻的"表层意识 + 💭 深层意识 + 3 个开场问题"（Martin POV 章节风）
  const [charOpening, setCharOpening] = useState({ surface: '', depth: '', questions: [] });
  const charLogRef = useRef(null);
  const charSceneIdRef = useRef(null);                        // 节流 refetch：只有 scene_id 变了才重拉
  const CHAR_TURN_LIMIT = 10;

  // ─── 共谋者 · 机制 A：分支推演 ─────────────────────────────────
  // 共谋者机制 A（DiegeticCue + BranchModal + branch_points / cue / list / simulate）已下线 ——
  // 与机制 B（StanceCard）功能重叠（同一时间窗内两种推演卡）。机制 B 用结构化三选项
  // + speculation，自由文本输入版本退场。

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
  }, [playing.id, playing.filename]);

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
  useEffect(() => {
    if (charLogRef.current) charLogRef.current.scrollTop = charLogRef.current.scrollHeight;
  }, [charMessages, charSending]);

  // 角色模态：实时跟着剧走
  // 1. 进入模态 / 切视频 → 立即拉一次
  // 2. 视频在播 → 监听 timeupdate，scene_id 变了才重拉（避免每秒打 API）
  // 进了角色对话流后（charSelected）保留 candidates 列表不再覆盖，避免对话中卡片消失；
  // 但 scene_beat 仍要刷新，让用户看到 AI 正在跟剧走。
  useEffect(() => {
    if (panelMode !== 'character') return;
    if (!aiKb) { setCharCandidates([]); setCharSceneBeat(null); return; }

    let cancelled = false;
    const apply = (d, { allowCandidates }) => {
      if (cancelled) return;
      if (allowCandidates && !charSelected) setCharCandidates(d.characters || []);
      setCharSceneBeat(d.scene_beat || null);
      charSceneIdRef.current = d.scene_id || null;
    };

    const v = videoRef.current;
    const t0 = v?.currentTime || 0;
    fetch(`${API}/api/agent/character/inner/list?videoId=${encodeURIComponent(aiKb)}&t=${t0}`)
      .then(r => r.json())
      .then(d => apply(d, { allowCandidates: true }))
      .catch(() => apply({ characters: [] }, { allowCandidates: true }));

    // timeupdate ~每 250ms 一次。节流：每 2s 试一次，并且只在 scene_id 真的变了时刷 candidates。
    let lastFetchAt = Date.now();
    const REFRESH_MS = 2000;
    const onTime = () => {
      const now = Date.now();
      if (now - lastFetchAt < REFRESH_MS) return;
      lastFetchAt = now;
      const t = v?.currentTime || 0;
      fetch(`${API}/api/agent/character/inner/list?videoId=${encodeURIComponent(aiKb)}&t=${t}`)
        .then(r => r.json())
        .then(d => {
          if (cancelled) return;
          const sceneChanged = d.scene_id && d.scene_id !== charSceneIdRef.current;
          if (sceneChanged && !charSelected) setCharCandidates(d.characters || []);
          setCharSceneBeat(d.scene_beat || null);
          charSceneIdRef.current = d.scene_id || charSceneIdRef.current;
        })
        .catch(() => { /* silent */ });
    };
    if (v) v.addEventListener('timeupdate', onTime);
    return () => {
      cancelled = true;
      if (v) v.removeEventListener('timeupdate', onTime);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelMode, aiKb, charSelected]);

  const FALLBACK_OPENING_QS = [
    { text: '你此刻在想什么？', stance: '血亲' },
    { text: '为什么不直说？',     stance: '王者' },
    { text: '你怕的是什么？',     stance: '审慎' },
  ];
  function clearCharMessages() {
    setCharMessages([]);
    setCharInput('');
    // 清空对话回到开场态：重新拉一次 opening（缓存命中即时返回）
    if (charSelected) fetchCharOpening(charSelected);
  }
  function exitCharacter() {
    setCharSelected(null);
    setCharMessages([]);
    setCharInput('');
    setCharOpening({ surface: '', depth: '', questions: [] });
  }
  // 流式拉开场：SSE 一边收 raw 文本一边解析 [表层]/[深层] 渲染（打字机），
  // 选项在 done 事件一次性 set，不打字。
  async function fetchCharOpening(c) {
    if (!c || !aiKb) return;
    const v = videoRef.current;
    const t = v?.currentTime || 0;

    // 内部打字机队列：拿到的 raw 增量先排队，每 18ms 吐 1-3 个字。
    // 即使 LLM 一次性把整段 flush 过来（缓存命中场景），前端也按"敲字"节奏呈现。
    let raw = '';
    let queue = '';
    let typing = false;
    const TYPE_INTERVAL_MS = 18;
    const tick = () => {
      if (!queue.length) { typing = false; return; }
      const n = queue.length > 200 ? 3 : queue.length > 80 ? 2 : 1;
      raw += queue.slice(0, n);
      queue = queue.slice(n);
      typing = true;
      const mono = parseStreamingMonologue(raw);
      // 流式过程中只更新 surface/depth；questions 等 done
      setCharOpening(prev => ({ ...prev, surface: mono.surface, depth: mono.depth }));
      setTimeout(tick, TYPE_INTERVAL_MS);
    };
    const enqueue = (delta) => {
      if (!delta) return;
      queue += delta;
      if (!typing) tick();
    };
    const waitTypewriterDone = () => new Promise(resolve => {
      const check = () => {
        if (!queue.length && !typing) resolve();
        else setTimeout(check, 30);
      };
      check();
    });

    try {
      const resp = await fetch(`${API}/api/agent/character/inner/starter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: aiKb, characterId: c.character_id, t }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let donePayload = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const evtBlock = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let evtType = 'message', dataStr = '';
          for (const line of evtBlock.split('\n')) {
            if (line.startsWith('event: ')) evtType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          let d;
          try { d = JSON.parse(dataStr); } catch { continue; }
          if (evtType === 'text') enqueue(d.delta || '');
          else if (evtType === 'done') donePayload = d;
        }
      }

      // 等打字机敲完最后一波再吐选项 —— 这样选项是"答完才出"的感觉
      await waitTypewriterDone();
      const finalQs = (donePayload && Array.isArray(donePayload.questions) && donePayload.questions.length)
        ? donePayload.questions : FALLBACK_OPENING_QS;
      setCharOpening(prev => ({
        surface: donePayload?.surface || prev.surface,
        depth: donePayload?.depth || prev.depth,
        questions: finalQs,
      }));
    } catch (err) {
      console.warn('[fetchCharOpening] failed:', err?.message || err);
      setCharOpening({ surface: '', depth: '', questions: FALLBACK_OPENING_QS });
    }
  }
  function pickCharacter(c) {
    setCharSelected(c);
    setCharMessages([]);
    setCharInput('');
    setCharOpening({ surface: '', depth: '', questions: [] });
    fetchCharOpening(c);
  }

  function clearAiMessages() {
    setAiMessages([]);
    setAiInput('');
    setSpeculationThread(null);
  }

  async function submitAiQuestion(forcedQuestion) {
    // 立场推演会话活跃时，free-text 和 chip 都接到续推端点，让 AI 留在那条
    // 假设世界线里继续推；用户点"结束推演"或主动 clear 才回到普通 chat。
    if (speculationThread) {
      return submitSpeculationFollowup(forcedQuestion);
    }
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

    // 抓当前画面一起送给 LLM。深挖档保留更多面部、纹样和道具细节；
    // 简明档也高于旧版 640px，避免银发角色和暗场被过度压缩后混淆。
    let imageDataUrl = null;
    const v = videoRef.current;
    if (v && v.videoWidth) {
      try {
        const W = aiDepth === 'deep' ? 960 : 768;
        const quality = aiDepth === 'deep' ? 0.82 : 0.74;
        const H = Math.max(1, Math.round(v.videoHeight / v.videoWidth * W));
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        canvas.getContext('2d').drawImage(v, 0, 0, W, H);
        imageDataUrl = canvas.toDataURL('image/jpeg', quality);
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
          question: q,
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

  // 立场推演 → 直接喷到 AI 对话流里（不再走单独的 SpeculationView 模态）。
  // 用户可以在同一对话窗口里继续追问 —— LLM 看得到完整 lastExchanges。
  // 完成时把 trigger/option/full text 落进 speculationThread，让后续 free-text
  // + chip 路由到 /continue 端点把这条假设世界线接着推下去。
  async function submitStanceSpeculation(trigger, choice) {
    if (aiSending) return;
    if (!trigger || !choice) return;

    // 抽屉打开 + 切到 analysis 模态（如果在角色内心模式里）
    setAiChatOpen(true);
    setPanelMode('analysis');

    const t = videoRef.current?.currentTime || 0;
    const userText = `立场推演 · ${trigger.scene_label} · 你选了：${choice.option_label}`;

    setAiMessages(prev => [
      ...prev,
      { role: 'user', text: userText, t, kind: 'speculation_request' },
      { role: 'agent', text: '', source: 'loading', t, streaming: true, kind: 'speculation' },
    ]);
    // 开启 thread；history 暂为空，初轮的 assistant 输出在 finalize 时塞进去
    setSpeculationThread({
      triggerId: trigger.trigger_id,
      optionId: choice.option_id,
      scene_label: trigger.scene_label,
      option_label: choice.option_label,
      history: [],
    });
    setAiSending(true);

    // 跟 submitAiQuestion 同款打字机
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
    const finalizeMsg = (patch) => {
      const apply = () => {
        let finalText = '';
        setAiMessages(prev => {
          const copy = prev.slice();
          const last = copy[copy.length - 1];
          if (last?.role === 'agent' && last.streaming) {
            finalText = last.text;
            const parsedQuestions = extractOpenQuestions(finalText);
            copy[copy.length - 1] = { ...last, streaming: false, kind: 'speculation', parsedQuestions, ...patch };
          }
          return copy;
        });
        // 把这一轮的 assistant 全文塞进 thread.history，给续推 prompt 用
        if (finalText) {
          setSpeculationThread(t => t ? {
            ...t,
            history: [...t.history, { role: 'assistant', content: finalText }],
          } : t);
        }
      };
      const wait = () => {
        if (queue.length || typing) setTimeout(wait, 40);
        else apply();
      };
      wait();
    };

    try {
      const resp = await fetch(`${API}/api/agent/stance/speculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: aiKb || null,
          triggerId: trigger.trigger_id,
          optionId: choice.option_id,
        }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let source = 'llm', provider = null, model = null;

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
          if (evtType === 'text') appendDelta(data.delta || '');
          else if (evtType === 'done') {
            if (data.source) source = data.source;
            if (data.provider) provider = data.provider;
            if (data.model) model = data.model;
            finalizeMsg({ source, provider, model });
          }
        }
      }
    } catch (err) {
      finalizeMsg({ text: `推演中断：${err?.message || '未知错误'}`, source: 'error' });
    } finally {
      setAiSending(false);
    }
  }

  // 立场推演续推：用户对开放问句继续问下去 / 自己写一句。
  // 调 /api/agent/stance/speculate/continue，把 thread.history 一起送过去；
  // 收到的输出再走打字机，结尾问句解析进 parsedQuestions，下一轮 chip。
  async function submitSpeculationFollowup(forcedQuestion) {
    const thread = speculationThread;
    if (!thread) return;
    if (aiSending) return;
    const candidate = typeof forcedQuestion === 'string' ? forcedQuestion : aiInput;
    const q = candidate.trim();
    if (!q) return;
    const t = videoRef.current?.currentTime || 0;

    setAiMessages(prev => [
      ...prev,
      { role: 'user', text: q, t, kind: 'speculation_followup' },
      { role: 'agent', text: '', source: 'loading', t, streaming: true, kind: 'speculation' },
    ]);
    setAiInput('');
    setSpeculationThread(prev => prev ? {
      ...prev,
      history: [...prev.history, { role: 'user', content: q }],
    } : prev);
    setAiSending(true);

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
    const finalizeMsg = (patch) => {
      const apply = () => {
        let finalText = '';
        setAiMessages(prev => {
          const copy = prev.slice();
          const last = copy[copy.length - 1];
          if (last?.role === 'agent' && last.streaming) {
            finalText = last.text;
            const parsedQuestions = extractOpenQuestions(finalText);
            copy[copy.length - 1] = { ...last, streaming: false, kind: 'speculation', parsedQuestions, ...patch };
          }
          return copy;
        });
        if (finalText) {
          setSpeculationThread(prev => prev ? {
            ...prev,
            history: [...prev.history, { role: 'assistant', content: finalText }],
          } : prev);
        }
      };
      const wait = () => {
        if (queue.length || typing) setTimeout(wait, 40);
        else apply();
      };
      wait();
    };

    try {
      const resp = await fetch(`${API}/api/agent/stance/speculate/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: aiKb || null,
          triggerId: thread.triggerId,
          optionId: thread.optionId,
          history: thread.history,
          question: q,
        }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let source = 'llm', provider = null, model = null;
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
          if (evtType === 'text') appendDelta(data.delta || '');
          else if (evtType === 'done') {
            if (data.source) source = data.source;
            if (data.provider) provider = data.provider;
            if (data.model) model = data.model;
            finalizeMsg({ source, provider, model });
          }
        }
      }
    } catch (err) {
      finalizeMsg({ text: `续推中断：${err?.message || '未知错误'}`, source: 'error' });
    } finally {
      setAiSending(false);
    }
  }

  function exitSpeculation() {
    setSpeculationThread(null);
  }

  // 角色内心：流式拿三层回应（说/心/潜）+ 三个跟问选项
  async function submitCharacterTurn(forcedQuestion) {
    if (!charSelected || !aiKb) return;
    const candidate = typeof forcedQuestion === 'string' ? forcedQuestion : charInput;
    const q = candidate.trim();
    if (!q) return;
    if (charSending) return;
    const userTurns = charMessages.filter(m => m.role === 'user').length;
    if (userTurns >= CHAR_TURN_LIMIT) return;

    const v = videoRef.current;
    const t = v?.currentTime || 0;

    setCharMessages(prev => [
      ...prev,
      { role: 'user', text: q, t },
      { role: 'agent', text: '', parsed: null, streaming: true, t },
    ]);
    setCharInput('');
    setCharSending(true);

    const TYPE_INTERVAL_MS = 18;
    let queue = '';
    let typing = false;
    const flushChunk = (chunk) => setCharMessages(prev => {
      const copy = prev.slice();
      const last = copy[copy.length - 1];
      if (last?.role === 'agent' && last.streaming) {
        const nextText = last.text + chunk;
        copy[copy.length - 1] = { ...last, text: nextText, parsed: parseCharacterReply(nextText) };
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
    const finalizeMsg = () => {
      const apply = () => setCharMessages(prev => {
        const copy = prev.slice();
        const last = copy[copy.length - 1];
        if (last?.role === 'agent' && last.streaming) {
          copy[copy.length - 1] = { ...last, streaming: false, parsed: parseCharacterReply(last.text) };
        }
        return copy;
      });
      const wait = () => {
        if (queue.length || typing) setTimeout(wait, 40);
        else apply();
      };
      wait();
    };

    try {
      const history = charMessages
        .filter(m => (m.role === 'user' && m.text) || (m.role === 'agent' && m.parsed?.say))
        .slice(-6)
        .map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          text: m.role === 'user' ? m.text : m.parsed.say,
        }));
      const resp = await fetch(`${API}/api/agent/character/inner/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: aiKb,
          characterId: charSelected.character_id,
          message: q,
          history,
          t,
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
          if (evtType === 'text') appendDelta(data.delta || '');
        }
      }
      finalizeMsg();
    } catch (err) {
      setCharMessages(prev => {
        const copy = prev.slice();
        const last = copy[copy.length - 1];
        if (last?.role === 'agent' && last.streaming) {
          copy[copy.length - 1] = {
            ...last,
            streaming: false,
            text: '回应失败：' + (err.message || ''),
            parsed: { say: '回应失败：' + (err.message || ''), think: null, sub: null, suggestions: [] },
          };
        }
        return copy;
      });
    } finally {
      setCharSending(false);
    }
  }


  return (
    <div className="tx-page">
      {/* Nav */}
      <nav className="tx-nav">
        <div className="tx-nav-section tx-nav-left">
          <div className="logo" onClick={onClose}>
            <span className="logo-play">▶</span>
            <span className="logo-text">
              共谋者 <span className="logo-sep">|</span> Co-Conspirator
            </span>
          </div>
          <button type="button" className="tx-nav-link">电视剧</button>
          <button type="button" className="tx-nav-link">电影</button>
          <button type="button" className="tx-nav-link">动漫 <span className="tx-caret">▾</span></button>
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
            >
              {subtitleTracks.map(track => (
                <track
                  key={`${track.srcLang}:${track.src}`}
                  kind="subtitles"
                  src={resolveSubtitleSrc(track.src)}
                  srcLang={track.srcLang}
                  label={track.label}
                  default={Boolean(track.default)}
                />
              ))}
            </video>

            {/* top-right toolbar: 人物识别 + 文化注释总开关（同一族 chrome，flex 排列） */}
            <div className="tx-player-toolbar">
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
              <MemeToggle
                enabled={conspiratorMode}
                onChange={setConspiratorMode}
                hidden={!hasRiffs}
              />
              {/* "立场轨迹"已并入下方叙事 X 光面板的"我的立场"tab，工具栏不再单设入口。 */}
            </div>

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
                  {panelMode === 'character' ? (
                    <CharacterPanel
                      episodeLabel={episodeConfig.railLabel}
                      selected={charSelected}
                      candidates={charCandidates}
                      sceneBeat={charSceneBeat}
                      opening={charOpening}
                      messages={charMessages}
                      input={charInput}
                      setInput={setCharInput}
                      sending={charSending}
                      logRef={charLogRef}
                      onPick={pickCharacter}
                      onSubmit={submitCharacterTurn}
                      onClear={clearCharMessages}
                      onExit={() => { setPanelMode('analysis'); exitCharacter(); }}
                      onBackToChooser={exitCharacter}
                      turnLimit={CHAR_TURN_LIMIT}
                    />
                  ) : panelMode === 'speculation' ? (
                    <SpeculationChooserPanel
                      episodeLabel={episodeConfig.railLabel}
                      triggers={stance.allTriggers}
                      voted={buildVotedMap()}
                      onPick={(tg, ch) => handleOpenSpeculation(tg, ch)}
                      onExit={() => setPanelMode('analysis')}
                    />
                  ) : (
                    <AgentPanel
                      episodeLabel={episodeConfig.railLabel}
                      quickQuestions={episodeConfig.quickQuestions}
                      messages={aiMessages}
                      input={aiInput}
                      setInput={setAiInput}
                      sending={aiSending}
                      onSubmit={submitAiQuestion}
                      logRef={aiLogRef}
                      depth={aiDepth}
                      setDepth={setAiDepth}
                      onClear={clearAiMessages}
                      onEnterCharacterMode={() => setPanelMode('character')}
                      onEnterSpeculationMode={() => setPanelMode('speculation')}
                      speculationEntries={computeSpeculationEntries(stance.allTriggers)}
                      onOpenSpeculation={handleOpenSpeculation}
                      speculationThread={speculationThread}
                      onExitSpeculation={exitSpeculation}
                    />
                  )}
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

            {/* 共谋者 · 隐藏符号热点 —— 脉冲小点 + 角标 pill，点击查看深度解读
                共谋模式关闭时整组下线（不轮询、不渲染） */}
            {conspiratorMode && (
              <SymbolHotspots
                videoId={aiKb}
                videoRef={videoRef}
                onCta={(cta) => {
                  // 迁移自旧 SceneHotspots 的三种行为
                  if (!cta) return;
                  if (cta.kind === 'lore' && cta.target_id) {
                    if (isFullscreen) {
                      setInlineLoreId(cta.target_id);
                    } else {
                      setRightTab('meme');
                      setPendingExpandLoreId(cta.target_id);
                    }
                  } else if (cta.kind === 'riff' && cta.target_id) {
                    setRightTab('meme');
                    setPendingExpandRiffId(cta.target_id);
                  } else if (cta.kind === 'callback') {
                    const v = videoRef.current;
                    if (!v) return;
                    // 同集回看：直接 seek。跨集 demo 阶段也按本集处理（TODO: 切视频）
                    if (cta.video_id && cta.video_id !== aiKb) {
                      console.warn('[cta callback] cross-episode jump not wired:', cta);
                    }
                    v.currentTime = cta.timestamp || 0;
                  }
                }}
              />
            )}


            {/* 人物关系图 —— 独立 HUD 入口（X 光内的"人物关系"tab 也保留） */}
            <RelationshipGraph videoId={aiKb} videoRef={videoRef} />

            {/* 共谋者 · 文化梗浮层 —— 4 条 riff 命中时段：底部蒙板 + HTML 字幕 + 金色高亮 + hover 浮窗 */}
            <MemeOverlay
              videoId={aiKb}
              videoRef={videoRef}
              videoUrl={resolveVideoSrc(playing.url)}
              enabled={conspiratorMode}
              onExpandRequest={(riffId) => {
                setRightTab('meme');
                setPendingExpandRiffId(riffId);
              }}
            />

            {/* 全屏模式下 cta 触发的设定百科浮层 —— 半透明、画面内右侧 */}
            <InPlayerLoreCard
              videoId={aiKb}
              loreId={isFullscreen ? inlineLoreId : null}
              onClose={() => setInlineLoreId(null)}
            />

            {/* 立场抉择卡 / 回顾卡 —— inline 浮层，挂在共谋模式下。
                StanceCard 自己根据 trigger.speculation.by_option[pickedId] 决定
                投后是否显示"展开推演"CTA —— 投了 canonical 选项不出 CTA。 */}
            {conspiratorMode && stance.activeTrigger && (
              <StanceCard
                trigger={stance.activeTrigger}
                priorChoice={stance.priorChoice}
                onChoose={handleStanceChoose}
                onDismiss={handleStanceDismiss}
                onOpenSpeculation={(trigger, choice) => handleOpenSpeculation(trigger, choice)}
              />
            )}

            <PlayerControls
              videoRef={videoRef}
              videoId={aiKb}
              subtitleTracks={subtitleTracks}
              season={playing.season || 1}
              hasNext={videos.some((video, index) => video.id === playing.id && index < videos.length - 1)}
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
            {videoEpisodeTag(playing) && (
              <span className="tx-lang">{videoEpisodeTag(playing)}</span>
            )}
            {videos.length > 1 && (
              <label className="tx-episode-picker">
                <span className="sr-only">选择剧集</span>
                <select
                  value={playing.id}
                  onChange={event => {
                    const selected = videos.find(video => video.id === event.target.value);
                    if (selected) onSelect(selected);
                  }}
                  aria-label="选择剧集"
                >
                  {videos.map(video => (
                    <option key={video.id} value={video.id}>
                      {videoEpisodeTag(video) || video.name}{video.episodeTitle ? ` · ${video.episodeTitle}` : ''}
                    </option>
                  ))}
                </select>
              </label>
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
            <button
              className={`tx-right-tab${rightTab === 'discuss' ? ' is-active' : ''}`}
              onClick={() => setRightTab('discuss')}
            >讨论</button>
          </div>

          {rightTab === 'agent' && (
            panelMode === 'character' ? (
              <CharacterPanel
                episodeLabel={episodeConfig.railLabel}
                selected={charSelected}
                candidates={charCandidates}
                sceneBeat={charSceneBeat}
                opening={charOpening}
                messages={charMessages}
                input={charInput}
                setInput={setCharInput}
                sending={charSending}
                logRef={charLogRef}
                onPick={pickCharacter}
                onSubmit={submitCharacterTurn}
                onClear={clearCharMessages}
                onExit={() => { setPanelMode('analysis'); exitCharacter(); }}
                onBackToChooser={exitCharacter}
                turnLimit={CHAR_TURN_LIMIT}
              />
            ) : panelMode === 'speculation' ? (
              <SpeculationChooserPanel
                episodeLabel={episodeConfig.railLabel}
                triggers={stance.allTriggers}
                voted={buildVotedMap()}
                onPick={(tg, ch) => handleOpenSpeculation(tg, ch)}
                onExit={() => setPanelMode('analysis')}
              />
            ) : (
              <AgentPanel
                episodeLabel={episodeConfig.railLabel}
                quickQuestions={episodeConfig.quickQuestions}
                messages={aiMessages}
                input={aiInput}
                setInput={setAiInput}
                sending={aiSending}
                onSubmit={submitAiQuestion}
                logRef={aiLogRef}
                depth={aiDepth}
                setDepth={setAiDepth}
                onClear={clearAiMessages}
                onEnterCharacterMode={() => setPanelMode('character')}
                onEnterSpeculationMode={() => setPanelMode('speculation')}
                speculationEntries={computeSpeculationEntries(stance.allTriggers)}
                onOpenSpeculation={handleOpenSpeculation}
                speculationThread={speculationThread}
                onExitSpeculation={exitSpeculation}
              />
            )
          )}
          {rightTab === 'meme' && (
            <MemePanel
              videoId={aiKb}
              videoRef={videoRef}
              expandRiffId={pendingExpandRiffId}
              onConsumeExpand={() => setPendingExpandRiffId(null)}
              expandLoreId={pendingExpandLoreId}
              onConsumeExpandLore={() => setPendingExpandLoreId(null)}
            />
          )}
          {rightTab === 'discuss' && (
            <DiscussionPanel videoId={aiKb} />
          )}
        </aside>
      </main>

      {/* 叙事 X 光 —— 视频下方常驻面板：关键事件 / 人物关系 / 本集符号 三 tab
          额外接受立场触发点 + onOpenStance：脉络图上每个投票点会画一个对话气泡 marker，
          点击就能弹出对应的立场卡。 */}
      <StorylineXRay
        videoId={aiKb}
        videoRef={videoRef}
        inline
        stanceTriggers={stance.allTriggers}
        onOpenStance={stance.openManually}
      />

      {/* Floating side icons */}
      <div className="tx-floating">
        <button title="反馈"><IconFeedback /></button>
      </div>

      {/* 机制 A 已下线（DiegeticCue + BranchModal）。
          机制 B/C 不再全屏 —— 改成画面内浮层，挂在 .tx-player-wrap 里 */}

      {/* 立场轨迹已并入叙事 X 光面板（"我的立场"tab），不再 body 级模态。 */}

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

// 把 [事实]/[解读]/[推测] 标签的回答切成段。任何 tag 之前的纯文本视为 [事实]。
// 同一 tag 重复出现的话取第一段（system prompt 里要求每个 tag 最多一次）。
function parseTaggedAnswer(text) {
  if (!text) return [];
  // 支持多次出现 —— 立场推演会有连续 [事实]→[解读]→[推测]→[事实]→...→[问] 分段。
  // 老版本只 indexOf 找第一次，后续段就被吃掉了；改成 global regex 扫所有位置。
  const TAG_RE = /\[(事实|解读|推测|问)\]/g;
  const positions = [];
  let m;
  while ((m = TAG_RE.exec(text)) !== null) {
    positions.push({ kind: m[1], idx: m.index, tagLen: m[0].length });
  }
  if (positions.length === 0) {
    return [{ kind: '事实', text: text.trim() }];
  }
  const segments = [];
  // 第一个 tag 之前的内容当作 [事实]
  if (positions[0].idx > 0) {
    const head = text.slice(0, positions[0].idx).trim();
    if (head) segments.push({ kind: '事实', text: head });
  }
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].idx : text.length;
    const body = text.slice(p.idx + p.tagLen, end).trim();
    if (body) segments.push({ kind: p.kind, text: body });
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

// 内在声音 → 4 类色块（和后端 VOICE_CATEGORY / CHAR_VOICES.cat 保持一致）
//   blue  理性   purple 情感   red 本能   amber 直觉
const VOICE_CAT = {
  // rhaenyra
  '王座算计': 'blue',  '龙血': 'red', '戴蒙留下的印': 'purple',
  // daemon
  '王座饥渴': 'blue', '哥哥的脸': 'purple',
  // alicent
  '父亲的钉子': 'blue', '母兽': 'red', '雷妮拉的旧脸': 'purple',
  // criston
  '誓言之锁': 'blue', '神木林之伤': 'purple', '白斗篷的重': 'red',
  // viserys
  '王者本分': 'blue', '衰朽': 'red', '父爱': 'purple',
  // 通用兜底
  '权衡': 'blue', '旧账': 'purple', '不祥': 'amber',
};
const STANCE_NAMES = ['王者', '血亲', '审慎', '火焰'];

// 立场推演结尾的开放问句抽取：服务端 prompt 要求结尾每个问句独占一段、以 ？/? 收尾。
// 倒着扫，连续遇到的"以问号结尾"段算开放问句，遇到非问句段就停。
function extractOpenQuestions(text) {
  if (!text) return [];
  const paragraphs = String(text).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = [];
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i];
    if (!/[？?]$/.test(p)) break;
    if (p.length < 6 || p.length > 200) break;
    out.unshift(p);
    if (out.length >= 3) break;
  }
  return out;
}

// 进入角色的开场流式 raw → { surface, depth }。每来一个 delta 都会调一次，
// 必须容忍部分输出（[深层] 还没出现 / 1./2./3. 还没出现）。
function parseStreamingMonologue(raw) {
  if (!raw) return { surface: '', depth: '' };
  // [表层] 之后到 [深层] 或 行首 1. 或文末
  const surfaceMatch = raw.match(/\[表层\]\s*([\s\S]*?)(?=\n\s*\[深层\]|\n\s*1[.、]|$)/);
  const depthMatch = raw.match(/\[深层\]\s*([\s\S]*?)(?=\n\s*1[.、]|$)/);
  return {
    surface: surfaceMatch ? surfaceMatch[1].trim() : '',
    depth: depthMatch ? depthMatch[1].trim() : '',
  };
}

// 角色内心 reply 解析。格式：
//   [说] outer line
//   [VOICE_NAME] inner voice paragraph
//   [VOICE_NAME] another voice paragraph (different cat)
//   [潜] subconscious (optional)
//   1. [立场] q1
//   2. [立场] q2
//   3. [立场] q3
//
// 流式中也要稳定渲染（每多收一个字符都重新解析一次）
function parseCharacterReply(text) {
  const empty = { say: '', voices: [], sub: '', suggestions: [] };
  if (!text) return empty;

  // 先把 questions 部分（行首 1./2./3.）从全文剥离出来
  const lines = text.split('\n');
  const out = { say: '', voices: [], sub: '', suggestions: [] };
  const stanceRe = new RegExp(`\\[(${STANCE_NAMES.join('|')})\\]`);
  const qLineRe = /^\s*([1-3])[.、:：]\s*(.+)$/;

  const bodyLines = [];
  for (const ln of lines) {
    const qm = ln.match(qLineRe);
    if (qm && stanceRe.test(qm[2])) {
      const sm = qm[2].match(stanceRe);
      const stance = sm ? sm[1] : null;
      const txt = qm[2].replace(stanceRe, '').replace(/^[\s\-:：]+/, '').trim();
      if (txt) out.suggestions.push({ text: txt, stance });
    } else {
      bodyLines.push(ln);
    }
  }
  out.suggestions = out.suggestions.slice(0, 3);

  const body = bodyLines.join('\n');
  // 找所有 [TAG] 位置（可能是"说"、"潜"、或任意中文 voice 名）
  const tagRe = /\[([^\]\n]{1,8})\]/g;
  const positions = [];
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    positions.push({ tag: m[1], start: m.index, end: m.index + m[0].length });
  }
  if (positions.length === 0) {
    out.say = body.trim();
    return out;
  }
  if (positions[0].start > 0) {
    const lead = body.slice(0, positions[0].start).trim();
    if (lead) out.say = lead;
  }

  // 旧检定标签 [困难:成功] 已废弃；如果还出现就剥掉
  const oldCheckRe = /^\s*\[(困难|中等|容易):(成功|失败)\]\s*/;

  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    const next = positions[i + 1];
    const segEnd = next ? next.start : body.length;
    let raw = body.slice(p.end, segEnd);
    raw = raw.replace(oldCheckRe, ''); // 容错：把残留的检定标签洗掉
    const seg = raw.trim();
    // 跳过纯检定标签 tag（不该是 voice）
    if (/^(困难|中等|容易):(成功|失败)$/.test(p.tag)) continue;
    if (p.tag === '说') {
      out.say = seg;
    } else if (p.tag === '潜') {
      out.sub = seg;
    } else if (/^[一-龥]{1,8}$/.test(p.tag)) {
      // 任意中文 1-8 字命名都视为 voice；颜色找不到时落 amber 兜底
      if (seg) out.voices.push({ name: p.tag, cat: VOICE_CAT[p.tag] || 'amber', text: seg });
    }
  }
  return out;
}

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
  sending, onSubmit, logRef,
  depth = 'brief', setDepth = () => {},
  onClear,
  onEnterCharacterMode,
  onEnterSpeculationMode,
  speculationEntries = [],
  onOpenSpeculation,
  speculationThread = null,
  onExitSpeculation,
  episodeLabel = 'EP',
  quickQuestions = QUICK_QUESTIONS,
}) {
  const weighted = depth === 'deep';
  const inSpeculation = !!speculationThread;
  // 在推演会话里：取最新一条 agent speculation 消息上 parser 抓出来的 1-3 个开放问句，
  // 用它们替换默认 quick chip，让用户一点就把这条假设世界线再往下推。
  const lastSpeculationMsg = inSpeculation
    ? [...messages].reverse().find(m => m.role === 'agent' && m.kind === 'speculation' && !m.streaming)
    : null;
  const followupQuestions = (lastSpeculationMsg?.parsedQuestions || []).filter(Boolean);

  return (
    <div className="tx-agent-de">
      {/* 极淡侧栏页码（DE 是 01A11；这里沿用 S01·A05·turn 计数） */}
      <div className="tx-agent-de-rail" aria-hidden="true">
        <span className="tx-agent-de-page">{episodeLabel}·{String(messages.length).padStart(2, '0')}</span>
      </div>

      {/* "你的立场推演" 入口行 —— 投过票且后端标记为可推演的场景才会出现这里 */}
      {speculationEntries.length > 0 && onOpenSpeculation && (
        <div className="tx-agent-de-spec">
          <div className="tx-agent-de-spec-label">
            <svg
              className="tx-agent-de-spec-icon"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M 8 14 L 8 9" />
              <path d="M 8 9 C 8 7 6 6 4 6 L 4 3" />
              <path d="M 8 9 C 8 7 10 6 12 6 L 12 3" />
              <path d="M 2.4 5 L 4 3 L 5.6 5" />
              <path d="M 10.4 5 L 12 3 L 13.6 5" />
            </svg>
            你的立场推演
            <span className="tx-agent-de-spec-count">{speculationEntries.length}</span>
          </div>
          <div className="tx-agent-de-spec-chips">
            {speculationEntries.map(({ trigger, choice }) => (
              <button
                key={trigger.trigger_id}
                className="tx-agent-de-spec-chip"
                onClick={() => onOpenSpeculation(trigger, choice)}
                title={`你投了：${choice.option_label} — 点击展开"如果走这条路"`}
              >
                <span className="tx-agent-de-spec-chip-scene">{trigger.scene_label}</span>
                <span className="tx-agent-de-spec-chip-arrow">→</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 上半区：纯阅读，纵向叙事流 —— scrollbar 走 .tx-agent-log（DE 风格 4px 细金线） */}
      <div ref={logRef} className="tx-agent-log tx-agent-de-log">
        {messages.length === 0 && (
          <div className="tx-agent-de-empty">
            随时问点什么，比如<em>"这个镜头什么意思"</em>、<em>"她为什么沉默"</em>
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

        {inSpeculation && (
          <div className="tx-agent-de-spec-active">
            <span className="tx-agent-de-spec-active-label">
              推演中 · {speculationThread.scene_label} · 你选了：{speculationThread.option_label}
            </span>
            {onExitSpeculation && (
              <button
                type="button"
                className="tx-agent-de-spec-active-exit"
                onClick={() => !sending && onExitSpeculation()}
                disabled={sending}
                title="结束这条假设世界线，回到普通解析"
              >结束推演</button>
            )}
          </div>
        )}

        <div className="tx-agent-de-chips">
          {inSpeculation
            ? followupQuestions.map((q, i) => (
                <button
                  key={`spq-${i}`}
                  type="button"
                  className="tx-agent-de-chip tx-agent-de-chip-spec"
                  onClick={() => !sending && onSubmit(q)}
                  disabled={sending}
                  title="顺着这个问题让 AI 继续往下推"
                >{q}</button>
              ))
            : (
              <>
                {quickQuestions.map(q => (
                  <button
                    key={q}
                    type="button"
                    className={`tx-agent-de-chip ${weighted ? 'is-weighted' : ''}`}
                    onClick={() => !sending && onSubmit(q)}
                    disabled={sending}
                    title="点击直接发送"
                  >{q}</button>
                ))}
                {onEnterCharacterMode && (
                  <button
                    type="button"
                    className="tx-agent-de-chip tx-agent-de-chip-mode"
                    onClick={() => !sending && onEnterCharacterMode()}
                    disabled={sending}
                    title="钻进角色脑子里和 TA 对话"
                  >角色内心</button>
                )}
                {onEnterSpeculationMode && (
                  <button
                    type="button"
                    className="tx-agent-de-chip tx-agent-de-chip-mode tx-agent-de-chip-spec-mode"
                    onClick={() => !sending && onEnterSpeculationMode()}
                    disabled={sending}
                    title="不必先投票 —— 挑一个分支点，推演一条没走的路"
                  >立场推演</button>
                )}
              </>
            )}
        </div>

        {/* 自由输入：平面下划线，不是实色卡片 */}
        <div className="tx-agent-de-input">
          <span className="tx-agent-de-prompt">你 —</span>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
            placeholder={inSpeculation ? '继续追问，让 AI 把这条路再推一步……' : '问点什么……'}
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

/* ─── 角色内心 · AgentPanel 的第二种模态 ────────────────────────
   未选角色 → 渲染 chooser；选定后 → 渲染对话流 + 三个跟问选项。
   外观沿用 AgentPanel 的容器，避免在画面上出现风格断层。 */
function CharacterPanel({
  episodeLabel = 'EP',
  selected, candidates, sceneBeat,
  opening = { monologue: '', questions: [] },
  messages, input, setInput,
  sending, logRef,
  onPick, onSubmit, onClear, onExit, onBackToChooser,
  turnLimit = 10,
}) {
  const userTurns = messages.filter(m => m.role === 'user').length;
  const reachedLimit = userTurns >= turnLimit;
  const lastAgent = [...messages].reverse().find(m => m.role === 'agent' && m.parsed);
  const replySuggestions = (lastAgent?.parsed?.suggestions || []).filter(Boolean);
  // 还没问过 → 用开场 opening.questions；问过一轮以上 → 用上一回 [问] 跟问
  const isOpening = userTurns === 0;
  const suggestions = isOpening ? (opening.questions || []) : replySuggestions;
  const surface = (opening.surface || '').trim();
  const depth = (opening.depth || '').trim();
  const hasOpening = !!(surface || depth);
  const beatTs = sceneBeat?.start_time != null
    ? `${Math.floor(sceneBeat.start_time / 60)}:${String(Math.floor(sceneBeat.start_time % 60)).padStart(2, '0')}`
    : null;

  return (
    <div className="tx-agent-de tx-char-mode">
      <div className="tx-agent-de-rail" aria-hidden="true">
        <span className="tx-agent-de-page">{episodeLabel}·{String(messages.length).padStart(2, '0')}</span>
      </div>

      {/* 顶部：模态切换 + 当前所选角色头牌 */}
      <div className="tx-char-header">
        <button
          className="tx-char-back"
          onClick={onExit}
          title="回到 AI 解析"
        >‹ 解析模式</button>
        {selected ? (
          <div className="tx-char-title">
            <div className="tx-char-name">{selected.display_name}</div>
            {selected.short_identity && (
              <div className="tx-char-status">{selected.short_identity}</div>
            )}
          </div>
        ) : (
          <div className="tx-char-title">
            <div className="tx-char-name tx-char-name-dim">在场角色 · 选一个进入 TA 的内心</div>
          </div>
        )}
        {selected && (
          <button
            className="tx-char-switch"
            onClick={onBackToChooser}
            title="换一个角色"
          >换一个</button>
        )}
      </div>

      {/* 实时节拍提示：让用户看见 AI 在跟着剧走（每 2s 更新） */}
      {(sceneBeat?.fact || sceneBeat?.reading) && (
        <div className="tx-char-beat" title="AI 此刻看到的画面情境">
          {beatTs && <span className="tx-char-beat-ts">{beatTs}</span>}
          <div className="tx-char-beat-body">
            {sceneBeat?.fact && (
              <div className="tx-char-beat-fact">{sceneBeat.fact}</div>
            )}
            {sceneBeat?.reading && (
              <div className="tx-char-beat-reading">{sceneBeat.reading}</div>
            )}
          </div>
        </div>
      )}

      {/* 中区：未选 → chooser；已选 → narrative log */}
      {!selected ? (
        <div className="tx-char-chooser">
          {candidates.length === 0 ? (
            <div className="tx-agent-de-empty">
              当前画面里暂时没有可进入内心的角色。继续看下去，或回到<em>解析模式</em>。
            </div>
          ) : (
            <div className="tx-char-grid">
              {candidates.map(c => (
                <button
                  key={c.character_id}
                  type="button"
                  className={`tx-char-card${c.in_frame ? ' is-in-frame' : ''}`}
                  onClick={() => onPick(c)}
                  title={c.in_frame ? '此刻就在画面里' : '在最近这段戏里出现过'}
                >
                  <div className="tx-char-card-name">
                    {c.display_name}
                    {c.in_frame && <span className="tx-char-card-pulse" aria-hidden="true">●</span>}
                  </div>
                  {c.short_identity && (
                    <div className="tx-char-card-id">{c.short_identity}</div>
                  )}
                  {c.core_traits?.length > 0 && (
                    <div className="tx-char-card-traits">
                      {c.core_traits.slice(0, 3).join(' · ')}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div ref={logRef} className="tx-agent-log tx-agent-de-log tx-char-log">
          {/* 进入角色的开场：[表层] 长段散文 + 💭 [深层] 长段散文 + "你想问他什么？" CTA。
              用户问出第一个问题后 CTA 收掉，独白本身保留在对话流上方。 */}
          {hasOpening && (
            <div className="tx-char-opening">
              {surface && (
                <>
                  <div className="tx-char-opening-header">[内心独白]</div>
                  <div className="tx-char-opening-surface">{surface}</div>
                </>
              )}
              {depth && (
                <>
                  <div className="tx-char-opening-header tx-char-opening-header-depth">
                    <span className="tx-char-opening-bullet" aria-hidden="true">💭</span>
                    深层意识
                  </div>
                  <div className="tx-char-opening-depth">{depth}</div>
                </>
              )}
              {isOpening && (
                <div className="tx-char-opening-cta">你想问他什么？</div>
              )}
            </div>
          )}
          {messages.length === 0 && !hasOpening && (
            <div className="tx-agent-de-empty">
              问点什么 —— <em>"你恨她吗？"</em>、<em>"你为什么不直接走？"</em>。<br/>
              你看到的是 TA 此刻能告诉你的全部，再往后的事 TA 也还不知道。
            </div>
          )}
          {messages.map((m, i) => <CharLine key={i} message={m} speakerName={selected.display_name} />)}
        </div>
      )}

      {/* 下区：决策位 —— 跟问选项 + 自由输入；未选角色时收起 */}
      {selected && (
        <div className="tx-agent-de-decision">
          <div className="tx-agent-de-depth">
            <span className="tx-agent-de-meta">第 {Math.min(userTurns, turnLimit)}/{turnLimit} 轮</span>
            {onClear && messages.length > 0 && (
              <button
                className="tx-agent-de-clear"
                onClick={onClear}
                disabled={sending}
                title="清空和 TA 的对话"
              >↺ 清空</button>
            )}
          </div>

          {suggestions.length > 0 && !reachedLimit && (
            <ol className="tx-char-options">
              {suggestions.map((q, i) => {
                // suggestions 可以是 string 也可以是 { text, stance }
                const text = typeof q === 'string' ? q : q.text;
                const stance = typeof q === 'string' ? null : q.stance;
                if (!text) return null;
                return (
                  <li
                    key={i}
                    className={`tx-char-option${stance ? ` tx-char-stance-${stance}` : ''}`}
                    onClick={() => !sending && onSubmit(text)}
                  >
                    <span className="tx-char-option-num">{i + 1}.</span>
                    {stance && <span className="tx-char-option-stance">[{stance}]</span>}
                    <span className="tx-char-option-text">{text}</span>
                  </li>
                );
              })}
            </ol>
          )}

          {reachedLimit ? (
            <div className="tx-char-limit">
              这一段你们已经聊了 {turnLimit} 轮 —— 继续观影，下一个场景可以再次进入 TA 或别人的内心。
            </div>
          ) : (
            <div className="tx-agent-de-input">
              <span className="tx-agent-de-prompt">你 —</span>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
                placeholder="自己开口……"
                disabled={sending}
              />
              <button
                className="tx-agent-de-send"
                onClick={() => onSubmit()}
                disabled={sending || !input.trim()}
              >发送</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* 角色对话单行：user 一行；agent 三层（说 / 心 / 潜） */
function CharLine({ message, speakerName }) {
  if (message.role === 'user') {
    return (
      <div className="de-line de-line-user">
        <span className="de-name de-name-you">你</span>
        <span className="de-dash">—</span>
        <span className="de-body de-body-you">"{message.text}"</span>
      </div>
    );
  }
  const p = message.parsed || { say: message.text || '', voices: [], sub: '', suggestions: [] };
  const showThinking = !message.text && message.streaming;
  const showCursor = message.streaming && message.text;
  // 流式光标只挂在最后一段
  const lastIdx =
    p.sub ? 'sub' :
    (p.voices && p.voices.length) ? `voice-${p.voices.length - 1}` :
    p.say ? 'say' : null;
  return (
    <div className="de-line de-line-agent tx-char-line">
      {showThinking && <span className="de-thinking">思考中…</span>}
      {p.say && (
        <div className="tx-char-layer tx-char-say">
          <span className="tx-char-layer-name">{speakerName}</span>
          <span className="de-dash">—</span>
          <span className="tx-char-say-body">{p.say}</span>
          {showCursor && lastIdx === 'say' && <span className="de-cursor">▍</span>}
        </div>
      )}
      {(p.voices || []).map((v, i) => (
        <div key={i} className={`tx-char-layer tx-char-voice tx-char-voice-${v.cat || 'amber'}`}>
          <span className="tx-char-voice-name">{v.name}</span>
          <span className="tx-char-voice-body">{v.text}</span>
          {showCursor && lastIdx === `voice-${i}` && <span className="de-cursor">▍</span>}
        </div>
      ))}
      {p.sub && (
        <div className="tx-char-layer tx-char-sub">
          <span className="tx-char-tag tx-char-tag-sub">潜</span>
          <span className="tx-char-sub-body">{p.sub}</span>
          {showCursor && lastIdx === 'sub' && <span className="de-cursor">▍</span>}
        </div>
      )}
    </div>
  );
}

/* ─── 立场推演 chooser · AgentPanel 的第三种模态 ────────────────
   不依赖"先投票"这条路径 —— 用户随时进来，挑一个分支点 + 一个反事实
   选项，直接走 submitStanceSpeculation。投过的选项小角标"已投"，
   canonical 选项灰掉（"剧中走向"）。 */
function SpeculationChooserPanel({ triggers, voted, onPick, onExit, episodeLabel = 'EP' }) {
  const eligible = (triggers || []).filter(t => t?.speculation?.by_option);
  return (
    <div className="tx-agent-de tx-spec-mode">
      <div className="tx-agent-de-rail" aria-hidden="true">
        <span className="tx-agent-de-page">{episodeLabel}·SPEC</span>
      </div>

      <div className="tx-char-header">
        <button className="tx-char-back" onClick={onExit} title="回到 AI 解析">‹ 解析模式</button>
        <div className="tx-char-title">
          <div className="tx-char-name tx-char-name-dim">本集分支 · 选一个场景，挑一条没走的路</div>
        </div>
      </div>

      <div className="tx-spec-chooser">
        {eligible.length === 0 ? (
          <div className="tx-agent-de-empty">本集暂时没有可推演的分支点。</div>
        ) : (
          <div className="tx-spec-grid">
            {eligible.map(tg => {
              const userChoice = voted[tg.trigger_id];
              const byOpt = tg.speculation?.by_option || {};
              return (
                <div key={tg.trigger_id} className="tx-spec-card">
                  <div className="tx-spec-card-head">
                    <span className="tx-spec-card-scene">{tg.scene_label}</span>
                    {userChoice && (
                      <span className="tx-spec-card-badge" title={`你之前投了：${userChoice.option_label}`}>
                        已投
                      </span>
                    )}
                  </div>
                  {Array.isArray(tg.prompt_lines) && tg.prompt_lines.length > 0 && (
                    <div className="tx-spec-card-prompt">
                      {tg.prompt_lines.join(' ')}
                    </div>
                  )}
                  <div className="tx-spec-card-options">
                    {(tg.options || []).map(opt => {
                      const isCanon = !!opt.is_canonical;
                      const inByOpt = !!byOpt[opt.id];
                      const disabled = isCanon || !inByOpt;
                      const isYours = userChoice?.option_id === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className={
                            'tx-spec-opt' +
                            (isCanon ? ' is-canonical' : '') +
                            (isYours ? ' is-yours' : '')
                          }
                          onClick={() => {
                            if (disabled) return;
                            onPick(tg, {
                              option_id: opt.id,
                              option_label: opt.label,
                              option_inner_voice: opt.inner_voice,
                            });
                          }}
                          disabled={disabled}
                          title={isCanon ? '剧情就是这么走的，没有"如果"' : `推演：${opt.label}`}
                        >
                          <span className="tx-spec-opt-label">{opt.label}</span>
                          {isCanon && <span className="tx-spec-opt-tag">剧中走向</span>}
                          {isYours && !isCanon && <span className="tx-spec-opt-tag tx-spec-opt-tag-yours">你的票</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
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
const SUBTITLE_SIZES = ['小', '标准', '大'];
const AUDIOS = ['默认', '国语', '日语'];
function fmtTime(s) {
  if (!s || !isFinite(s)) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function PlayerControls({ videoRef, videoId, subtitleTracks = [], season = 1, hasNext, onNext }) {
  const defaultSubtitleLabel = subtitleTracks.find(track => track.default)?.label || subtitleTracks[0]?.label || '关闭';
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
  const [subtitle, setSubtitle] = useState(defaultSubtitleLabel);
  const [subtitleSize, setSubtitleSize] = useState('小');
  const [audioTrack, setAudioTrack] = useState('默认');
  const [dragPreview, setDragPreview] = useState(null); // {time, leftPct} while dragging
  // 进度条 chapter ticks —— 来自 KB 的章节锚点（act + branch_point）。
  // 没 videoId / 后端 / KB 时静默为 []，进度条退化成普通 progress。
  const [chapters, setChapters] = useState([]);
  const [hoveredChapter, setHoveredChapter] = useState(null); // 整个 chapter 对象，含 t/label/kind

  const progressRef = useRef(null);
  const draggingRef = useRef(false);

  const subtitleOptions = [...subtitleTracks.map(track => track.label), '关闭'];
  const subtitleButtonLabel = subtitle === '中英双语'
    ? '双语'
    : subtitle === '简体中文' ? '中文' : subtitle;

  const cycleSubtitle = () => {
    const currentIndex = subtitleOptions.indexOf(subtitle);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % subtitleOptions.length : 0;
    setSubtitle(subtitleOptions[nextIndex]);
  };

  useEffect(() => {
    setSubtitle(defaultSubtitleLabel);
  }, [videoId, defaultSubtitleLabel]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const applySubtitle = () => {
      Array.from(video.textTracks || []).forEach(track => {
        track.mode = subtitle !== '关闭' && track.label === subtitle ? 'showing' : 'disabled';
      });
    };
    applySubtitle();
    video.addEventListener('loadedmetadata', applySubtitle);
    return () => video.removeEventListener('loadedmetadata', applySubtitle);
  }, [subtitle, videoId, videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.classList.remove('subtitle-size-small', 'subtitle-size-standard', 'subtitle-size-large');
    const sizeClass = subtitleSize === '大'
      ? 'subtitle-size-large'
      : subtitleSize === '标准' ? 'subtitle-size-standard' : 'subtitle-size-small';
    video.classList.add(sizeClass);
  }, [subtitleSize, videoId, videoRef]);

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
      params: { videoId, t: '0', showId: 'house-of-the-dragon', season },
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
  }, [videoId, season]);

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
            <button
              className="tx-ctl-btn tx-ctl-text"
              title={`字幕：${subtitle}（点击切换）`}
              aria-label={`字幕：${subtitle}，点击切换`}
              onClick={cycleSubtitle}
            >
              {subtitleButtonLabel}
            </button>
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
                  <SettingsSection label="字幕" options={subtitleOptions} value={subtitle} onChange={setSubtitle} />
                  <SettingsSection label="字幕大小" options={SUBTITLE_SIZES} value={subtitleSize} onChange={setSubtitleSize} />
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
