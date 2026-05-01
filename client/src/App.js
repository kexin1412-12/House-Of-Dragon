import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import './App.css';
import RelationshipGraph from './RelationshipGraph';
import SeasonTimeline from './SeasonTimeline';
import RoleplayDialogueDE from './RoleplayDialogueDE';
import SymbolHotspots from './SymbolHotspots';
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

const GENRES = ['ACTION', 'FANTASY', 'DRAMA'];

export default function App() {
  const [videos, setVideos] = useState([]);
  const [featured, setFeatured] = useState(null);
  const [playing, setPlaying] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [search, setSearch] = useState('');
  const [notification, setNotification] = useState(null);
  const fileInputRef = useRef(null);

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

  async function handleUpload(file) {
    if (!file) return;
    if (!file.type.startsWith('video/')) {
      notify('请选择视频文件', 'error');
      return;
    }
    const fd = new FormData();
    fd.append('video', file);
    setUploading(true);
    setProgress(0);
    try {
      const { data } = await axios.post(`${API}/api/upload`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: e => setProgress(Math.round((e.loaded * 100) / e.total)),
      });
      setShowUpload(false);
      notify(`"${data.name}" 上传成功！`);
      await fetchVideos();
    } catch {
      notify('上传失败，请确保服务器已启动', 'error');
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  function onDragOver(e) { e.preventDefault(); setDragOver(true); }
  function onDragLeave() { setDragOver(false); }
  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleUpload(e.dataTransfer.files[0]);
  }

  const heroPreview = featured || videos[0];

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
              placeholder="搜索我的作品"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="nav-right">
          <button className="btn-upload-nav" onClick={() => setShowUpload(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            上传
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

      {/* Hero */}
      <section className="hero">
        <div className="hero-bg" />
        <div className="hero-content">
          <div className="hero-badge">
            <span className="star">★</span>
            AI 原生 · 长视频获得游戏的交互层
          </div>
          <h1 className="hero-title">{'共谋者\nCo-Conspirator'}</h1>
          <p className="hero-desc">
            视频不再是一条线，而是一个空间，共谋者是一个让任何长视频获得游戏级交互的 AI 原生产品——让观众不再是「看戏的人」，而是「与戏共谋的人」
          </p>
          <div className="hero-genres">
            {GENRES.map(g => <span key={g}>{g}</span>)}
          </div>
        </div>
        {heroPreview && (
          <div
            className="hero-preview"
            onClick={() => { setFeatured(heroPreview); setPlaying(heroPreview); }}
          >
            <video
              key={heroPreview.id}
              src={`${resolveVideoSrc(heroPreview.url)}#t=60`}
              autoPlay loop muted playsInline
            />
            <div className="hero-preview-mask" />
            <div className="hero-preview-meta">
              <span className="hero-preview-pill">▶ 正在播放</span>
              <span className="hero-preview-name">{heroPreview.name}</span>
            </div>
          </div>
        )}
      </section>

      {/* Upload Modal */}
      {showUpload && (
        <div className="modal-backdrop" onClick={() => !uploading && setShowUpload(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>上传视频</h2>
              {!uploading && (
                <button className="modal-close" onClick={() => setShowUpload(false)}>✕</button>
              )}
            </div>
            <div
              className={`drop-zone ${dragOver ? 'drag-active' : ''} ${uploading ? 'is-uploading' : ''}`}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onClick={() => !uploading && fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                hidden
                onChange={e => handleUpload(e.target.files[0])}
              />
              {uploading ? (
                <div className="upload-progress-wrap">
                  <div className="progress-circle">
                    <svg viewBox="0 0 80 80">
                      <circle cx="40" cy="40" r="34" className="track" />
                      <circle
                        cx="40" cy="40" r="34"
                        className="fill"
                        strokeDasharray={`${2 * Math.PI * 34}`}
                        strokeDashoffset={`${2 * Math.PI * 34 * (1 - progress / 100)}`}
                      />
                    </svg>
                    <span>{progress}%</span>
                  </div>
                  <p className="upload-status-text">正在上传… {progress}%</p>
                  <div className="progress-bar-wrap">
                    <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              ) : (
                <div className="drop-idle">
                  <div className="drop-icon">
                    <svg viewBox="0 0 64 64" fill="none">
                      <rect x="4" y="12" width="56" height="40" rx="6" stroke="currentColor" strokeWidth="2"/>
                      <path d="M22 32l10 8 10-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                      <path d="M32 40V20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                    </svg>
                  </div>
                  <h3>拖放视频文件到此处</h3>
                  <p>或 <span className="browse-link">点击浏览文件</span></p>
                  <p className="file-hint">支持 MP4 · MOV · AVI · MKV · WebM</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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

/* ─── Tencent Video Player Page ─────────────────────── */

function TencentPlayer({ playing, videos, onClose, onSelect }) {
  const [search, setSearch] = useState('');

  const videoRef = useRef(null);
  const [aiKbList, setAiKbList] = useState([]);
  const [aiKb, setAiKb] = useState('');
  const [aiMode, setAiMode] = useState('casual');
  const [aiBehavior, setAiBehavior] = useState('normal');
  const [aiCards, setAiCards] = useState([]);
  const [aiMessages, setAiMessages] = useState([]);
  const [aiInput, setAiInput] = useState('');
  const [aiDepth, setAiDepth] = useState('brief'); // 'oneline' | 'brief' | 'deep'
  // 全屏模式：右边浮一个 icon 按钮，点击展开 AgentPanel 抽屉
  // （非全屏时 aside 里那块 chat 还在原位，无需此抽屉）
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth <= 900);
  const [aiChatOpen, setAiChatOpen] = useState(false);
  useEffect(() => {
    const onFs = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      if (!fs) setAiChatOpen(false); // 离开全屏自动关抽屉
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth <= 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!aiChatOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setAiChatOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [aiChatOpen]);
  const [aiSending, setAiSending] = useState(false);
  const [aiLlmReady, setAiLlmReady] = useState(false);
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
  const aiLastCardSceneRef = useRef(null);
  const aiLastSceneIdRef = useRef(null);

  // ─── 共谋者 · 机制 B：角色对谈 ─────────────────────────────────
  const [roleplayCast, setRoleplayCast] = useState([]);            // [{character_id, display_name, ready_for_episode}]
  const [roleplayChar, setRoleplayChar] = useState(null);          // {character_id, display_name, short_identity}
  const [roleplayMessages, setRoleplayMessages] = useState([]);
  const [roleplayInput, setRoleplayInput] = useState('');
  const [roleplaySending, setRoleplaySending] = useState(false);
  const [roleplaySide, setRoleplaySide] = useState('left');        // 对谈面板默认贴左边
  const [roleplayBgTone, setRoleplayBgTone] = useState('dark');    // 'dark' | 'bright' —— 字幕区背景明暗
  const [roleplayIntro, setRoleplayIntro] = useState(null);        // { hero_line, sub_line, prompt_line, suggested_questions } —— 上下文驱动的入场前奏
  const [roleplayIntroLoading, setRoleplayIntroLoading] = useState(false);
  const roleplayIntroSeqRef = useRef(0);                           // 防竞态：只接受最近一次请求的结果
  const roleplayLogRef = useRef(null);
  // 右边缘"对谈入口"图标 + cast picker
  const [roleplayPickerOpen, setRoleplayPickerOpen] = useState(false);
  // ESC 关 picker（roleplay 自己的 ESC 仍由 RoleplayOverlay 处理）
  useEffect(() => {
    if (!roleplayPickerOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setRoleplayPickerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [roleplayPickerOpen]);
  // DE 风格立场选项（gemini 生成，每轮 NPC 回复后拉一次）
  const [roleplayChoices, setRoleplayChoices] = useState([]);
  const [roleplayChoicesLoading, setRoleplayChoicesLoading] = useState(false);
  const roleplayChoicesSeqRef = useRef(0);

  // ─── 共谋者 · 机制 C：平行视角（HUD 卡片版） ─────────────────
  const [perspectiveChar, setPerspectiveChar] = useState(null);    // {character_id, display_name, ...}
  const [perspectiveData, setPerspectiveData] = useState(null);    // { pov_character, subtitle, cards, actions } | null
  const [perspectiveLoading, setPerspectiveLoading] = useState(false);
  const [perspectiveError, setPerspectiveError] = useState(null);
  const [perspectiveSide, setPerspectiveSide] = useState('right');
  const [perspectiveBgTone, setPerspectiveBgTone] = useState('dark');

  async function openPerspective(castEntry, onScreenChar) {
    if (!castEntry) return;
    const v = videoRef.current;
    if (v && !v.paused) v.pause();
    const t = v?.currentTime || 0;
    setPerspectiveChar(castEntry);
    setPerspectiveData(null);
    setPerspectiveError(null);
    setPerspectiveLoading(true);
    const pSide = sideOppositeOf(onScreenChar?.bbox);
    setPerspectiveSide(pSide);
    setPerspectiveBgTone(toneFromLuminance(sampleSideLuminance(pSide)));

    try {
      const resp = await fetch(`${API}/api/agent/perspective/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: aiKb,
          t,
          characterId: castEntry.character_id,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setPerspectiveError(data?.error || `HTTP ${resp.status}`);
        if (data?.fallback) setPerspectiveData(data.fallback);
      } else {
        setPerspectiveData(data);
      }
    } catch (err) {
      setPerspectiveError(err.message);
    } finally {
      setPerspectiveLoading(false);
    }
  }
  function closePerspective() {
    setPerspectiveChar(null);
    setPerspectiveData(null);
    setPerspectiveError(null);
    setPerspectiveLoading(false);
  }

  // 视频内的人物档案点击已下线 —— 改为在关系图里点头像调档案。
  // 「问她一句」: 关 perspective，开 roleplay
  function bridgePerspectiveToRoleplay() {
    const cast = perspectiveChar;
    if (!cast) return;
    closePerspective();
    enterRoleplay(cast, null);
    // 视角阶段暂停了视频；进入对谈后恢复播放（roleplay 是边看边聊模式）
    const v = videoRef.current;
    if (v && v.paused) v.play().catch(() => {});
  }

  useEffect(() => { closePerspective(); }, [playing.id]);

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
      setAiKbList(list);
      setAiLlmReady(!!r.data.llm_ready);
      const base = (playing.filename || '').replace(/\.[^.]+$/, '');
      setAiKb(list.includes(base) ? base : '');
    }).catch(() => {});
  }, [playing.id]);

  // 拉本视频可对谈的角色列表（共谋者机制 B）
  // 按 cursor time 过滤："当前 scene ± 30s 窗口里 agent 标注过出场" 的角色才算 in_scene。
  // 每 3 秒轮询一次，跨场切换时 picker 自动跟着变。
  useEffect(() => {
    if (!aiKb) { setRoleplayCast([]); return; }
    let cancelled = false;
    const fetchCast = () => {
      const t = videoRef.current?.currentTime || 0;
      axios.get(`${API}/api/agent/roleplay/cast?videoId=${encodeURIComponent(aiKb)}&t=${t}`)
        .then(r => { if (!cancelled) setRoleplayCast(r.data.characters || []); })
        .catch(() => { if (!cancelled) setRoleplayCast([]); });
    };
    fetchCast();
    const id = setInterval(fetchCast, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [aiKb]);

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

  // Poll passive cards at the current playback time. Dedup via lastCardSceneId:
  // if server returns empty (same scene as last card), keep existing cards on screen.
  useEffect(() => {
    if (!aiKb) return;
    let cancelled = false;
    const fetchCards = async () => {
      const t = videoRef.current?.currentTime || 0;
      const params = new URLSearchParams({
        videoId: aiKb, t: String(t), mode: aiMode,
      });
      if (aiLastCardSceneRef.current) {
        params.set('lastCardSceneId', aiLastCardSceneRef.current);
      }
      try {
        const { data } = await axios.get(`${API}/api/agent/cards?${params}`);
        if (cancelled) return;
        if (!data.scene_id) {
          setAiCards([]);
          aiLastCardSceneRef.current = null;
          return;
        }
        if (data.cards && data.cards.length > 0) {
          setAiCards(data.cards);
          aiLastCardSceneRef.current = data.scene_id;
        }
      } catch { /* server probably not running */ }
    };
    fetchCards();
    const id = setInterval(fetchCards, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [aiKb, aiMode]);

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
          mode: aiMode,
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

  // ─── 共谋者 · 角色对谈 submit ─────────────────────────────────
  // 流程同 submitAiQuestion，但 mode='roleplay'+characterId，消息走 roleplayMessages。
  // 视频不暂停 —— 对谈面板浮在画面左侧，画面继续播放（与 enterRoleplay 的行为一致）。
  async function submitRoleplayQuestion(qOverride) {
    const raw = qOverride !== undefined ? qOverride : roleplayInput;
    const q = (raw || '').trim();
    if (!q || roleplaySending || !roleplayChar) return;

    const v = videoRef.current;
    const t = v?.currentTime || 0;

    setRoleplayMessages(prev => [
      ...prev,
      { role: 'user', text: q, t },
      { role: 'agent', text: '', t, streaming: true },
    ]);
    setRoleplayInput('');
    setRoleplaySending(true);
    // 清空上一轮选项，让 UI 进入"等 NPC 说完"状态
    roleplayChoicesSeqRef.current++;
    setRoleplayChoices([]);
    setRoleplayChoicesLoading(false);

    let finalAgentText = '';                  // 累计最终台词，用于 voices 调用
    // 严格打字机节奏 — 见 submitAiQuestion 的同款注释。
    const TYPE_INTERVAL_MS = 18;
    let queue = '';
    let typing = false;
    const flushChunk = (chunk) => setRoleplayMessages(prev => {
      const copy = prev.slice();
      const last = copy[copy.length - 1];
      if (last?.role === 'agent' && last.streaming) {
        const merged = { ...last, text: last.text + chunk };
        copy[copy.length - 1] = merged;
        finalAgentText = merged.text;
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
        setRoleplayMessages(prev => {
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

    // 抓当前画面给角色"看"——让他能感知此刻气氛（非必须，profile 缺图也能跑）
    let imageDataUrl = null;
    if (v && v.videoWidth) {
      try {
        const W = 480;
        const H = Math.max(1, Math.round(v.videoHeight / v.videoWidth * W));
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        canvas.getContext('2d').drawImage(v, 0, 0, W, H);
        imageDataUrl = canvas.toDataURL('image/jpeg', 0.55);
      } catch { /* taint or capture failure — 无图也行 */ }
    }

    try {
      // 历史 6 条让 LLM 维持对话连贯
      const lastExchanges = roleplayMessages
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
          mode: 'roleplay',
          characterId: roleplayChar.character_id,
          image: imageDataUrl,
          session: { last_exchanges: lastExchanges },
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
          else if (evtType === 'done') {
            finalizeMsg({ source: data.source, provider: data.provider, model: data.model });
          }
        }
      }

      // 回合结束 → 拉玩家"内心声音"（DE 风格 LOGIC / EMPATHY / INLAND EMPIRE …）
      // 软失败：拉不到就不显示，主对话不受影响
      const replyForVoices = finalAgentText.trim();
      if (replyForVoices && roleplayChar) {
        fetch(`${API}/api/agent/roleplay/voices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoId: aiKb || null,
            t,
            characterId: roleplayChar.character_id,
            userQuestion: q,
            characterReply: replyForVoices,
          }),
        })
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            const voices = Array.isArray(d?.voices) ? d.voices : [];
            if (!voices.length) return;
            setRoleplayMessages(prev => {
              const copy = prev.slice();
              for (let i = copy.length - 1; i >= 0; i--) {
                const m = copy[i];
                if (m.role === 'agent' && !m.streaming && m.text === replyForVoices) {
                  copy[i] = { ...m, voices };
                  break;
                }
              }
              return copy;
            });
          })
          .catch(() => { /* soft fail */ });

        // 同时拉立场选项（gemini 生成 3 条）—— 与 voices 并行，不阻塞
        const choiceSeq = ++roleplayChoicesSeqRef.current;
        setRoleplayChoicesLoading(true);
        const histForChoices = roleplayMessages.slice(-6).map(m => ({ role: m.role, text: m.text }));
        fetch(`${API}/api/agent/roleplay/choices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoId: aiKb || null,
            t,
            characterId: roleplayChar.character_id,
            lastNpcReply: replyForVoices,
            history: histForChoices,
          }),
        })
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (choiceSeq !== roleplayChoicesSeqRef.current) return;
            const opts = Array.isArray(d?.options) ? d.options : [];
            setRoleplayChoices(opts);
          })
          .catch(() => { /* soft fail，前端 UI 仍保留自由输入 */ })
          .finally(() => {
            if (choiceSeq === roleplayChoicesSeqRef.current) setRoleplayChoicesLoading(false);
          });
      }
    } catch {
      finalizeMsg({ text: '（对话断了……网络的事，你知道。）', source: 'error' });
    } finally {
      setRoleplaySending(false);
    }
  }

  // 算字幕该挂在哪边：人脸在画面左 → 字幕去右；反之去左
  function sideOppositeOf(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return 'right';
    const cx = (bbox[0] + bbox[2]) / 2;
    return cx < 0.5 ? 'right' : 'left';
  }

  // 抽当前画面 side 那一侧的平均亮度（0..1）。亮 → 字幕需要暗底衬底
  function sampleSideLuminance(side) {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return 0;
    const W = 48, H = 48;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    // 取该侧 30% 宽，纵向 25%-80%（对齐字幕区域大致位置）
    const sxN = side === 'left' ? 0.05 : 0.65;
    const sx = sxN * v.videoWidth;
    const sy = 0.25 * v.videoHeight;
    const sw = 0.30 * v.videoWidth;
    const sh = 0.55 * v.videoHeight;
    try {
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
      const data = ctx.getImageData(0, 0, W, H).data;
      let total = 0;
      for (let i = 0; i < data.length; i += 4) {
        total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      return total / (W * H) / 255;
    } catch {
      // canvas 跨域 / drawImage 失败时返回中位值，按"暗"处理
      return 0;
    }
  }
  // 把亮度归类成两档
  function toneFromLuminance(lum) {
    return lum > 0.45 ? 'bright' : 'dark';
  }

  // 进入/退出 roleplay：暂停视频（让画面定格作为背景），重置消息缓冲
  function enterRoleplay(castEntry, onScreenChar) {
    if (!castEntry) return;
    const v = videoRef.current;
    // 剧情继续播放：对谈面板在左侧浮在画面上，画面在右侧仍可见。
    // 不再 pause —— 让玩家边看边对谈。
    setRoleplayChar(castEntry);
    setRoleplayMessages([]);
    setRoleplayInput('');
    // 固定在左侧 —— 对谈面板贴左边，画面右半边可视
    setRoleplaySide('left');
    setRoleplayBgTone(toneFromLuminance(sampleSideLuminance('left')));

    // 上下文驱动的入场前奏：取当前 t + character + 当前 scene → server 现写
    setRoleplayIntro(null);
    setRoleplayIntroLoading(true);
    const seq = ++roleplayIntroSeqRef.current;
    const tNow = v?.currentTime || 0;
    axios.post(`${API}/api/agent/roleplay/intro`, {
      videoId: aiKb,
      t: tNow,
      characterId: castEntry.character_id,
    })
      .then(r => {
        if (seq !== roleplayIntroSeqRef.current) return;
        setRoleplayIntro(r.data);
        // 入场前奏拿到后立刻拉一次首轮选项；以 hero_line 当 NPC 的"开场台词"
        const heroLine = r.data?.hero_line;
        if (heroLine) {
          const choiceSeq = ++roleplayChoicesSeqRef.current;
          setRoleplayChoicesLoading(true);
          fetch(`${API}/api/agent/roleplay/choices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              videoId: aiKb || null,
              t: tNow,
              characterId: castEntry.character_id,
              lastNpcReply: heroLine,
              history: [],
            }),
          })
            .then(rr => rr.ok ? rr.json() : null)
            .then(d => {
              if (choiceSeq !== roleplayChoicesSeqRef.current) return;
              setRoleplayChoices(Array.isArray(d?.options) ? d.options : []);
            })
            .catch(() => { /* soft fail */ })
            .finally(() => {
              if (choiceSeq === roleplayChoicesSeqRef.current) setRoleplayChoicesLoading(false);
            });
        }
      })
      .catch(() => {
        if (seq !== roleplayIntroSeqRef.current) return;
        setRoleplayIntro(null); // 失败就让前奏区为空，不再回退到模板句
      })
      .finally(() => {
        if (seq !== roleplayIntroSeqRef.current) return;
        setRoleplayIntroLoading(false);
      });
  }
  function exitRoleplay() {
    setRoleplayChar(null);
    setRoleplayMessages([]);
    setRoleplayInput('');
    roleplayIntroSeqRef.current++; // 让在飞的请求作废
    setRoleplayIntro(null);
    setRoleplayIntroLoading(false);
    roleplayChoicesSeqRef.current++;
    setRoleplayChoices([]);
    setRoleplayChoicesLoading(false);
  }

  function clearRoleplay() {
    setRoleplayMessages([]);
    setRoleplayInput('');
    roleplayIntroSeqRef.current++;
    setRoleplayIntro(null);
    setRoleplayIntroLoading(false);
    roleplayChoicesSeqRef.current++;
    setRoleplayChoices([]);
    setRoleplayChoicesLoading(false);
  }

  // Auto-scroll roleplay log
  useEffect(() => {
    if (roleplayLogRef.current) roleplayLogRef.current.scrollTop = roleplayLogRef.current.scrollHeight;
  }, [roleplayMessages, roleplaySending]);

  // 切视频时退出对谈
  useEffect(() => { exitRoleplay(); }, [playing.id]);

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
          <div className="tx-player-wrap">
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
                // 角色对谈打开时不让画面 click 切换播放 —— overlay 自己处理"点空白关对话"
                if (roleplayChar) return;
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
                    cards={[]}                 /* 全屏不需要 passive 卡片 */
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

            {/* 右边缘对谈入口：常驻金色小图标 → 弹出 cast picker
                当前没在对谈时常驻显示；没人在场时 picker 显示空状态提示 */}
            {!roleplayChar && (
              <>
                <button
                  className={`tx-roleplay-edge-btn ${roleplayPickerOpen ? 'is-open' : ''}`}
                  onClick={() => setRoleplayPickerOpen(o => !o)}
                  title={roleplayPickerOpen ? '收起 (ESC)' : '与剧中角色对话'}
                  aria-label="与剧中角色对话"
                >
                  {/* 单人侧影 + 引向角色的对白气泡（区别于"关系图"的双人剪影 +
                      "AI 解说"的单纯气泡），明确语义："对一个人开口说话"。 */}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                       strokeLinecap="round" strokeLinejoin="round">
                    {/* 左侧：一个人 */}
                    <circle cx="7" cy="8" r="2.6"/>
                    <path d="M2.4 18c.5-2.6 2.4-4.4 4.6-4.4s4.1 1.8 4.6 4.4"/>
                    {/* 右侧：对白气泡 */}
                    <path d="M14 7h6.5a1.6 1.6 0 0 1 1.6 1.6v4.8a1.6 1.6 0 0 1-1.6 1.6h-3.2l-2.6 2.4v-2.4H14a1.6 1.6 0 0 1-1.6-1.6V8.6A1.6 1.6 0 0 1 14 7Z"/>
                    {/* 三个点：在说话 */}
                    <circle cx="15.7" cy="11" r="0.55" fill="currentColor"/>
                    <circle cx="17.4" cy="11" r="0.55" fill="currentColor"/>
                    <circle cx="19.1" cy="11" r="0.55" fill="currentColor"/>
                  </svg>
                  <span className="tx-roleplay-edge-btn-label">对谈</span>
                </button>

                {roleplayPickerOpen && (
                  <>
                    {/* picker 自己的 scrim：点空白处收起，不影响视频暂停 */}
                    <div
                      className="tx-roleplay-picker-scrim"
                      onClick={() => setRoleplayPickerOpen(false)}
                    />
                    <div
                      className="tx-roleplay-picker"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="tx-roleplay-picker-meta">DRAMATIS PERSONAE · 与谁对话</div>
                      {(() => {
                        const available = roleplayCast.filter(c => c.ready_for_episode && c.in_scene);
                        if (available.length === 0) {
                          return (
                            <div className="tx-roleplay-picker-empty">
                              当前场景暂无可对谈的角色 ——
                              等画面切到有 AI 角色档案的人物时，名单会自动出现。
                            </div>
                          );
                        }
                        return (
                          <ul className="tx-roleplay-picker-list">
                            {available.map(cast => (
                              <li key={cast.character_id}>
                                <button
                                  className="tx-roleplay-picker-item"
                                  onClick={() => {
                                    setRoleplayPickerOpen(false);
                                    openPerspective(cast, null);
                                  }}
                                >
                                  <span
                                    className="tx-roleplay-picker-name"
                                    style={{ color: deCharColor(cast.character_id) }}
                                  >
                                    {(cast.display_name || cast.character_id).toUpperCase()}
                                  </span>
                                  {cast.short_identity && (
                                    <span className="tx-roleplay-picker-id">
                                      — {cast.short_identity}
                                    </span>
                                  )}
                                </button>
                              </li>
                            ))}
                          </ul>
                        );
                      })()}
                    </div>
                  </>
                )}
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

            {/* 机制 B：角色对谈 —— DE 风格底部叠层，文字浮在画面上 */}
            {roleplayChar && (
              <RoleplayDialogueDE
                character={roleplayChar}
                messages={roleplayMessages}
                sending={roleplaySending}
                onSubmit={submitRoleplayQuestion}
                onExit={exitRoleplay}
                onClear={clearRoleplay}
                intro={roleplayIntro}
                introLoading={roleplayIntroLoading}
                choices={roleplayChoices}
                choicesLoading={roleplayChoicesLoading}
              />
            )}

            {/* 机制 C：平行视角 —— 同样浮在画面上 */}
            {perspectiveChar && (
              <PerspectiveOverlay
                character={perspectiveChar}
                data={perspectiveData}
                loading={perspectiveLoading}
                error={perspectiveError}
                onClose={closePerspective}
                onAskHer={bridgePerspectiveToRoleplay}
                side={perspectiveSide}
                bgTone={perspectiveBgTone}
                askLabelOverride="开始对话"
              />
            )}

            {/* 共谋者 · 隐藏符号热点 —— 脉冲小点 + 角标 pill，点击查看深度解读 */}
            <SymbolHotspots videoId={aiKb} videoRef={videoRef} />


            {/* 人物关系图 v2 —— HUD 入口 + Focus Card，按真实 videoTime + 角色 KB 动态出图 */}
            <RelationshipGraph videoId={aiKb} videoRef={videoRef} />

            {/* 季时间轴卡 —— 独立抽屉，按 cursor 屏蔽未看集 + 前后呼应 */}
            <SeasonTimeline videoId={aiKb} videoRef={videoRef} />

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

          <AgentPanel
            behavior={aiBehavior}
            cards={[]}
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
const TAG_COLORS = {
  '事实': '#e8e6dd',  // 奶白：直接观察，无情感倾向
  '解读': '#8fc8e8',  // 信号蓝：观点判断
  '推测': '#e8b85a',  // 琥珀：不确定（同时斜体）
};

/* ─── Disco Elysium 风格 · 角色对谈调色板 ──────────────────────────
   每条"声音"（玩家自己的内心技能 / 角色台词 / 旁白 / 场景）有专属颜色。
   未知声音 fallback 走玩家色（cream），保证至少能渲染。 */
const DE_VOICE_COLOR = {
  YOU:                '#e8dcc4',                  // 玩家
  NARRATION:          'rgba(232,220,196,0.55)',   // 灰白旁白
  SCENE:              'rgba(232,220,196,0.55)',   // 同 NARRATION
  // 玩家内心 / 技能 / 人格
  LOGIC:              '#7fc7d6',                  // 青：分析
  EMPATHY:            '#e8a5b8',                  // 粉：共情
  AUTHORITY:          '#e6a96b',                  // 橙：威压
  VOLITION:           '#d4af37',                  // 金：意志
  RHETORIC:           '#d4af37',
  SUGGESTION:         '#4dd0d0',                  // 蓝绿：暗示
  COMPOSURE:          '#a8b894',                  // 苔绿：镇定
  PERCEPTION:         '#9ec5cf',                  // 浅青：感知
  'INLAND EMPIRE':    '#b58ae8',                  // 紫：直觉/梦境
  'ESPRIT DE CORPS':  '#86efac',                  // 绿：群体感
  'SAVOIR FAIRE':     '#f5c47a',
  'INNER VOICE':      'rgba(232,220,196,0.85)',
};

/* 人物名（角色台词色）从一个 6 色调色板按 character_id 哈希取色，
   保证同一角色每次出现颜色一致，且色差足够辨认。 */
const DE_CHAR_PALETTE = ['#e6a96b', '#86efac', '#e8a5b8', '#7fc7d6', '#b58ae8', '#f5c47a'];
function deCharColor(id) {
  if (!id) return DE_CHAR_PALETTE[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DE_CHAR_PALETTE[h % DE_CHAR_PALETTE.length];
}
function deVoiceColor(name) {
  if (!name) return DE_VOICE_COLOR.YOU;
  const key = name.toUpperCase().trim();
  return DE_VOICE_COLOR[key] || DE_VOICE_COLOR['INNER VOICE'];
}

/* 解析 agent 回复：识别行首的 [VOICE] 标签，把"内心声音"与"角色台词"分开。
   - `[LOGIC] 她在闪躲。`  → { kind:'voice', voice:'LOGIC', text:'她在闪躲。' }
   - 其余文本视为角色台词（speech）。
   兼容空回复 / 纯台词（无 VOICE 行）—— 这两种情况返回的就是单个 speech 段。*/
function parseRoleplayVoices(text) {
  if (!text) return [];
  const out = [];
  let speech = '';
  const flushSpeech = () => {
    const t = speech.trim();
    if (t) out.push({ kind: 'speech', text: t });
    speech = '';
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // 中英方括号都接受；voice 名 1-20 字（中文 / 大写 / 空格）
    const m = /^[\[【]\s*([A-Z一-龥][A-Z一-龥\s]{0,19})\s*[\]】]\s*(.+)$/.exec(line);
    if (m) {
      flushSpeech();
      out.push({ kind: 'voice', voice: m[1].trim().toUpperCase(), text: m[2].trim() });
    } else if (line) {
      speech += (speech ? '\n' : '') + line;
    }
  }
  flushSpeech();
  return out;
}

const QUICK_QUESTIONS = [
  '刚才发生什么',
  '解释这个镜头',
  '这是什么梗',
  '这句台词什么意思',
];

const DEPTH_OPTIONS = [
  { id: 'oneline', label: '一句' },
  { id: 'brief',   label: '简明' },
  { id: 'deep',    label: '深挖' },
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
  cards, messages, input, setInput,
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

      {cards.length > 0 && (
        <div className="tx-agent-de-cards">
          <div className="tx-agent-de-eyebrow">当前解读</div>
          {cards.map((c, i) => <AgentCard key={i} card={c} />)}
        </div>
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

function AgentCard({ card }) {
  const colors = {
    shot: { bg: '#1e2f3f', accent: '#5ab8e8' },
    'foreshadow-setup': { bg: '#3f2a1e', accent: '#e8954d' },
    'foreshadow-payoff': { bg: '#2a1e3f', accent: '#b55ae8' },
  };
  const c = colors[card.type] || { bg: '#2a2a2a', accent: '#888' };
  return (
    <div style={{
      padding: '8px 10px', borderRadius: 6,
      background: c.bg, borderLeft: `3px solid ${c.accent}`,
    }}>
      <div style={{ fontSize: 11, color: c.accent, fontWeight: 600, marginBottom: 3 }}>
        {card.title}
      </div>
      <div style={{ fontSize: 13, color: '#e0e0e0', lineHeight: 1.4 }}>
        {card.body}
      </div>
      {card.meta && (
        <div style={{ fontSize: 10, color: '#888', marginTop: 3 }}>{card.meta}</div>
      )}
    </div>
  );
}

/* ─── 共谋者 · 角色对谈 · 画面内透明浮层（不接管全屏） ──────── */
/* ─── Disco Elysium 风格 · 角色对谈 ───────────────────────────────
   - 右侧"古旧纸面"对话面板：人物名 ALL CAPS + 角色色，台词带引号
   - 玩家"内心声音"（LOGIC / EMPATHY / INLAND EMPIRE …）斜体 + 专属色
   - 数字编号选项（1-4）—— 键盘可直接按 1/2/3/4 触发
   - 自由输入框保留（"自己开口"），不强制走选项
   - The Last of Us 风格底部辅助字幕：显示当下角色台词，不挡画面 */
function RoleplayOverlay({
  character, messages, input, setInput, sending, onSubmit, onExit,
  side = 'right', intro = null, introLoading = false,
}) {
  const inputRef = useRef(null);
  const logRef = useRef(null);
  const [inputFocused, setInputFocused] = useState(false);

  const turns = useMemo(() => {
    const out = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'user') {
        const next = messages[i + 1];
        const agent = (next && next.role === 'agent') ? next : null;
        out.push({ user: m, agent });
        if (agent) i++;
      } else if (m.role === 'agent') {
        out.push({ user: null, agent: m });
      }
    }
    return out;
  }, [messages]);

  const charColor = deCharColor(character.character_id);
  const charNameUpper = (character.display_name || '').toUpperCase();

  const suggestions = Array.isArray(intro?.suggested_questions)
    ? intro.suggested_questions.filter(Boolean).slice(0, 4)
    : [];

  // ESC 离开 + 1-N 键盘选项（input 聚焦或正在发送时不响应数字快捷键）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onExit(); return; }
      if (sending || inputFocused) return;
      const idx = parseInt(e.key, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= suggestions.length) {
        e.preventDefault();
        onSubmit(suggestions[idx - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit, sending, inputFocused, suggestions, onSubmit]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, sending]);

  // 最近一条角色台词 → LOTU 风底部字幕
  const lastAgent = [...messages].reverse().find(m => m.role === 'agent');
  const ambientSpeech = (() => {
    if (!lastAgent) return null;
    const segs = parseRoleplayVoices(lastAgent.text || '');
    const speech = segs.find(s => s.kind === 'speech');
    if (speech?.text) return speech.text;
    if (lastAgent.streaming && lastAgent.text) return lastAgent.text;
    return null;
  })();

  return (
    <div className="de-rp-overlay" data-side={side}>
      <div className="de-rp-vignette" />
      {/* Scrim：覆盖 panel 之外的整片区域（含 video），抓"画面外点击"关掉对话。
          与 panel 同级，panel 由 z-index 浮在 scrim 上面。*/}
      <div className="de-rp-scrim" onClick={onExit} title="点空白处关闭" />

      {/* The Last of Us 风格底部辅助字幕：显示当下角色台词，不挡画面
          字幕是装饰，clicks 透过它落到 overlay → 关闭对话。*/}
      {ambientSpeech && (
        <div className="de-rp-subtitle">
          <span className="de-rp-subtitle-name" style={{ color: charColor }}>
            {character.display_name}
          </span>
          <span className="de-rp-subtitle-text">{ambientSpeech}</span>
        </div>
      )}

      {/* DE 风格右侧对话面板 —— 与 scrim 同级；scrim 抓外侧点击 */}
      <aside className={`de-rp-panel de-rp-panel-${side}`}>
        <button className="de-rp-close" onClick={onExit} title="ESC 离开">×</button>

        <header className="de-rp-header">
          <div className="de-rp-header-meta">RELATIONSHIP DIALOGUE · 共谋者对谈</div>
          {/* 名字保留 GoT 标题卡式金色金属渐变（CSS 处理）；不再用角色色覆盖。
              角色专属色仍出现在底部 LOTU 字幕和对话日志的人物名牌上。*/}
          <div className="de-rp-header-name">{charNameUpper}</div>
          {character.short_identity && (
            <div className="de-rp-header-id">— {character.short_identity}</div>
          )}
        </header>

        <section className="de-rp-log" ref={logRef}>
          {turns.length === 0 && (
            <div className="de-rp-prelude">
              {introLoading && !intro ? (
                <div className="de-rp-prelude-loading">…</div>
              ) : intro?.hero_line ? (
                <>
                  <DeVoiceLine voice="SCENE" italic text={intro.hero_line} />
                  {intro.sub_line && <DeVoiceLine voice="NARRATION" italic dim text={intro.sub_line} />}
                  {intro.prompt_line && <DeVoiceLine voice="NARRATION" italic dim text={intro.prompt_line} />}
                </>
              ) : (
                <DeVoiceLine
                  voice="NARRATION"
                  italic
                  dim
                  text={character.short_identity
                    ? `${character.display_name}｜${character.short_identity}`
                    : character.display_name}
                />
              )}
            </div>
          )}

          {turns.map((turn, i) => (
            <DeTurn
              key={i}
              turn={turn}
              charColor={charColor}
              charNameUpper={charNameUpper}
            />
          ))}
        </section>

        <footer className="de-rp-footer">
          {suggestions.length > 0 && (
            <ol className="de-rp-choices" aria-label="可选回应">
              {suggestions.map((q, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="de-rp-choice"
                    disabled={sending}
                    onClick={() => onSubmit(q)}
                    title="点击 / 按数字键直接说出"
                  >
                    <span className="de-rp-choice-num">{i + 1}.</span>
                    <span className="de-rp-choice-dash">—</span>
                    <span className="de-rp-choice-text">"{q}"</span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          <div className={`de-rp-input-row ${inputFocused ? 'is-focused' : ''} ${sending ? 'is-sending' : ''}`}>
            <span className="de-rp-input-prompt" style={{ color: DE_VOICE_COLOR.YOU }}>YOU —</span>
            <input
              ref={inputRef}
              className="de-rp-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
              placeholder={sending ? `${character.display_name} 在想……` : '自己开口……'}
              disabled={sending}
            />
          </div>

        </footer>
      </aside>
    </div>
  );
}

/* 单条声音行：左侧 ALL CAPS 名牌 + 右侧文本，颜色由 voice 决定。 */
function DeVoiceLine({ voice, text, italic = false, dim = false, color }) {
  const c = color || deVoiceColor(voice);
  return (
    <div className={`de-voice-line ${italic ? 'is-italic' : ''} ${dim ? 'is-dim' : ''}`}>
      {voice && voice !== 'SCENE' && (
        <span className="de-voice-name" style={{ color: c }}>{voice}</span>
      )}
      <span className="de-voice-text" style={{ color: c }}>{text}</span>
    </div>
  );
}

/* 一个回合：玩家选择 → [可选] 内心声音 → 角色台词。 */
function DeTurn({ turn, charColor, charNameUpper }) {
  const { user, agent } = turn;
  const segs = agent ? parseRoleplayVoices(agent.text || '') : [];
  const inlineVoices = segs.filter(s => s.kind === 'voice');
  const speech = segs.find(s => s.kind === 'speech');
  const streaming = !!agent?.streaming;

  // 服务端独立 endpoint 送来的内心声音 + 解析自台词内 [VOICE] 行的合并
  const sideVoices = Array.isArray(agent?.voices) ? agent.voices : [];
  const allVoices = [...sideVoices, ...inlineVoices];

  const speechText = speech?.text
    || (streaming && !inlineVoices.length ? agent?.text || '' : '');

  return (
    <div className="de-turn">
      {user && (
        <div className="de-voice-line de-voice-line-you">
          <span className="de-voice-name" style={{ color: DE_VOICE_COLOR.YOU }}>YOU</span>
          <span className="de-voice-text" style={{ color: DE_VOICE_COLOR.YOU }}>"{user.text}"</span>
        </div>
      )}
      {allVoices.map((v, i) => (
        <DeVoiceLine key={i} voice={v.voice} text={v.text} italic dim />
      ))}
      {(speechText || streaming) && (
        <div className="de-voice-line de-voice-line-speech">
          <span className="de-voice-name" style={{ color: charColor }}>{charNameUpper}</span>
          <span className="de-voice-text" style={{ color: '#f0e6d2' }}>
            {speechText
              ? <>"{speechText}{streaming && <span className="de-caret">▌</span>}"</>
              : <span className="de-thinking">……</span>
            }
          </span>
        </div>
      )}
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

/* ─── 共谋者 · 平行视角 · HUD 卡片版 ─────────────────────────
   3-4 张极短卡片（label 来自服务端安全表），下方两个 action 文案也由服务端给定。
   也被复用为 P0 动态人物卡（机制不同，但容器一致）—— 通过 markerLabel 区分顶部标签。 */
function PerspectiveOverlay({
  character, data, loading, error,
  onClose, onAskHer, side = 'right', bgTone = 'dark',
  markerLabel = 'POV',
  loadingText = '正在读取 TA 的视角 ……',
  errorPrefix = '暂时读不出 TA 的视角',
  askLabelOverride = null,
}) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const subtitle = data?.subtitle || character?.short_identity;
  const cards = data?.cards || [];
  const askLabel = askLabelOverride || data?.actions?.[0] || '继续 TA 的视角';
  const closeLabel = data?.actions?.[1] || '回到正片';

  return (
    <div className="rp-overlay rp-overlay-perspective">
      <div className="rp-vignette" />

      <div className="rp-marker">
        <div className="rp-marker-tag rp-marker-tag-pov">{markerLabel}</div>
        <div className="rp-marker-name">{data?.pov_character || character.display_name}</div>
        {subtitle && <div className="rp-marker-id">{subtitle}</div>}
      </div>

      <button className="rp-exit" onClick={onClose} title="ESC 离开">
        <span>×</span>
      </button>

      <div className={`rp-stage rp-stage-side rp-stage-side-${side} rp-stage-perspective rp-stage-hud`} data-bg-tone={bgTone}>
        {loading && cards.length === 0 && (
          <div className="rp-hud-loading">{loadingText}</div>
        )}
        {!loading && error && cards.length === 0 && (
          <div className="rp-hud-loading">{errorPrefix} —— {String(error).slice(0, 80)}</div>
        )}
        {cards.length > 0 && (
          <div className="rp-hud-cards">
            {cards.map((c, i) => (
              <div key={i} className="rp-hud-card">
                <div className="rp-hud-card-label">{c.label}</div>
                <div className="rp-hud-card-text">{c.text}</div>
              </div>
            ))}
          </div>
        )}

        {/* 列底两个 action：文案来自 server，按位置映射到 ask / close 行为 */}
        <div className="rp-hud-actions">
          <button
            className="rp-back-btn rp-hud-action"
            onClick={onAskHer}
            disabled={loading}
          >
            <span>{askLabel}</span>
            <span className="rp-back-mark">→</span>
          </button>
          <button
            className="rp-back-btn rp-hud-action"
            onClick={onClose}
          >
            <span>{closeLabel}</span>
            <span className="rp-back-mark">↺</span>
          </button>
        </div>
      </div>
    </div>
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

  // 拉这一集的章节锚点；videoId 变了重拉。后端不可达 / 没 KB 时静默置空。
  useEffect(() => {
    if (!videoId) { setChapters([]); return; }
    let cancelled = false;
    axios.get(`${API}/api/agent/timeline/chapters`, { params: { videoId }, timeout: 8000 })
      .then(r => { if (!cancelled) setChapters(r.data?.chapters || []); })
      .catch(() => { if (!cancelled) setChapters([]); });
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
