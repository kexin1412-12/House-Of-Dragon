import React, { useEffect, useState } from 'react';
import './TrajectoryChart.css';
import { computeTrajectory, classifyType, resetAll } from './stanceStore';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// 季末（或随时）打开的"立场轨迹图"。读 localStorage，无后端依赖。
// 如果还没做过任何选择 → 占位文案；做过至少 1 个 → 渲染 sparkline + 类型卡。

export default function TrajectoryChart({ open, show = 'house-of-the-dragon', onClose }) {
  const [trajectory, setTrajectory] = useState([]);
  const [typesCatalog, setTypesCatalog] = useState(null);
  const [persona, setPersona] = useState(null);

  useEffect(() => {
    if (!open) return;
    const traj = computeTrajectory();
    setTrajectory(traj);
  }, [open]);

  useEffect(() => {
    if (!open || !show) return;
    let cancelled = false;
    fetch(`${API}/api/stance/types?show=${encodeURIComponent(show)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled) setTypesCatalog(data); })
      .catch(() => { if (!cancelled) setTypesCatalog(null); });
    return () => { cancelled = true; };
  }, [open, show]);

  useEffect(() => {
    if (!typesCatalog) { setPersona(null); return; }
    setPersona(classifyType(trajectory, typesCatalog));
  }, [trajectory, typesCatalog]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const total = trajectory.reduce((s, p) => s + p.effective_score, 0);
  const factionLabel = total > 0 ? '黑党' : (total < 0 ? '绿党' : '中立');
  const factionColor = total > 0 ? '#b04a4a' : (total < 0 ? '#4a8a5e' : '#94835a');

  function handleReset() {
    if (!window.confirm('确定要清空你所有的立场选择？此操作不可撤销。')) return;
    resetAll();
    setTrajectory([]);
    setPersona(null);
  }

  return (
    <div className="trc-root" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="trc-card" onClick={e => e.stopPropagation()}>

        <button className="trc-close" onClick={onClose} title="关闭 (Esc)" aria-label="关闭">×</button>

        <div className="trc-header">
          <div className="trc-eyebrow">你的立场轨迹</div>
          <h2 className="trc-title">第一季 · 你站在哪边</h2>
        </div>

        {trajectory.length === 0 ? (
          <div className="trc-empty">
            <p>还没有立场记录。</p>
            <p className="trc-empty-sub">在剧情的关键转折点做出第一次选择，就会出现在这里。</p>
          </div>
        ) : (
          <>
            <Sparkline points={trajectory} />

            <div className="trc-summary">
              <div className="trc-summary-item">
                <span className="trc-summary-label">最终阵营</span>
                <span className="trc-summary-value" style={{ color: factionColor }}>
                  {factionLabel} ({total > 0 ? '+' : ''}{total})
                </span>
              </div>
              <div className="trc-summary-item">
                <span className="trc-summary-label">触发点</span>
                <span className="trc-summary-value">{trajectory.length}</span>
              </div>
              <div className="trc-summary-item">
                <span className="trc-summary-label">动摇 / 倒戈</span>
                <span className="trc-summary-value">
                  {trajectory.filter(p => p.had_recall && p.recall_outcome !== 'hold_position').length} 次
                </span>
              </div>
            </div>

            {persona && (
              <div className="trc-persona">
                <div className="trc-persona-label">你的类型</div>
                <div className="trc-persona-name">{persona.label}</div>
                <div className="trc-persona-tagline">"{persona.tagline}"</div>
                <div className="trc-persona-desc">{persona.description}</div>
              </div>
            )}

            <ChoiceList points={trajectory} />

            <div className="trc-actions">
              <button className="trc-btn trc-btn-ghost" onClick={handleReset}>
                重置我的轨迹
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// 小型轨迹折线图：x = 选择序号，y = cumulative score。
function Sparkline({ points }) {
  if (points.length === 0) return null;

  const W = 560, H = 140, PAD_X = 24, PAD_Y = 22;
  const maxAbs = Math.max(2, ...points.map(p => Math.abs(p.cumulative)));
  const xStep = points.length === 1 ? 0 : (W - 2 * PAD_X) / (points.length - 1);
  const yMid = H / 2;
  const yScale = (H / 2 - PAD_Y) / maxAbs;

  const coords = points.map((p, i) => ({
    x: PAD_X + xStep * i + (points.length === 1 ? (W - 2 * PAD_X) / 2 : 0),
    y: yMid - p.cumulative * yScale,
    cumulative: p.cumulative,
    faction: p.faction,
    label: p.scene_label,
    hadRecall: p.had_recall,
  }));

  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');

  return (
    <svg className="trc-sparkline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="立场轨迹折线图">
      {/* 中线（中立基准） */}
      <line x1={PAD_X} y1={yMid} x2={W - PAD_X} y2={yMid}
            stroke="rgba(190,150,80,0.18)" strokeDasharray="2 4" />

      {/* 顶部/底部阵营标签 */}
      <text x={W - PAD_X} y={PAD_Y - 6} textAnchor="end"
            fill="#b04a4a" fontSize="10" letterSpacing="0.1em">黑党 ↑</text>
      <text x={W - PAD_X} y={H - PAD_Y + 14} textAnchor="end"
            fill="#4a8a5e" fontSize="10" letterSpacing="0.1em">绿党 ↓</text>

      {/* 折线 */}
      {points.length > 1 && (
        <path d={pathD} fill="none"
              stroke="rgba(220,180,100,0.55)" strokeWidth="1.4" />
      )}

      {/* 节点 */}
      {coords.map((c, i) => {
        const fill = c.faction === 'black' ? '#b04a4a'
                   : c.faction === 'green' ? '#4a8a5e'
                   : '#94835a';
        return (
          <g key={i}>
            <circle cx={c.x} cy={c.y} r={5} fill={fill}
                    stroke={c.hadRecall ? '#dba953' : 'rgba(0,0,0,0.4)'}
                    strokeWidth={c.hadRecall ? 1.5 : 1} />
            <title>{c.label} · 累计 {c.cumulative > 0 ? '+' : ''}{c.cumulative}</title>
          </g>
        );
      })}
    </svg>
  );
}

function ChoiceList({ points }) {
  if (points.length === 0) return null;
  return (
    <div className="trc-list">
      <div className="trc-list-title">选择历史</div>
      <ul>
        {points.map((p, i) => (
          <li key={i} className="trc-list-item">
            <span className="trc-list-idx">#{i + 1}</span>
            <span className="trc-list-label">{p.scene_label}</span>
            <span
              className={`trc-list-score trc-list-score-${p.faction}`}
              title={p.had_recall ? `经回顾后：${p.effective_score > 0 ? '+' : ''}${p.effective_score}（原 ${p.raw_score > 0 ? '+' : ''}${p.raw_score}）` : ''}
            >
              {p.had_recall && p.effective_score !== p.raw_score
                ? <><s>{p.raw_score > 0 ? '+' : ''}{p.raw_score}</s> → {p.effective_score > 0 ? '+' : ''}{p.effective_score}</>
                : <>{p.raw_score > 0 ? '+' : ''}{p.raw_score}</>
              }
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
