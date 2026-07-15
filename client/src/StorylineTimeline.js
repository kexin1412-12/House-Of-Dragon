import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './StorylineTimeline.css';
import useStorylineFavorites from './useStorylineFavorites';
import { getChoices } from './stanceStore';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 1.2;

// "main" 节点用 chapter-bar 模式无缝瓜分时长；"side" 节点窗口短，独立判定。
function nodeStateAt(node, currentTime) {
  if (currentTime >= node.end_time) return 'watched';
  if (currentTime >= node.start_time) return 'current';
  return 'upcoming';
}

function formatMMSS(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

// SVG 画布几何 —— 主线节点等距铺开（横向 spacing 由序号决定，不按时长比例，
// 否则前面密后面稀；参考图也是等距）。支线挂在 after_node_id 主线节点上方/下方。
// 展开态：节点是"上缩略图 + 下标题 + 时间"的纵向卡片（视觉锚点更强）。
const NODE_W = 200;
const NODE_H = 168;
const THUMB_W = 184;
const THUMB_H = 104;
const NODE_GAP = 36;        // 主线相邻节点的水平间距
const SIDE_OFFSET_Y = 240;  // 支线节点距主线的垂直距离（中心到中心）
const CANVAS_PAD_X = 60;
// 上下 padding 给支线节点留呼吸空间。mainLineY 必须 >= CANVAS_PAD_TOP +
// NODE_H/2 + SIDE_OFFSET_Y，否则 above 支线会被画到 y<0（在 SVG 画布外，
// 默认 fit 都看不到，往上拖更直接消失）。
const CANVAS_PAD_TOP = 40;
const CANVAS_PAD_BOTTOM = 40;
const CANVAS_PAD_Y = CANVAS_PAD_TOP + NODE_H / 2 + SIDE_OFFSET_Y;  // = mainLineY

// 把主线节点按 narrative_function 的连续段切成幕段，给顶部进度带用。
function computePhases(storyline, allNodesById) {
  if (!storyline) return [];
  const ids = storyline.main_track_node_ids || [];
  const phases = [];
  let cur = null;
  for (const id of ids) {
    const n = allNodesById[id];
    if (!n) continue;
    if (cur && cur.label === n.narrative_function) {
      cur.end = n.end_time;
      cur.lastIdx = ids.indexOf(id);
    } else {
      if (cur) phases.push(cur);
      cur = {
        label: n.narrative_function,
        start: n.start_time,
        end: n.end_time,
        firstIdx: ids.indexOf(id),
        lastIdx: ids.indexOf(id),
      };
    }
  }
  if (cur) phases.push(cur);
  return phases;
}

// 支线交替 above/below：第 i 条支线放在 [上, 下, 上, ...] 之一。
function sideTrackSide(i) { return i % 2 === 0 ? 'above' : 'below'; }

function computeLayout(storyline) {
  if (!storyline) return { positions: {}, width: 0, height: 0, mainLineY: 0, sideTracksMeta: [] };
  const positions = {};
  const mainIds = storyline.main_track_node_ids || [];
  const mainLineY = CANVAS_PAD_Y;

  // 主线
  mainIds.forEach((id, idx) => {
    const cx = CANVAS_PAD_X + idx * (NODE_W + NODE_GAP) + NODE_W / 2;
    positions[id] = { x: cx, y: mainLineY, kind: 'main' };
  });

  // 支线
  const sideTracksMeta = [];
  (storyline.side_tracks || []).forEach((st, i) => {
    const anchor = positions[st.after_node_id];
    if (!anchor) return;
    const side = sideTrackSide(i);
    const dy = side === 'above' ? -SIDE_OFFSET_Y : SIDE_OFFSET_Y;
    // 单条支线 1 个节点 → 直接放在 after_node 的正上/下，水平+ 半个 gap 偏右
    (st.node_ids || []).forEach((nid, j) => {
      const cx = anchor.x + (j + 1) * (NODE_W * 0.5 + NODE_GAP * 0.5);
      const cy = anchor.y + dy;
      positions[nid] = { x: cx, y: cy, kind: 'side' };
    });
    sideTracksMeta.push({ ...st, side });
  });

  // 画布尺寸：扫所有节点（含支线）的实际 x/y 外延，主线 lastMainCx 不够 ——
  // 支线节点挂在 anchor.x + 118 处，最后一个主线节点的 above 支线会超出主线 width。
  // 之前漏算这部分 → fit 看不全 + pan 边界用错的 gw 把节点截断在视口外。
  let maxX = CANVAS_PAD_X;
  let maxY = mainLineY;
  for (const id of Object.keys(positions)) {
    const p = positions[id];
    maxX = Math.max(maxX, p.x + NODE_W / 2);
    maxY = Math.max(maxY, p.y + NODE_H / 2);
  }
  const width = maxX + CANVAS_PAD_X;
  const height = Math.max(
    mainLineY + SIDE_OFFSET_Y + NODE_H / 2 + CANVAS_PAD_BOTTOM,
    maxY + CANVAS_PAD_BOTTOM,
  );
  return { positions, width, height, mainLineY, sideTracksMeta };
}

// ─── Pan/zoom hook ──────────────────────────────────────────────────
function useViewport(graphSize, viewportRef) {
  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 });
  const dragRef = useRef(null);

  const setScale = useCallback((nextScale, anchorX, anchorY) => {
    setView(v => {
      const s = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextScale));
      // 围绕 viewport 的 (anchorX, anchorY) 缩放
      const ax = anchorX ?? (viewportRef.current?.clientWidth || 0) / 2;
      const ay = anchorY ?? (viewportRef.current?.clientHeight || 0) / 2;
      // 把锚点反推回 graph 坐标，再用新 scale 重新算 t
      const gx = (ax - v.tx) / v.scale;
      const gy = (ay - v.ty) / v.scale;
      const tx = ax - gx * s;
      const ty = ay - gy * s;
      return { tx, ty, scale: s };
    });
  }, [viewportRef]);

  const zoomIn = useCallback(() => setScale((view.scale || 1) * ZOOM_STEP), [setScale, view.scale]);
  const zoomOut = useCallback(() => setScale((view.scale || 1) / ZOOM_STEP), [setScale, view.scale]);

  const fit = useCallback(() => {
    const vw = viewportRef.current?.clientWidth || 0;
    const vh = viewportRef.current?.clientHeight || 0;
    if (!vw || !vh || !graphSize.width || !graphSize.height) return;
    // viewport 内边距小一点（24px）—— 画布自身已经有 CANVAS_PAD_TOP/BOTTOM 留了
    // 支线呼吸位，再叠 80px 双重 padding 会让默认 fit 缩得太狠看不清字。
    const sx = (vw - 24) / graphSize.width;
    const sy = (vh - 24) / graphSize.height;
    const s = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(sx, sy, 1)));
    const tx = (vw - graphSize.width * s) / 2;
    const ty = (vh - graphSize.height * s) / 2;
    setView({ tx, ty, scale: s });
  }, [graphSize, viewportRef]);

  // 滚轮事件：必须按住 Ctrl/Cmd 才触发缩放，平时让浏览器正常滚页面。
  // 否则用户上下翻页时鼠标飘过画布，scroll 会被劫持成缩放——非常烦。
  const onWheel = useCallback((e) => {
    if (!(e.ctrlKey || e.metaKey)) return;   // 让事件冒泡，浏览器按页面滚动处理
    e.preventDefault();
    const rect = viewportRef.current?.getBoundingClientRect();
    const ax = rect ? e.clientX - rect.left : 0;
    const ay = rect ? e.clientY - rect.top : 0;
    const dir = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    setScale((view.scale || 1) * dir, ax, ay);
  }, [setScale, view.scale, viewportRef]);

  const onMouseDown = useCallback((e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  }, [view]);
  const onMouseMove = useCallback((e) => {
    if (!dragRef.current) return;
    const { x, y, tx, ty } = dragRef.current;
    setView(v => {
      const nextTx = tx + (e.clientX - x);
      const nextTy = ty + (e.clientY - y);
      // pan 软边界：至少保证 graph 在 viewport 内有 120px 可见，
      // 防止用户把整张图拖到屏幕外（特别是支线节点贴上沿时往上一拖就消失）
      const vw = viewportRef.current?.clientWidth || 0;
      const vh = viewportRef.current?.clientHeight || 0;
      const gw = graphSize.width  * v.scale;
      const gh = graphSize.height * v.scale;
      const MARGIN = 120;
      const minTx = -gw + MARGIN;       // graph 右边只能拖到 viewport 左边 +120 处
      const maxTx = vw - MARGIN;        // graph 左边只能拖到 viewport 右边 -120 处
      const minTy = -gh + MARGIN;
      const maxTy = vh - MARGIN;
      return {
        ...v,
        tx: Math.max(minTx, Math.min(maxTx, nextTx)),
        ty: Math.max(minTy, Math.min(maxTy, nextTy)),
      };
    });
  }, [graphSize, viewportRef]);
  const onMouseUp = useCallback(() => { dragRef.current = null; }, []);

  return { view, setScale, zoomIn, zoomOut, fit, onWheel, onMouseDown, onMouseMove, onMouseUp };
}

