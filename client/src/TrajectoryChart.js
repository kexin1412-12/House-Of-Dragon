import React, { useRef, useState } from 'react';
import './TrajectoryChart.css';
import { getChoices, resetAll } from './stanceStore';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';
// 立场轨迹图 = 一份你做过的选择的清单 + AI 立场总结。
// 不打分、不归类、不画曲线 —— 选择本身就是产物。
//
// 现在以 inline 形态嵌在叙事 X 光面板的"我的立场"tab 里，不再是独立浮窗。
// 父组件每次切到该 tab 会重新挂载，从 stanceStore 拉取最新选择。
// 总结按钮点击后流式 LLM 输出"读你的立场轨迹"——
// 严格 issue-by-issue，禁止 persona 标签 / 党派 banner（红线写在 prompt 里）。

export default function TrajectoryChart({ videoId }) {
  const [choices, setChoices] = useState(() =>
    getChoices().filter(c =>
      (c.type === 'faction_choice' || c.type === 'recall')
      && (!videoId || c.video_id === videoId))
  );

  // AI 总结：按需触发，不自动跑（避免每次开 tab 都掉 token）
  const [summary, setSummary] = useState('');
  const [summaryPhase, setSummaryPhase] = useState('idle'); // idle | streaming | done | error
  const [summaryErr, setSummaryErr] = useState('');
  const abortRef = useRef(null);

  function handleReset() {
    if (!window.confirm('确定要清空你所有的立场选择？此操作不可撤销。')) return;
    resetAll();
    setChoices([]);
    setSummary('');
    setSummaryPhase('idle');
    setSummaryErr('');
    if (abortRef.current) abortRef.current.abort();
  }

  function handleStartSummary() {
    if (summaryPhase === 'streaming') return;
    if (choices.length === 0) return;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSummary('');
    setSummaryErr('');
    setSummaryPhase('streaming');

    fetch(`${API}/api/agent/stance/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, choices }),
      signal: ctrl.signal,
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
            if (evtType === 'text') setSummary(prev => prev + (data.delta || ''));
            else if (evtType === 'done') setSummaryPhase('done');
          }
        }
        setSummaryPhase(prev => prev === 'streaming' ? 'done' : prev);
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        setSummaryErr(err?.message || '未知错误');
        setSummaryPhase('error');
      });
  }

  return (
    <div className="trc-inline">
      <div className="trc-header">
        <div className="trc-eyebrow">你做过的选择</div>
        <h2 className="trc-title">第一季 · 你站过的立场</h2>
      </div>

      {choices.length === 0 ? (
        <div className="trc-empty">
          <p>还没有立场记录。</p>
          <p className="trc-empty-sub">在剧情的关键转折点做出第一次选择，就会出现在这里。</p>
        </div>
      ) : (
        <>
          <div className="trc-cols">
            <div className="trc-col-left">
              <ChoiceList choices={choices} />
            </div>
            <div className="trc-col-right">
              <SummarySection
                choiceCount={choices.length}
                summary={summary}
                phase={summaryPhase}
                errMsg={summaryErr}
                onStart={handleStartSummary}
              />
            </div>
          </div>

          <div className="trc-actions">
            <button className="trc-btn trc-btn-ghost" onClick={handleReset}>
              重置我的轨迹
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ChoiceList({ choices }) {
  return (
    <ul className="trc-list">
      {choices.map((c, i) => (
        <li key={i} className="trc-list-item">
          <div className="trc-list-marker">
            <span className="trc-list-dot" />
            {i < choices.length - 1 && <span className="trc-list-line" />}
          </div>
          <div className="trc-list-text">
            <div className="trc-list-scene">{c.scene_label}</div>
            {c.option_label && (
              <div className="trc-list-choice">你选了：{c.option_label}</div>
            )}
            {c.option_inner_voice && (
              <div className="trc-list-voice">"{c.option_inner_voice}"</div>
            )}
            {c.type === 'recall' && (
              <div className="trc-list-recall">回顾打脸 · 你重新做了选择</div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function SummarySection({ choiceCount, summary, phase, errMsg, onStart }) {
  const canStart = choiceCount >= 2; // 单条选择写不出 issue，没意义

  return (
    <section className="trc-summary">
      <div className="trc-summary-head">
        <div className="trc-summary-eyebrow">读一遍你的立场</div>
        <div className="trc-summary-title">AI 总结</div>
      </div>

      {phase === 'idle' && (
        <div className="trc-summary-cta">
          <p className="trc-summary-cta-desc">
            {canStart
              ? '让 AI 把你做过的所有选择读成你在这一集里表达过的几个位置 —— 不归类、不贴标签、不打分，只指你站到了哪里、为什么、有没有转身。'
              : '至少做过 2 次选择，才能读出立场。'}
          </p>
          {canStart && (
            <button className="trc-btn trc-btn-primary" onClick={onStart}>
              生成立场总结
            </button>
          )}
        </div>
      )}

      {phase === 'streaming' && (
        <div className="trc-summary-body trc-summary-body--streaming">
          {summary || <span className="trc-summary-placeholder">AI 在读你的轨迹…</span>}
          <span className="trc-summary-cursor">▍</span>
        </div>
      )}

      {phase === 'done' && (
        <>
          <div className="trc-summary-body">{summary}</div>
          <div className="trc-summary-foot">
            <button className="trc-btn trc-btn-ghost trc-btn-sm" onClick={onStart}>
              重新生成
            </button>
          </div>
        </>
      )}

      {phase === 'error' && (
        <div className="trc-summary-error">
          总结失败：{errMsg}
          <button className="trc-btn trc-btn-ghost trc-btn-sm" onClick={onStart}>
            重试
          </button>
        </div>
      )}
    </section>
  );
}
