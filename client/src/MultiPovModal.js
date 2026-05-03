import React, { useEffect, useRef, useState } from 'react';
import './MultiPovModal.css';

// 同一场景，不同角色的第一人称视角内心散文流式重写。
//
// 后端 SSE：
//   event: meta  → { scene_label, time_label, povs:[{character_id,display_name,short_identity,portrait}] }
//   event: text  → { delta }   (按 [POV:character_id] 锚点切到对应栏)
//   event: done  → { ... }
//
// 前端在 delta 流里维护一个 currentPovId（命中锚点就切），把后续 delta 写到对应栏。
// 锚点出现前累计的 delta 丢到一个 "preamble" 缓冲（理论上不该有；LLM 可能写"以下是…"之类
// 前言时会落到这里，正常工作时这个区永远空）。
function streamMultiPov({ api, videoId, startTime, endTime, sceneLabel, onMeta, onPovDelta, onDone, onError, signal }) {
  const ANCHOR_RE = /\[POV:([a-z0-9_]+)\]/gi;

  let accumulatedTail = '';   // 跨 chunk 边界可能截断锚点 → 留个尾巴
  let currentPovId = null;

  const dispatch = (text) => {
    if (!text) return;
    // 把刚到的 text 拼到 tail，从 0 重扫一次
    accumulatedTail += text;
    let lastEnd = 0;
    let m;
    ANCHOR_RE.lastIndex = 0;
    while ((m = ANCHOR_RE.exec(accumulatedTail)) !== null) {
      // 锚点之前的内容属于上一段（或 preamble）
      const prevSegment = accumulatedTail.slice(lastEnd, m.index);
      if (prevSegment && currentPovId) onPovDelta(currentPovId, prevSegment);
      currentPovId = m[1];
      lastEnd = m.index + m[0].length;
    }
    // 留个保护尾巴：可能 [POV:xxx 还没收齐
    const remaining = accumulatedTail.slice(lastEnd);
    // 如果 remaining 含未闭合 [POV: 前缀，留到下一轮
    const partialIdx = remaining.lastIndexOf('[');
    if (partialIdx !== -1 && remaining.length - partialIdx < 32 && /^\[(P|PO|POV|POV:|POV:[a-z0-9_]*)$/i.test(remaining.slice(partialIdx))) {
      // 推进 lastEnd 到 partialIdx 之前的部分，留下未完成的尾巴
      const flushable = remaining.slice(0, partialIdx);
      if (flushable && currentPovId) onPovDelta(currentPovId, flushable);
      accumulatedTail = remaining.slice(partialIdx);
    } else {
      if (remaining && currentPovId) onPovDelta(currentPovId, remaining);
      accumulatedTail = '';
    }
  };

  fetch(`${api}/api/agent/scene/povs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId, startTime, endTime, sceneLabel }),
    signal,
  })
    .then(async (resp) => {
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
          let evtType = 'message';
          let dataStr = '';
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) evtType = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          let data;
          try { data = JSON.parse(dataStr); } catch { continue; }
          if (evtType === 'meta') onMeta(data);
          else if (evtType === 'text') dispatch(data.delta || '');
          else if (evtType === 'done') onDone(data);
        }
      }
    })
    .catch(err => {
      if (err.name === 'AbortError') return;
      onError(err);
    });
}

export default function MultiPovModal({ api, videoId, startTime, endTime, sceneLabel, onClose }) {
  const [meta, setMeta] = useState(null);
  const [texts, setTexts] = useState({}); // { character_id: string }
  const [phase, setPhase] = useState('loading');  // loading | streaming | done | error
  const [errMsg, setErrMsg] = useState('');
  const abortRef = useRef(null);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    streamMultiPov({
      api, videoId, startTime, endTime, sceneLabel,
      signal: ctrl.signal,
      onMeta: (m) => {
        setMeta(m);
        const init = {};
        (m.povs || []).forEach(p => { init[p.character_id] = ''; });
        setTexts(init);
        setPhase('streaming');
      },
      onPovDelta: (cid, delta) => {
        setTexts(prev => ({ ...prev, [cid]: (prev[cid] || '') + delta }));
      },
      onDone: () => setPhase('done'),
      onError: (err) => {
        setErrMsg(err?.message || '未知错误');
        setPhase('error');
      },
    });
    return () => ctrl.abort();
  }, [api, videoId, startTime, endTime, sceneLabel]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="mp-overlay" onClick={onClose}>
      <div className="mp-panel" onClick={e => e.stopPropagation()}>
        <button className="mp-close" onClick={onClose} title="关闭">×</button>

        <header className="mp-header">
          <div className="mp-eyebrow">同一场戏 · 三人视角</div>
          <div className="mp-title">{meta?.scene_label || sceneLabel || '场景重写'}</div>
          {meta?.time_label && <div className="mp-time">{meta.time_label}</div>}
        </header>

        {phase === 'loading' && (
          <div className="mp-status">召集场内角色…</div>
        )}
        {phase === 'error' && (
          <div className="mp-status mp-status-error">重写失败：{errMsg}</div>
        )}

        {meta && (
          <div className={`mp-cols mp-cols-${(meta.povs || []).length}`}>
            {(meta.povs || []).map(p => (
              <article key={p.character_id} className="mp-col">
                <div className="mp-col-head">
                  {p.portrait
                    ? <img className="mp-col-portrait" src={p.portrait} alt={p.display_name} />
                    : <div className="mp-col-portrait mp-col-portrait--empty" aria-hidden />
                  }
                  <div className="mp-col-meta">
                    <div className="mp-col-name">{p.display_name}</div>
                    {p.short_identity && (
                      <div className="mp-col-id">{p.short_identity}</div>
                    )}
                  </div>
                </div>
                <div className="mp-col-body">
                  {(texts[p.character_id] || '').trim() || (
                    phase === 'streaming'
                      ? <span className="mp-col-placeholder">等他/她开口…</span>
                      : null
                  )}
                  {phase === 'streaming' && (texts[p.character_id] || '').trim() && (
                    <span className="mp-cursor">▍</span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        <footer className="mp-footer">
          <span className="mp-footer-hint">
            {phase === 'streaming' ? '生成中…按 ESC 关闭' :
             phase === 'done'      ? '三段都到了。再点一次按钮可以重新生成（每次结果不一样）' :
                                      '按 ESC 关闭'}
          </span>
        </footer>
      </div>
    </div>
  );
}