// ─── Node component ─────────────────────────────────────────────────
// 展开态布局：上缩略图（184×104）+ 下信息区（标题 + 时间 + ✓）。
// 锁住的支线节点：缩略图位置变成虚线占位 + 🔒，标题改 "???"。
function StoryNode({
  node, position, state, locked, isCurrent, isSelected, onClick,
}) {
  if (!position) return null;
  const isCriticalTurn = node.narrative_function === '关键转折';
  const cls = [
    'sx-node',
    `sx-node-${node.track}`,
    locked ? 'is-locked' : '',
    state === 'watched' ? 'is-watched' : '',
    isCurrent ? 'is-current' : '',
    isSelected ? 'is-selected' : '',
    isCriticalTurn ? 'is-critical-turn' : '',
  ].filter(Boolean).join(' ');

  const thumbX = (NODE_W - THUMB_W) / 2;
  const thumbY = 8;
  const titleY = thumbY + THUMB_H + 22;
  const timeY = titleY + 18;

  // 同源相对路径（client/public/kb/frames/... 直接由 client 静态托管）
  const thumbHref = (!locked && node.keyframe) ? `/kb/${node.keyframe}` : null;

  return (
    <g
      className={cls}
      transform={`translate(${position.x - NODE_W / 2}, ${position.y - NODE_H / 2})`}
      onClick={(e) => { e.stopPropagation(); onClick(node.node_id); }}
    >
      {/* 节点矩形 */}
      <rect className="sx-node-rect" x={0} y={0} width={NODE_W} height={NODE_H} rx={10} ry={10} />

      {/* 缩略图占位底色 */}
      <rect
        className="sx-node-thumb-bg"
        x={thumbX} y={thumbY} width={THUMB_W} height={THUMB_H} rx={6} ry={6}
      />
      {thumbHref && (
        <image
          href={thumbHref}
          x={thumbX} y={thumbY} width={THUMB_W} height={THUMB_H}
          preserveAspectRatio="xMidYMid slice"
          style={{ clipPath: 'inset(0 round 6px)' }}
        />
      )}

      {/* 锁图标（隐藏支线未解锁时，画在缩略图位置中央） */}
      {locked && (
        <text
          className="sx-node-lock"
          x={thumbX + THUMB_W / 2}
          y={thumbY + THUMB_H / 2 + 8}
          textAnchor="middle"
        >🔒</text>
      )}

      {/* 标题（缩略图下方居中） */}
      <text
        className="sx-node-title"
        x={NODE_W / 2}
        y={titleY}
        textAnchor="middle"
      >{locked ? '???' : node.title}</text>

      {/* 时间（标题下方居中） */}
      {!locked && (
        <text
          className="sx-node-time"
          x={NODE_W / 2}
          y={timeY}
          textAnchor="middle"
        >{formatMMSS(node.start_time)}</text>
      )}

      {/* 已观看 ✓ 标记（右下角内嵌） */}
      {state === 'watched' && !locked && (
        <text
          className="sx-node-watched"
          x={NODE_W - 12}
          y={NODE_H - 10}
          textAnchor="end"
        >✓</text>
      )}
    </g>
  );
}

