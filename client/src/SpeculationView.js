import React, { useEffect, useRef, useState } from 'react';
import './SpeculationView.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// "如果走这条路"立场推演 —— 全屏模态。
// 拿到 trigger + 用户的 choice，向后端流式拉一段 3-5 段的叙事推演。
// 最后一段会以 ⚠️ 推演终止 收束，告诉用户为什么原剧没走这条路。
//
// 这不是同人小说 —— 推演的目的是反向加深用户对原剧选择的理解。

export default function SpeculationView({ open, videoId, trigger, choice, onClose }) {
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!open || !trigger || !choice) return;
    setText('');
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      try {
        const resp = await fetch(`${API}/api/agent/stance/speculate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoId,
            triggerId: trigger.trigger_id,
            optionId: choice.option_id,
          }),
          signal: controller.signal,
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
            if (evtType === 'text') setText(prev => prev + (data.delta || ''));
            // 'done' event 仅 metadata，不影响 UI
          }
        }
        setStreaming(false);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err.message || String(err));
        setStreaming(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [open, videoId, trigger?.trigger_id, choice?.option_id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !trigger || !choice) return null;

  return (
    <div className="spv-root" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="spv-card" onClick={e => e.stopPropagation()}>

        <button className="spv-close" onClick={onClose} title="关闭 (Esc)" aria-label="关闭">×</button>

        <div className="spv-header">
          <div className="spv-eyebrow">🔀 立场推演</div>
          <h2 className="spv-title">如果走这条路</h2>
          <div className="spv-meta">
            <span className="spv-meta-scene">{trigger.scene_label}</span>
            <span className="spv-meta-sep">·</span>
            <span className="spv-meta-choice">你选了：{choice.option_label}</span>
          </div>
        </div>

        <div className="spv-body">
          {streaming && !text && (
            <div className="spv-loading">
              <span className="spv-loading-dots">推演中</span>
            </div>
          )}
          {text && (
            <div className="spv-text">
              {text.split(/\n\s*\n/).filter(p => p.trim()).map((para, i) => (
                <p
                  key={i}
                  className={`spv-para ${para.startsWith('⚠️') ? 'is-convergence' : ''}`}
                >{para}</p>
              ))}
              {streaming && <span className="spv-cursor" aria-hidden="true">▍</span>}
            </div>
          )}
          {error && (
            <div className="spv-error">推演失败：{error}</div>
          )}
        </div>

        <div className="spv-footer">
          <span className="spv-disclaimer">
            推演基于角色性格与世界观规则，不是原剧后续。
          </span>
          <button className="spv-btn-close" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
