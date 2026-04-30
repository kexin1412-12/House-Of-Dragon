import React, { useEffect, useState, useCallback, useRef } from 'react';
import axios from 'axios';
import './RelationshipGraph.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

/* 关系类型 → 颜色 / 标签
 * 后端返回的是中文 relation（"父女"、"关系疏离"、"政治对立"…）
 * 前端做一次匹配映射到颜色类。匹配不到走默认 kin。 */
/* 颜色编码（与图例对齐）：
   - 绿 ally  —— 同盟、政治盟友、暗中合作
   - 蓝 kin   —— 血亲、夫妻（婚姻 = 家族绑定）、私情（虚线）
   - 红 rival —— 公开对立、决裂、政敌（虚线 = 政治性质）
   - 灰 estranged —— 疏离 / 紧张
   线型：实线 = 血缘 / 直接关系，虚线 = 政治性 / 隐性。
   关键修正：之前 "政治" 笼统映射到红色虚线，导致"政治盟友" 走 rival 色，违反图例。
   现在按 "盟友 vs 对立 vs 附庸" 拆开映射。*/
/* 6 大视觉类型（用户决策 1）—— 后端已经把 relation_kind 写进 relationship.timeline。
   blood / marriage / ally / friend / enemy / secret。
   关键词匹配只作 KIND 缺失时的兜底。*/
const KIND_VIS = {
  blood:    { cls: 'rel-blood',    thick: true  },                  // 实线粗
  marriage: { cls: 'rel-marriage'                                }, // 实线（节点叠双环单独处理）
  ally:     { cls: 'rel-ally'                                    }, // 实线
  friend:   { cls: 'rel-friend',   dashed: true                  }, // 虚线
  enemy:    { cls: 'rel-enemy'                                   }, // 红色实线
  secret:   { cls: 'rel-secret',   dotted: true                  }, // 点线
};

const FALLBACK_KEYWORDS = [
  { kw: ['政治盟友', '政治附庸', '盟约', '附庸', '侍女'],          kind: 'ally' },
  { kw: ['政治对立', '政敌', '对立', '决裂', '敌', '王位之争',
         '凶手', '不认', '破裂', '冷淡', '紧张', '疏远', '疏离'],   kind: 'enemy' },
  { kw: ['情人', '私情', '暧昧'],                                 kind: 'secret' },
  { kw: ['好友', '蜜月', '伙伴'],                                 kind: 'friend' },
  { kw: ['夫妻', '夫', '妻', '婚约', '婚姻'],                     kind: 'marriage' },
  { kw: ['父女', '母子', '父子', '母女', '兄弟', '姐妹', '兄妹',
         '叔侄', '舅甥', '同父异母', '表亲', '表姑侄', '血亲'],     kind: 'blood' },
];

function relationCls(zh, kind) {
  if (kind && KIND_VIS[kind]) return KIND_VIS[kind];
  if (!zh) return KIND_VIS.blood;
  for (const r of FALLBACK_KEYWORDS) {
    if (r.kw.some(k => zh.includes(k))) return KIND_VIS[r.kind];
  }
  return KIND_VIS.blood;
}

function epContext(cursor) {
  if (!cursor) return 'CURRENT';
  // cursor 形如 'S01E05'
  const m = cursor.match(/S(\d+)E(\d+)/);
  if (!m) return cursor;
  return `EPISODE ${m[2]}`;
}

/* 角色附属节点（companion attachment）：龙 / 坐骑 / 贴身随从。
   - 不是关系图的"边"。紧贴主节点（gap≤6px），尺寸约主节点 35-40%。
   - 不可点击、不计入 N 个关系。
   - 优先用 portrait_url 渲染圆形头像；没图就用统一的龙首剪影 SVG（不要汉字）。
   - placement：'below' / 'above' —— 由父按"径向向外"方向决定。
   - 用 transform="translate(0, cy)" 包住内容，clipPath 落在 SVG 根 defs，
     避免 group transform 嵌套带来的渲染歧义。*/