// ─── Detail side panel (右侧滑入) ──────────────────────────────────
function NodeDetailPanel({ node, allNodesById, onSelectNode, onJumpTo, fav, onToggleFav, onClose }) {
  if (!node) return null;
  const [prevId, nextId] = node.related_node_ids || [null, null];
  const prevNode = prevId ? allNodesById[prevId] : null;
  const nextNode = nextId ? allNodesById[nextId] : null;

  const thumbHref = node.keyframe ? `/kb/${node.keyframe}` : null;

  return (
    <aside className="sx-detail-panel">
      <button className="sx-detail-close" onClick={onClose} title="关闭">×</button>
      {thumbHref && (
        <div className="sx-detail-thumb">
          <img src={thumbHref} alt={node.title} />
        </div>
      )}
      <div className="sx-detail-header">
        <div className="sx-detail-title">{node.title}</div>
        <div className="sx-detail-time">{formatMMSS(node.start_time)}</div>
      </div>

      <section className="sx-detail-section">
        <div className="sx-detail-section-label">
          <span className="sx-icon">📖</span> 叙事功能：<strong>{node.narrative_function}</strong>
        </div>
        <div className="sx-detail-section-body">{node.summary}</div>
      </section>

      <section className="sx-detail-section">
        <div className="sx-detail-section-label">
          <span className="sx-icon">✨</span> 对剧情的影响
        </div>
        <div className="sx-detail-section-body">{node.impact}</div>
      </section>

      {(prevNode || nextNode) && (
        <section className="sx-detail-section">
          <div className="sx-detail-section-label">
            <span className="sx-icon">🔗</span> 相关节点
          </div>
          <div className="sx-detail-related-chips">
            {prevNode && (
              <button className="sx-chip" onClick={() => onSelectNode(prevNode.node_id)}>
                {prevNode.title} <span className="sx-chip-time">{formatMMSS(prevNode.start_time)}</span>
              </button>
            )}
            {nextNode && (
              <button className="sx-chip" onClick={() => onSelectNode(nextNode.node_id)}>
                {nextNode.title} <span className="sx-chip-time">{formatMMSS(nextNode.start_time)}</span>
              </button>
            )}
          </div>
          <div className="sx-detail-arrow-row">
            {prevNode ? (
              <button className="sx-detail-arrow" onClick={() => onSelectNode(prevNode.node_id)}>← 前序</button>
            ) : <span />}
            {nextNode ? (
              <button className="sx-detail-arrow" onClick={() => onSelectNode(nextNode.node_id)}>后续 →</button>
            ) : <span />}
          </div>
        </section>
      )}

      <div className="sx-detail-actions">
        <button className="sx-btn sx-btn-primary" onClick={() => onJumpTo(node.start_time)}>
          ▶ 跳到此节点
        </button>
        <button
          className={`sx-btn sx-btn-secondary${fav ? ' is-active' : ''}`}
          onClick={onToggleFav}
        >
          {fav ? '✓ 已收藏片段' : '🔖 标记为片段'}
        </button>
      </div>
    </aside>
  );
}

