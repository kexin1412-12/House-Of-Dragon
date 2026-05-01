import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './StorylineTimeline.css';
import useStorylineFavorites from './useStorylineFavorites';

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
const NODE_W = 124;
const NODE_H = 56;
const NODE_GAP = 64;       // 主线相邻节点的水平间距
const SIDE_OFFSET_Y = 110;  // 支线节点距主线的垂直距离
const CANVAS_PAD_X = 80;
const CANVAS_PAD_Y = 180;

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

  // 画布尺寸
  const lastMainCx = mainIds.length
    ? CANVAS_PAD_X + (mainIds.length - 1) * (NODE_W + NODE_GAP) + NODE_W / 2
    : CANVAS_PAD_X;
  const width = lastMainCx + NODE_W / 2 + CANVAS_PAD_X;
  const height = mainLineY + SIDE_OFFSET_Y + NODE_H + 60;
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
    const sx = (vw - 80) / graphSize.width;
    const sy = (vh - 80) / graphSize.height;
    const s = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(sx, sy, 1)));
    const tx = (vw - graphSize.width * s) / 2;
    const ty = (vh - graphSize.height * s) / 2;
    setView({ tx, ty, scale: s });
  }, [graphSize, viewportRef]);

  const onWheel = useCallback((e) => {
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
    setView(v => ({ ...v, tx: tx + (e.clientX - x), ty: ty + (e.clientY - y) }));
  }, []);
  const onMouseUp = useCallback(() => { dragRef.current = null; }, []);

  return { view, setScale, zoomIn, zoomOut, fit, onWheel, onMouseDown, onMouseMove, onMouseUp };
}

// ─── Node component ─────────────────────────────────────────────────
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

  return (
    <g
      className={cls}
      transform={`translate(${position.x - NODE_W / 2}, ${position.y - NODE_H / 2})`}
      onClick={(e) => { e.stopPropagation(); onClick(node.node_id); }}
    >
      {/* 节点矩形 */}
      <rect className="sx-node-rect" x={0} y={0} width={NODE_W} height={NODE_H} rx={10} ry={10} />
      {/* 当前节点的发光描边由 CSS filter / outline 模拟 */}
      <text className="sx-node-title" x={NODE_W / 2} y={22} textAnchor="middle">
        {locked ? '???' : node.title}
      </text>
      <text className="sx-node-time" x={NODE_W / 2} y={40} textAnchor="middle">
        {locked ? '' : formatMMSS(node.start_time)}
      </text>
      {/* 锁图标 (隐藏支线未解锁时) */}
      {locked && (
        <text className="sx-node-lock" x={NODE_W / 2} y={42} textAnchor="middle">🔒</text>
      )}
      {/* 已观看 ✓ 标记 */}
      {state === 'watched' && !locked && (
        <text className="sx-node-watched" x={NODE_W - 10} y={NODE_H - 6} textAnchor="end">✓</text>
      )}
      {/* 当前节点 ▶ 指示在节点下方 */}
      {isCurrent && !locked && (
        <g transform={`translate(${NODE_W / 2}, ${NODE_H + 14})`} className="sx-node-current-mark">
          <path d="M -5 -5 L 5 -5 L 0 5 Z" />
        </g>
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

  return (
    <aside className="sx-detail-panel">
      <button className="sx-detail-close" onClick={onClose} title="关闭">×</button>
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

export default function StorylineTimeline({
  storyline, currentTime, videoId, onJumpTo,
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
