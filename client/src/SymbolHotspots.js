import React, { useState, useEffect, useRef } from 'react';
import './SymbolHotspots.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

const CATEGORY_ICON = {
  prop: '◆',
  color_code: '◉',
  omission: '◌',
  editing: '◈',
  micro_signal: '◎',
  lore: '✦',
  cta: '↗',
};

function compactText(text, max = 90) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max).replace(/[，。；、：,.!?;:]*$/, '')}…`;
}

function SymbolTooltip({ sym, deepReading, cx, cy, corner, onClose, onCta }) {
  const isRight = cx > 55;
  const isBottom = cy > 55;

  const style = corner
    ? {}
    : {
        left: isRight ? 'auto' : `${cx}%`,
        right: isRight ? `${100 - cx}%` : 'auto',
        top: isBottom ? 'auto' : `${cy + 4}%`,
        bottom: isBottom ? `${100 - cy + 4}%` : 'auto',
      };

  return (
    <div
      className={`sh-tooltip${corner ? ' sh-tooltip--corner' : ''}`}
      style={style}
      onClick={e => e.stopPropagation()}
    >
      <div className="sh-tooltip-header">
        <span className="sh-tooltip-id">
          {CATEGORY_ICON[sym.category] || '◈'}&nbsp;
          {sym.symbol_id.replace(/_/g, ' ')}
        </span>
        <button className="sh-tooltip-close" onClick={onClose}>✕</button>
      </div>
      {sym.evidence_in_frame && (
        <p className="sh-tooltip-evidence">{compactText(sym.evidence_in_frame, 70)}</p>
      )}
      {sym.meaning_zh && (
        <p className="sh-tooltip-meaning">{compactText(sym.meaning_zh, 90)}</p>
      )}
      {sym.viewer_takeaway && (
        <p className="sh-tooltip-takeaway">「{compactText(sym.viewer_takeaway, 70)}」</p>
      )}
      {sym.selection_basis && (
        <p className="sh-tooltip-basis"><strong>成立依据：</strong>{sym.selection_basis}</p>
      )}
      {sym.expressive_function && (
        <p className="sh-tooltip-function"><strong>表现作用：</strong>{sym.expressive_function}</p>
      )}
      {sym.cta && onCta && (
        <button
          className="sh-tooltip-cta"
          onClick={() => onCta(sym.cta)}
        >{sym.cta.label || '查看 →'}</button>
      )}
    </div>
  );
}

// 角标跟随场景切片展示，但同一场景最长只展示 10 个视频秒。
const BADGE_DURATION_S = 10;

export default function SymbolHotspots({ videoId, videoRef, onCta }) {
  const [symbolData, setSymbolData] = useState(null);
  // activeSymbol: { sym, mode: 'dot' | 'badge' }
  const [active, setActive] = useState(null);
  const lastSceneIdRef = useRef(null);
  // 当前 symbolData 第一次显示时的 video.currentTime —— 用来限制最长展示时长
  const symbolShownAtRef = useRef(null);
  // 请求序号：seek 时常常多个 fetch 同时在飞，必须只信"最后一发"的回执，
  // 否则旧请求晚到会把 otto_dismissal 这种 8 分钟的 badge 钉到 50 分钟去。
  const reqSeqRef = useRef(0);

  useEffect(() => {
    if (!videoId) return;

    const tick = () => {
      const v = videoRef.current;
      if (!v) return;
      const t = Math.floor(v.currentTime);
      const mySeq = ++reqSeqRef.current;

      fetch(`${API}/api/agent/scene/symbols?videoId=${encodeURIComponent(videoId)}&t=${t}`)
        .then(r => r.json())
        .then(data => {
          // 新一轮 tick 已经发出，本次响应作废 —— 防止旧 scene 的结果盖掉新 scene
          if (mySeq !== reqSeqRef.current) return;
          if (!data.has_kb) {
            setSymbolData(null);
            setActive(null);
            symbolShownAtRef.current = null;
            return;
          }
          const now = v.currentTime;
          const shownAt = symbolShownAtRef.current;

          if (data.scene_id === lastSceneIdRef.current) {
            if (symbolData && shownAt != null && (now - shownAt) >= BADGE_DURATION_S) {
              setSymbolData(null);
              setActive(null);
              symbolShownAtRef.current = null;
            }
            return;
          }

          const hasSymbols = data.symbols && data.symbols.length > 0;

          // 新场景"有符号" → 立刻切换，并重新计算 10 秒展示窗口
          if (hasSymbols) {
            lastSceneIdRef.current = data.scene_id;
            setSymbolData(data);
            setActive(null);
            symbolShownAtRef.current = now;
            return;
          }

          // 场景切片结束且新场景无符号时，立即清除上一场景的热点
          lastSceneIdRef.current = data.scene_id;
          setSymbolData(null);
          setActive(null);
          symbolShownAtRef.current = null;
        })
        .catch(() => {});
    };

    // seek 时立即作废所有在飞请求 + 立刻补一发
    const v = videoRef.current;
    const onSeeked = () => {
      reqSeqRef.current++; // 把所有在飞请求踢成 stale
      tick();
    };
    if (v) v.addEventListener('seeked', onSeeked);

    const id = setInterval(tick, 600);
    tick();
    return () => {
      clearInterval(id);
      if (v) v.removeEventListener('seeked', onSeeked);
    };
  }, [videoId, videoRef, symbolData]);

  if (!symbolData) return null;

  const allSymbols = symbolData.symbols;
  const locatable = allSymbols.filter(s =>
    Array.isArray(s.bbox) && s.bbox.length === 4 && !(s.bbox[2] > 0.9 && s.bbox[3] > 0.9)
  );

  const toggleDot = (e, sym) => {
    e.stopPropagation();
    setActive(prev =>
      prev?.sym.symbol_id === sym.symbol_id && prev.mode === 'dot'
        ? null
        : { sym, mode: 'dot' }
    );
  };

  const toggleBadge = (e, sym) => {
    e.stopPropagation();
    setActive(prev =>
      prev?.sym.symbol_id === sym.symbol_id
        ? null
        : { sym, mode: 'badge' }
    );
  };

  const isActiveSym = (sym) => active?.sym.symbol_id === sym.symbol_id;

  return (
    <>
      {active && (
        <div className="sh-backdrop" onClick={() => setActive(null)} />
      )}

      {/* Pulsing dots for locatable symbols */}
      {locatable.map(sym => {
        const [bx, by, bw, bh] = sym.bbox;
        const cx = (bx + bw / 2) * 100;
        const cy = (by + bh / 2) * 100;
        const isAct = isActiveSym(sym);

        return (
          <React.Fragment key={`dot-${sym.symbol_id}`}>
            <div
              className={`sh-dot${isAct ? ' is-active' : ''}`}
              style={{ left: `${cx}%`, top: `${cy}%` }}
              onClick={e => toggleDot(e, sym)}
              title={sym.symbol_id.replace(/_/g, ' ')}
            />
            {isAct && active.mode === 'dot' && (
              <SymbolTooltip
                sym={sym}
                deepReading={symbolData.deep_reading}
                cx={cx}
                cy={cy}
                onClose={() => setActive(null)}
                onCta={onCta}
              />
            )}
          </React.Fragment>
        );
      })}

      {/* Corner badges for ALL symbols */}
      {allSymbols.map((sym, i) => {
        const isAct = isActiveSym(sym);
        return (
          <React.Fragment key={`badge-${sym.symbol_id}`}>
            <div
              className={`sh-badge${isAct ? ' is-active' : ''}`}
              style={{ bottom: `${52 + i * 34}px` }}
              onClick={e => toggleBadge(e, sym)}
              title={sym.symbol_id.replace(/_/g, ' ')}
            >
              {CATEGORY_ICON[sym.category] || '◈'}
              <span>{sym.symbol_id.replace(/_/g, ' ')}</span>
            </div>
            {isAct && active.mode === 'badge' && (
              <SymbolTooltip
                sym={sym}
                deepReading={symbolData.deep_reading}
                corner
                onClose={() => setActive(null)}
                onCta={onCta}
              />
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}