// ─── Main component ─────────────────────────────────────────────────
const VIEW_MODES = [
  { id: 'main',       label: '主线' },
  { id: 'branch',     label: '分支' },
  { id: 'foreshadow', label: '伏笔线索' },
];

// 把每个 stance trigger 锚到时间窗包含它的主线节点。多个 trigger 同节点
// 时按时间排序后纵向 stack（避免横向跟相邻节点的 marker 撞）。
function anchorStanceTriggers(triggers, mainNodes) {
  if (!triggers || triggers.length === 0 || mainNodes.length === 0) return [];
  const groups = new Map();
  for (const tg of triggers) {
    let anchor = mainNodes[0];
    for (const n of mainNodes) {
      if (tg.timestamp >= n.start_time) anchor = n;
      else break;
    }
    if (!groups.has(anchor.node_id)) groups.set(anchor.node_id, []);
    groups.get(anchor.node_id).push(tg);
  }
  const out = [];
  for (const [nodeId, list] of groups) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    list.forEach((tg, idx) => out.push({ tg, anchorNodeId: nodeId, stackIdx: idx, stackTotal: list.length }));
  }
  return out;
}

function truncateZh(s, n = 7) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 单个立场触发点 marker：对话气泡 + 已投选项小标签 + 锁状态
function StanceMarker({ trigger, x, y, choice, locked, onClick }) {
  return (
    <g
      className={`sx-stance-mark ${choice ? 'is-voted' : ''} ${locked ? 'is-locked' : ''}`}
      transform={`translate(${x}, ${y})`}
      onClick={(e) => { if (locked) return; e.stopPropagation(); onClick(trigger.trigger_id); }}
      style={{ cursor: locked ? 'default' : 'pointer' }}
    >
      <title>
        {locked
          ? `锁定中（视频未播到此处） · ${trigger.scene_label || ''}`
          : (choice ? `你投了：${choice.option_label} · 点击重新选` : `${trigger.scene_label || '立场抉择'} · 点击表态`)}
      </title>

      {/* 气泡主体 */}
      <rect
        className="sx-stance-bubble"
        x={-13} y={-11}
        width={26} height={18}
        rx={5} ry={5}
      />
      {/* 三个对话点 */}
      <circle className="sx-stance-bubble-dot" cx={-6} cy={-2} r={1.4} />
      <circle className="sx-stance-bubble-dot" cx={0}  cy={-2} r={1.4} />
      <circle className="sx-stance-bubble-dot" cx={6}  cy={-2} r={1.4} />
      {/* 气泡尾巴 */}
      <path className="sx-stance-bubble-tail" d="M -3 7 L 0 11 L 3 7 Z" />

      {/* 已投：小金点徽章 */}
      {choice && !locked && (
        <circle className="sx-stance-vote-dot" cx={11} cy={-9} r={3.2} />
      )}

      {/* 已投：选项小标签 */}
      {choice && !locked && (
        <g transform="translate(0, 24)">
          <rect className="sx-stance-label-bg" x={-44} y={-9} width={88} height={18} rx={9} />
          <text className="sx-stance-label-text" x={0} y={3.5} textAnchor="middle">
            你投了：{truncateZh(choice.option_label, 5)}
          </text>
        </g>
      )}
    </g>
  );
}