function Companion({ data, parentR, scale = 0.4, placement = 'below', labelEndY, isHero }) {
  if (!data) return null;
  const r = Math.max(10, Math.round(parentR * scale));
  const gap = 5;                         // 紧贴：让"挂载"成为视觉直觉

  let cy;
  if (placement === 'above') {
    cy = -(parentR + gap + r);
  } else {
    const labelBottom = labelEndY != null ? labelEndY : parentR + 30;
    cy = labelBottom + gap + r;
  }
  const nameY = placement === 'above' ? -(r + 4) : r + 11;
  const clipId = `rg-companion-clip-${data.character_id}`;

  return (
    <g
      className={`rg-companion ${isHero ? 'rg-companion-hero' : ''}`}
      transform={`translate(0, ${cy})`}
      aria-hidden="true"
    >
      <circle className="rg-companion-bg" cx={0} cy={0} r={r} />
      {data.portrait_url ? (
        <image
          href={`${API}${data.portrait_url}`}
          xlinkHref={`${API}${data.portrait_url}`}
          x={-(r - 1.5)} y={-(r - 1.5)}
          width={(r - 1.5) * 2} height={(r - 1.5) * 2}
          clipPath={`url(#${clipId})`}
          preserveAspectRatio="xMidYMid slice"
        />
      ) : (
        <DragonGlyph size={r * 1.4} />
      )}
      <text className="rg-companion-name" x={0} y={nameY}>{data.display_name}</text>
    </g>
  );
}

/* 缺图时的兜底：一个统一的小龙首剪影（双角 + 头形 + 眼）。比汉字徽章好看十倍。
   尺寸自适应：viewBox 在 -10..10 内 ≈ 20 单位宽，scale 由 size 控制。 */
function DragonGlyph({ size = 14 }) {
  const s = size / 22;
  return (
    <g transform={`scale(${s})`} className="rg-companion-glyph">
      {/* 双角（短斜线） */}
      <path d="M-6 -8 L-3.5 -10.5 M6 -8 L3.5 -10.5" />
      {/* 头部轮廓 —— 上窄下圆，像握紧的拳头 */}
      <path d="M-9 -3 C-10 -7 -6 -8 -3 -7 L3 -7 C6 -8 10 -7 9 -3 C10 0 8.5 4 5 6 L-5 6 C-8.5 4 -10 0 -9 -3 Z" />
      {/* 鼻孔 / 眼 */}
      <circle cx="0" cy="-2" r="1.4" />
    </g>
  );
}