export default function StorylineTimeline({
  storyline, currentTime, videoId, onJumpTo,
  stanceTriggers = [], onOpenStance,
}) {
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [unlockedSet, setUnlockedSet] = useState(() => new Set());
  const [viewMode, setViewMode] = useState('branch');
  const viewportRef = useRef(null);
  const { isFav, toggle: toggleFav } = useStorylineFavorites();

  const allNodesById = useMemo(() => {
    const m = {};
    for (const n of (storyline?.nodes || [])) m[n.node_id] = n;
    return m;
  }, [storyline]);

  // 立场触发点锚到时间窗包含它的主线节点。重算时机：trigger 列表 / 主线变化时。
  // userChoices 用 currentTime 当 dep —— 每次播放推进 / 投完票 dismiss 后父组件重渲，
  // 顺势重读 localStorage。
  const mainNodes = useMemo(() => {
    if (!storyline) return [];
    const ids = storyline.main_track_node_ids || [];
    return ids.map(id => allNodesById[id]).filter(Boolean);
  }, [storyline, allNodesById]);

  const anchoredStance = useMemo(
    () => anchorStanceTriggers(stanceTriggers, mainNodes),
    [stanceTriggers, mainNodes]
  );

  const userChoicesByTrigger = useMemo(() => {
    const m = {};
    for (const c of getChoices()) m[c.trigger_id] = c;
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stanceTriggers, currentTime]);

  const layout = useMemo(() => computeLayout(storyline), [storyline]);
  const viewport = useViewport(layout, viewportRef);
  const phases = useMemo(() => computePhases(storyline, allNodesById), [storyline, allNodesById]);

  // viewMode 决定哪些 track 可见
  const isNodeVisible = useCallback((node) => {
    if (!node) return false;
    if (viewMode === 'main') return node.track === 'main';
    if (viewMode === 'foreshadow') return !!node.is_hidden;
    // branch (default)
    return true;
  }, [viewMode]);

  // 首次有 layout 时自动 fit
  const fittedRef = useRef(false);
  useEffect(() => {
    if (fittedRef.current) return;
    if (!layout.width) return;
    fittedRef.current = true;
    // 推迟一帧让 viewport ref 拿到尺寸
    requestAnimationFrame(() => viewport.fit());
  }, [layout.width, viewport]);

  // 解锁 hidden 节点：currentTime >= start_time 即解锁。运行时副本，不持久化但
  // 不翻回——seek 回前面也保持解锁，避免观众回看时隐藏再藏起来。
  useEffect(() => {
    if (!storyline) return;
    setUnlockedSet(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const n of storyline.nodes) {
        if (!n.is_hidden) continue;
        if (next.has(n.node_id)) continue;
        if (currentTime >= n.start_time) {
          next.add(n.node_id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [currentTime, storyline]);

  // 找当前主线节点（最多一个）
  const currentMainId = useMemo(() => {
    if (!storyline) return null;
    for (const id of (storyline.main_track_node_ids || [])) {
      const n = allNodesById[id];
      if (!n) continue;
      if (currentTime >= n.start_time && currentTime < n.end_time) return id;
    }
    return null;
  }, [storyline, currentTime, allNodesById]);

  const selectedNode = selectedNodeId ? allNodesById[selectedNodeId] : null;

  const onClickNode = useCallback((nodeId) => {
    const node = allNodesById[nodeId];
    if (!node) return;
    // 锁住的节点不响应点击
    if (node.is_hidden && !unlockedSet.has(nodeId)) return;
    setSelectedNodeId(prev => prev === nodeId ? null : nodeId);
  }, [allNodesById, unlockedSet]);

  const onCanvasClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const handleJump = useCallback((t) => {
    onJumpTo?.(t);
  }, [onJumpTo]);

  const handleToggleFav = useCallback(() => {
    if (!selectedNode) return;
    toggleFav({
      videoId,
      nodeId: selectedNode.node_id,
      title: selectedNode.title,
      start_time: selectedNode.start_time,
      end_time: selectedNode.end_time,
      narrative_function: selectedNode.narrative_function,
      summary: selectedNode.summary,
      track: selectedNode.track,
    });
  }, [selectedNode, toggleFav, videoId]);

  // 主线相邻节点之间的实线连接（带 turn flag：边的两端任一是关键转折，则在中点画菱标）
  const mainEdges = useMemo(() => {
    const edges = [];
    const ids = storyline?.main_track_node_ids || [];
    for (let i = 0; i < ids.length - 1; i++) {
      const a = layout.positions[ids[i]];
      const b = layout.positions[ids[i + 1]];
      if (!a || !b) continue;
      const na = allNodesById[ids[i]];
      const nb = allNodesById[ids[i + 1]];
      const turn = na?.narrative_function === '关键转折' || nb?.narrative_function === '关键转折';
      edges.push({ key: `me-${i}`, a, b, turn });
    }
    return edges;
  }, [storyline, layout, allNodesById]);

  // 支线虚线连接：从 after_node 到第一个支线节点
  const sideEdges = useMemo(() => {
    const edges = [];
    (layout.sideTracksMeta || []).forEach((st, i) => {
      const anchor = layout.positions[st.after_node_id];
      const first = layout.positions[(st.node_ids || [])[0]];
      if (!anchor || !first) return;
      edges.push({ key: `se-${i}`, a: anchor, b: first, locked: !unlockedSet.has(st.node_ids[0]) });
    });
    return edges;
  }, [layout, unlockedSet]);

  if (!storyline) {
    return <div className="sx-tl-empty">本集暂无叙事 X 光数据。</div>;
  }

  return (
    <div className="sx-tl-root">
      {/* 顶部幕段进度带：按 narrative_function 的连续段切，每段是一节 */}
      {phases.length > 0 && (
        <div className="sx-tl-phases" aria-hidden="true">
          {phases.map((p, i) => (
            <div key={i} className="sx-tl-phase">
              <div className="sx-tl-phase-label">{p.label}</div>
              <div className="sx-tl-phase-range">
                {formatMMSS(p.start)} - {formatMMSS(p.end)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 主区 SVG */}
      <div
        className="sx-tl-viewport"
        ref={viewportRef}
        onWheel={viewport.onWheel}
        onMouseDown={viewport.onMouseDown}
        onMouseMove={viewport.onMouseMove}
        onMouseUp={viewport.onMouseUp}
        onMouseLeave={viewport.onMouseUp}
        onClick={onCanvasClick}
      >
        <svg
          className="sx-tl-svg"
          width={layout.width}
          height={layout.height}
          style={{
            transform: `translate(${viewport.view.tx}px, ${viewport.view.ty}px) scale(${viewport.view.scale})`,
            transformOrigin: '0 0',
          }}
        >
          {/* 主线连接 + 边上的关键转折菱标（取代节点上方的菱标） */}
          <g className="sx-edges-main">
            {mainEdges.map(e => {
              const x1 = e.a.x + NODE_W / 2;
              const x2 = e.b.x - NODE_W / 2;
              const y  = e.a.y;
              return (
                <g key={e.key}>
                  <line x1={x1} y1={y} x2={x2} y2={y} />
                  {e.turn && viewMode !== 'foreshadow' && (
                    <g transform={`translate(${(x1 + x2) / 2}, ${y})`} className="sx-edge-turn-mark">
                      <path d="M 0 -7 L 7 0 L 0 7 L -7 0 Z" />
                    </g>
                  )}
                </g>
              );
            })}
          </g>

          {/* 支线连接（main 模式不画支线边） */}
          {viewMode !== 'main' && (
            <g className="sx-edges-side">
              {sideEdges.map(e => {
                const sideNode = allNodesById[e.b && Object.keys(layout.positions).find(k => layout.positions[k] === e.b)];
                // 在 foreshadow 模式下只画通往隐藏节点的边
                if (viewMode === 'foreshadow' && sideNode && !sideNode.is_hidden) return null;
                const fromX = e.a.x;
                const fromY = e.b.y < e.a.y ? e.a.y - NODE_H / 2 : e.a.y + NODE_H / 2;
                const toX = e.b.x;
                const toY = e.b.y < e.a.y ? e.b.y + NODE_H / 2 : e.b.y - NODE_H / 2;
                const midY = (fromY + toY) / 2;
                const path = `M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`;
                return (
                  <path
                    key={e.key}
                    d={path}
                    className={`sx-edge-side ${e.locked ? 'is-locked' : ''}`}
                    fill="none"
                  />
                );
              })}
            </g>
          )}

          {/* 节点 —— 视图模式过滤 */}
          <g className="sx-nodes">
            {(storyline.nodes || []).filter(isNodeVisible).map(n => {
              const pos = layout.positions[n.node_id];
              if (!pos) return null;
              const locked = !!n.is_hidden && !unlockedSet.has(n.node_id);
              const state = nodeStateAt(n, currentTime);
              const isCurrent = n.track === 'main' ? currentMainId === n.node_id : false;
              const isSelected = selectedNodeId === n.node_id;
              return (
                <StoryNode
                  key={n.node_id}
                  node={n}
                  position={pos}
                  state={state}
                  locked={locked}
                  isCurrent={isCurrent}
                  isSelected={isSelected}
                  onClick={onClickNode}
                />
              );
            })}
          </g>

          {/* 立场投票点 marker —— 浮在主线节点正上方，跟视频时间锁定。
              foreshadow 模式下主线节点不可见 → marker 也跟着藏起来。 */}
          {viewMode !== 'foreshadow' && anchoredStance.length > 0 && (
            <g className="sx-stance-marks">
              {anchoredStance.map(({ tg, anchorNodeId, stackIdx, stackTotal }) => {
                const anchor = layout.positions[anchorNodeId];
                if (!anchor) return null;
                const offsetX = stackTotal === 1 ? 0 : (stackIdx - (stackTotal - 1) / 2) * 60;
                const x = anchor.x + offsetX;
                const y = layout.mainLineY - NODE_H / 2 - 30;
                const choice = userChoicesByTrigger[tg.trigger_id];
                const locked = currentTime < tg.timestamp;
                if (locked) return null;
                return (
                  <StanceMarker
                    key={tg.trigger_id}
                    trigger={tg}
                    x={x} y={y}
                    choice={choice}
                    locked={locked}
                    onClick={onOpenStance}
                  />
                );
              })}
            </g>
          )}
        </svg>
      </div>

      {/* 底部一行：图例 + 视图模式 + 缩放 */}
      <div className="sx-tl-bottom-bar">
        <div className="sx-tl-legend">
          <span className="sx-tl-legend-title">图例说明</span>
          <span className="sx-legend-item"><span className="sx-legend-swatch sx-sw-watched" /> 已完成</span>
          <span className="sx-legend-item"><span className="sx-legend-swatch sx-sw-current" /> 当前节点</span>
          <span className="sx-legend-item"><span className="sx-legend-mark sx-sw-turn">◆</span> 关键转折</span>
          <span className="sx-legend-item"><span className="sx-legend-mark sx-sw-side">---</span> 分支线索</span>
          <span className="sx-legend-item"><span className="sx-legend-swatch sx-sw-locked" /> 隐藏节点</span>
          {anchoredStance.length > 0 && (
            <span className="sx-legend-item">
              <span className="sx-legend-mark sx-sw-stance" aria-hidden="true">
                <svg width="14" height="11" viewBox="-13 -11 26 18">
                  <rect x={-10} y={-8} width={20} height={14} rx={4} fill="rgba(201,165,92,0.85)" />
                </svg>
              </span>
              立场投票点
            </span>
          )}
        </div>

        <div className="sx-tl-viewmode">
          <span className="sx-tl-bottom-label">视图模式</span>
          {VIEW_MODES.map(m => (
            <button
              key={m.id}
              className={`sx-tl-mode-btn${viewMode === m.id ? ' is-active' : ''}`}
              onClick={() => setViewMode(m.id)}
            >{m.label}</button>
          ))}
        </div>

        <div className="sx-tl-zoom">
          <span className="sx-tl-bottom-label">缩放</span>
          <button onClick={viewport.zoomOut} title="缩小">−</button>
          <span className="sx-tl-zoom-level">{Math.round(viewport.view.scale * 100)}%</span>
          <button onClick={viewport.zoomIn} title="放大">＋</button>
          <button onClick={viewport.fit} title="适配画布" className="sx-tl-zoom-fit">⟲</button>
        </div>
      </div>

      {/* 详情侧栏 */}
      {selectedNode && (
        <NodeDetailPanel
          node={selectedNode}
          allNodesById={allNodesById}
          onSelectNode={setSelectedNodeId}
          onJumpTo={handleJump}
          fav={isFav(videoId, selectedNode.node_id)}
          onToggleFav={handleToggleFav}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
    </div>
  );
}