export default function RelationshipGraph({ videoId, videoRef, defaultHero = 'rhaenyra_targaryen' }) {
  const [hero, setHero] = useState(defaultHero);
  const [open, setOpen] = useState(false);
  const [hasNews, setHasNews] = useState(false);
  const [scanKey, setScanKey] = useState(0);
  const [data, setData] = useState(null);   // { hero, edges, cursor_used }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const seqRef = useRef(0);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 拉数据
  const fetchGraph = useCallback(async (heroId) => {
    const t = videoRef?.current?.currentTime || 0;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const { data: resp } = await axios.get(`${API}/api/agent/characters/relationship-graph`, {
        params: { videoId: videoId || '', characterId: heroId, t: String(t) },
        timeout: 8000,
      });
      if (seq !== seqRef.current) return;
      setData(resp);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err?.message || String(err));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [videoId, videoRef]);

  // 视频换了 → reset 默认 hero（防止上一部视频里的 id 撞死）
  useEffect(() => {
    setHero(defaultHero);
    setData(null);
  }, [videoId, defaultHero]);

  // 打开 / 切 hero 时拉一次数据；关掉时不浪费请求
  useEffect(() => {
    if (open) fetchGraph(hero);
  }, [open, hero, fetchGraph]);

  const openFocus = useCallback(() => {
    setOpen(true);
    setHasNews(false);
    setScanKey(k => k + 1);
  }, []);

  const switchHero = useCallback((charId) => {
    setHero(charId);
    setScanKey(k => k + 1);
  }, []);

  const heroR = 42, satR = 32;
  const edges = data?.edges || [];
  const N = edges.length;

  // ── 动态几何：节点越多 → 半径越大 → 标签间距越宽 ──
  const hasCompanions = (data?.hero?.companion != null) || edges.some(e => e.companion != null);
  const R = Math.max(155, Math.ceil(N * 38));        // 节点数驱动半径
  const nodeBottom = satR + 34 + (hasCompanions ? 50 : 0);  // 名字 + 世家 + companion 高度
  const svgH = Math.max(480, Math.round((R + nodeBottom) * 2 + 60));
  const cx = 230, cy = Math.round(svgH / 2);

  const heroData = data?.hero;

  return (
    <div className={`rg-root ${open ? 'is-viewing' : ''}`}>
      <div className="rg-cine-bar" />
      <div className="rg-cine-bar rg-cine-bar-bottom" />

      {open && (
        <div className="rg-top-hud">
          <span>HOUSE OF THE DRAGON · S01</span>
          <span className="rg-top-hud-right">
            {data?.cursor_used ? epContext(data.cursor_used) : '—'}
          </span>
        </div>
      )}

      <div className="rg-hud-edge">
        <div
          className={`rg-hud-icon ${hasNews ? 'has-news' : ''}`}
          onClick={openFocus}
          title="关系"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8.5" cy="8" r="2.6" />
            <path d="M3.6 18c.5-2.6 2.6-4.4 4.9-4.4s4.4 1.8 4.9 4.4" />
            <circle cx="16" cy="9.5" r="2.2" />
            <path d="M13.5 18.5c.4-2.1 2.1-3.6 4-3.6s3.6 1.5 4 3.6" />
            <line x1="9.5" y1="11" x2="14" y2="11" strokeDasharray="1 2" />
          </svg>
        </div>
      </div>

      <div className={`rg-focus-overlay ${open ? 'open' : ''}`}>
        <div className="rg-scrim" onClick={() => setOpen(false)} />
        <div className="rg-focus-card">
          <div className="rg-scan-line" key={scanKey} />
          <button className="rg-close" onClick={() => setOpen(false)} title="关闭 (Esc)">×</button>
          <header className="rg-card-header">
            <div className="rg-eyebrow">RELATIONSHIP MAP · 一阶关系</div>
            <h2 className="rg-hero-title">
              {heroData?.display_name || (loading ? '正在加载…' : '—')}
              {heroData?.short_identity && (
                <span className="rg-hero-sub">{heroData.short_identity}</span>
              )}
            </h2>
          </header>

          <div className="rg-graph-wrap">
            {loading && !data && <div className="rg-status">检索关系图谱 ……</div>}
            {error && !loading && (
              <div className="rg-status rg-status-error">
                关系图加载失败 —— {error.slice(0, 80)}
              </div>
            )}
            {!loading && !error && data && !heroData && (
              <div className="rg-status">这个视频还没有关系图谱（缺少角色 KB）。</div>
            )}
            {!loading && !error && data && heroData && N === 0 && (
              <div className="rg-status">{heroData.display_name} 在这一刻还没显式关系。</div>
            )}

            {data && heroData && N > 0 && (
              <svg viewBox={`0 0 460 ${svgH}`} width="100%" style={{ display: 'block' }}>
                <defs>
                  {/* 每个角色一个 clipPath（让 image 变圆形） */}
                  <clipPath id={`rg-clip-hero-${heroData.character_id}`}>
                    <circle r={heroR - 2} />
                  </clipPath>
                  {edges.map((e) => (
                    <clipPath id={`rg-clip-${e.with}`} key={`clip-${e.with}`}>
                      <circle r={satR - 2} />
                    </clipPath>
                  ))}
                  {/* 龙 companion 的 clipPath：放 SVG 根，避免 group transform 嵌套
                      时的 user-space 歧义（这是之前龙图不显示、回退成汉字的原因）。*/}
                  {heroData.companion && (
                    <clipPath id={`rg-companion-clip-${heroData.companion.character_id}`}>
                      <circle r={Math.round(heroR * 0.40) - 1.5} />
                    </clipPath>
                  )}
                  {edges
                    .filter(e => e.companion && e.companion.character_id !== heroData.companion?.character_id)
                    .map(e => (
                      <clipPath
                        id={`rg-companion-clip-${e.companion.character_id}`}
                        key={`compclip-${e.companion.character_id}`}
                      >
                        <circle r={Math.round(satR * 0.42) - 1.5} />
                      </clipPath>
                    ))}
                </defs>

                {/* 先画边和卫星节点 */}
                {edges.map((edge, i) => {
                  const ang = -Math.PI / 2 + (i / Math.max(1, N)) * Math.PI * 2 + Math.PI / N;
                  const x = cx + Math.cos(ang) * R;
                  const y = cy + Math.sin(ang) * R;
                  const vis = relationCls(edge.relation, edge.relation_kind);
                  const isDead = edge.alive === false;
                  const isMarriage = edge.relation_kind === 'marriage';
                  // 边端点向圆周收一点，避免穿到节点中心
                  const dx = x - cx, dy = y - cy;
                  const len = Math.sqrt(dx * dx + dy * dy) || 1;
                  const ux = dx / len, uy = dy / len;
                  const x1 = cx + ux * (heroR + 2);
                  const y1 = cy + uy * (heroR + 2);
                  const x2 = x - ux * (satR + 2);
                  const y2 = y - uy * (satR + 2);
                  // 标签放在中点，沿垂直于连线的方向偏 10px，避免与线重叠
                  const px = -uy, py = ux;  // 垂直单位向量
                  const lx = (x1 + x2) / 2 + px * 10;
                  const ly = (y1 + y2) / 2 + py * 10 - 4;
                  return (
                    <g key={edge.with}>
                      <line
                        className={`rg-edge ${vis.cls} ${vis.dashed ? 'dashed' : ''} ${vis.dotted ? 'dotted' : ''} ${vis.thick ? 'thick' : ''} ${isDead ? 'is-dead' : ''}`}
                        x1={x1} y1={y1} x2={x2} y2={y2}
                      />
                      <text
                        className={`rg-edge-label ${vis.cls} ${isDead ? 'is-dead' : ''}`}
                        x={lx} y={ly}
                      >{edge.relation}</text>
                      <g
                        className={`rg-node ${isDead ? 'is-dead' : ''}`}
                        transform={`translate(${x},${y})`}
                        onClick={(ev) => { ev.stopPropagation(); switchHero(edge.with); }}
                      >
                        <circle className="rg-node-bg" r={satR} />
                        {/* 婚姻关系：节点外加一圈双环 */}
                        {isMarriage && (
                          <circle
                            className="rg-node-marriage-ring"
                            r={satR + 4}
                            fill="none"
                          />
                        )}
                        {edge.portrait_url && (
                          <image
                            href={`${API}${edge.portrait_url}`}
                            x={-(satR - 2)} y={-(satR - 2)}
                            width={(satR - 2) * 2} height={(satR - 2) * 2}
                            clipPath={`url(#rg-clip-${edge.with})`}
                            preserveAspectRatio="xMidYMid slice"
                          />
                        )}
                        {!edge.portrait_url && (
                          <text className="rg-node-initial" y={4}>
                            {(edge.display_name || '').slice(0, 1)}
                          </text>
                        )}
                        <text className="rg-node-name" y={satR + 16}>
                          {edge.display_name}
                        </text>
                        {edge.house && (
                          <text className="rg-node-house" y={satR + 30}>
                            {edge.house.toUpperCase()}
                          </text>
                        )}
                        {isDead && (
                          <text className="rg-node-dead" y={-(satR + 6)}>已去世</text>
                        )}
                        {/* 顶半圈卫星（sin(ang) < 0）的 companion 放主节点上方，
                            避免与 hero 一侧内容 / 邻居标签挤；底半圈仍走默认 below。*/}
                        <Companion
                          data={edge.companion}
                          parentR={satR}
                          placement={Math.sin(ang) < 0 ? 'above' : 'below'}
                          labelEndY={edge.house ? satR + 30 : satR + 16}
                          scale={0.42}
                        />
                      </g>
                    </g>
                  );
                })}

                {/* hero 中心节点 */}
                <g className={`rg-node rg-node-hero ${heroData.alive === false ? 'is-dead' : ''}`} transform={`translate(${cx},${cy})`}>
                  <circle className="rg-node-bg" r={heroR} />
                  {heroData.portrait_url && (
                    <image
                      href={`${API}${heroData.portrait_url}`}
                      x={-(heroR - 2)} y={-(heroR - 2)}
                      width={(heroR - 2) * 2} height={(heroR - 2) * 2}
                      clipPath={`url(#rg-clip-hero-${heroData.character_id})`}
                      preserveAspectRatio="xMidYMid slice"
                    />
                  )}
                  {!heroData.portrait_url && (
                    <text className="rg-node-initial" y={6}>
                      {(heroData.display_name || '').slice(0, 1)}
                    </text>
                  )}
                  <text className="rg-node-name rg-node-name-hero" y={heroR + 18}>
                    {heroData.display_name}
                  </text>
                  {heroData.house && (
                    <text className="rg-node-house" y={heroR + 32}>
                      {heroData.house.toUpperCase()}
                    </text>
                  )}
                  <Companion
                    data={heroData.companion}
                    parentR={heroR}
                    placement="below"
                    labelEndY={heroData.house ? heroR + 32 : heroR + 18}
                    scale={0.40}
                    isHero
                  />
                </g>
              </svg>
            )}
          </div>
        </div>
      </div>

      <div className="rg-legend">
        <div className="rg-legend-row"><span className="rg-swatch rel-blood thick" /> 血亲</div>
        <div className="rg-legend-row"><span className="rg-swatch rel-marriage" /> 婚姻</div>
        <div className="rg-legend-row"><span className="rg-swatch rel-ally"     /> 盟友</div>
        <div className="rg-legend-row"><span className="rg-swatch rel-friend dashed" /> 友人</div>
        <div className="rg-legend-row"><span className="rg-swatch rel-enemy"    /> 敌对</div>
        <div className="rg-legend-row"><span className="rg-swatch rel-secret dotted" /> 暗线</div>
      </div>
    </div>
  );
}
