// Renders the three eval dimensions into one self-contained HTML report.
// No external assets — inline CSS only, opens straight in a browser.
// Semantic color zones (not all one accent): retrieval = slate-blue, answer = violet,
// face = amber, neutral surfaces = warm gray.

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const f2 = (x) => (typeof x === 'number' ? x.toFixed(2) : '—');

// score → color (green good, amber mid, red low), threshold-aware
function rateColor(x, good = 0.7, mid = 0.45) {
  if (x >= good) return 'var(--ok)';
  if (x >= mid) return 'var(--warn)';
  return 'var(--bad)';
}
function scoreColor(x) { // 1-5 scale
  if (x >= 4) return 'var(--ok)';
  if (x >= 3) return 'var(--warn)';
  return 'var(--bad)';
}
function bar(value, color) {
  return `<div class="bar"><div class="bar-fill" style="width:${Math.max(0, Math.min(1, value)) * 100}%;background:${color}"></div></div>`;
}

function summaryCards(r) {
  const ret = r.retrieval, ans = r.answer, face = r.face;
  const cards = [];

  cards.push(`
    <div class="card zone-ret">
      <div class="card-tag">① 检索召回</div>
      <div class="card-metric" style="color:${rateColor(ret.recall_at_k)}">${pct(ret.recall_at_k)}</div>
      <div class="card-sub">recall@${ret.k} · ${ret.n} 题 · MRR ${f2(ret.mrr)}</div>
      <div class="card-note">${ret.leaks === 0 ? '✓ 无越界泄漏' : `⚠ ${ret.leaks} 处越界泄漏`}</div>
    </div>`);

  if (ans.skipped) {
    cards.push(`
      <div class="card zone-ans">
        <div class="card-tag">② 回答质量</div>
        <div class="card-metric muted">—</div>
        <div class="card-sub">已跳过</div>
        <div class="card-note">${esc(ans.reason || '未配置模型')}</div>
      </div>`);
  } else {
    cards.push(`
      <div class="card zone-ans">
        <div class="card-tag">② 回答质量</div>
        <div class="card-metric" style="color:${scoreColor(ans.avg_overall)}">${f2(ans.avg_overall)}<span class="of5">/5</span></div>
        <div class="card-sub">${ans.judged}/${ans.n} 题 · 忠实 ${f2(ans.avg_faithfulness)} · 有用 ${f2(ans.avg_helpfulness)} · 无剧透 ${f2(ans.avg_no_spoiler)}</div>
        <div class="card-note">LLM 生成 + LLM 裁判</div>
      </div>`);
  }

  cards.push(`
    <div class="card zone-face">
      <div class="card-tag">③ 人脸识别</div>
      <div class="card-metric" style="color:${rateColor(face.top1_accuracy, 0.6, 0.35)}">${pct(face.top1_accuracy)}</div>
      <div class="card-sub">闭集 Top-1 · ${face.total_embeddings} 样本 / ${face.characters} 人</div>
      <div class="card-note">误识 ${pct(face.false_accept_rate)} · 拒识 ${pct(face.reject_rate)}</div>
    </div>`);

  return `<div class="cards">${cards.join('')}</div>`;
}

function retrievalSection(ret) {
  const typeRows = Object.entries(ret.per_type_recall)
    .sort((a, b) => a[1].recall - b[1].recall)
    .map(([t, v]) => `
      <div class="trow">
        <div class="tname">${esc(t)} <span class="dim">×${v.n}</span></div>
        <div class="tbarwrap">${bar(v.recall, rateColor(v.recall))}</div>
        <div class="tval" style="color:${rateColor(v.recall)}">${pct(v.recall)}</div>
      </div>`).join('');

  const qRows = ret.per_question.map(q => `
    <tr>
      <td class="mono">${esc(q.id)}</td>
      <td>${esc(q.knowledge_type)}</td>
      <td class="q">${esc(q.query)}</td>
      <td class="num" style="color:${rateColor(q.recall)}">${pct(q.recall)}</td>
      <td class="num">${f2(q.reciprocal_rank)}</td>
      <td class="num">${q.leak === 0 ? '✓' : `<span class="bad-text">${q.leak}</span>`}</td>
      <td class="mono small">${q.miss_ids.length ? '<span class="dim">missed:</span> ' + q.miss_ids.map(esc).join('<br>') : '<span class="ok-text">all hit</span>'}</td>
    </tr>`).join('');

  return `
    <section class="zone-ret">
      <h2><span class="dot"></span>① 检索召回 recall@${ret.k}</h2>
      <p class="lead">在时序防剧透过滤 + 混合（向量 × 关键词）检索链路上，衡量应当被召回的知识块是否进入 Top-${ret.k}。<code>越界泄漏</code>指检索到了超出当前观看进度的未来知识块——硬约束，应始终为 0。</p>
      <div class="panel">
        <div class="panel-head">按知识类型分组的召回率</div>
        <div class="ttable">${typeRows}</div>
      </div>
      <details open>
        <summary>逐题明细（${ret.n} 题）</summary>
        <div class="tablewrap"><table>
          <thead><tr><th>题目</th><th>类型</th><th>问题</th><th>recall</th><th>RR</th><th>泄漏</th><th>未命中</th></tr></thead>
          <tbody>${qRows}</tbody>
        </table></div>
      </details>
    </section>`;
}

function answerSection(ans) {
  if (ans.skipped) {
    return `
      <section class="zone-ans">
        <h2><span class="dot"></span>② 回答质量</h2>
        <p class="lead">该维度需要调用生成模型与裁判模型，本次运行未启用（${esc(ans.reason || '未配置 API key')}）。配置模型后重跑即可填充。</p>
      </section>`;
  }
  const metricBar = (label, val) => `
    <div class="trow">
      <div class="tname">${label}</div>
      <div class="tbarwrap">${bar(val / 5, scoreColor(val))}</div>
      <div class="tval" style="color:${scoreColor(val)}">${f2(val)}<span class="of5">/5</span></div>
    </div>`;

  const cards = ans.per_question.map(q => {
    const j = q.judgment || {};
    const badge = (lab, v) => `<span class="jbadge" style="border-color:${scoreColor(v)};color:${scoreColor(v)}">${lab} ${v}</span>`;
    const scores = typeof j.faithfulness === 'number'
      ? `${badge('忠实', j.faithfulness)}${badge('有用', j.helpfulness)}${badge('无剧透', j.no_spoiler)}`
      : `<span class="jbadge bad-text">裁判失败</span>`;
    return `
      <div class="qa">
        <div class="qa-head">
          <div class="qa-q">${esc(q.question)}</div>
          <div class="qa-scores">${scores}</div>
        </div>
        <div class="qa-meta">${esc(q.episode || '')} · t=${q.t}s · scene ${esc(q.scene_id || '—')}</div>
        <div class="qa-answer">${esc(q.answer) || '<span class="dim">（空回答）</span>'}</div>
        ${j.rationale ? `<div class="qa-rationale">裁判：${esc(j.rationale)}</div>` : ''}
      </div>`;
  }).join('');

  return `
    <section class="zone-ans">
      <h2><span class="dot"></span>② 回答质量（最常用快捷提问「解释这个镜头」）</h2>
      <p class="lead">主打观众最常点的快捷提问，在全集多个场景点各问一次，测日常主路径。在真实主动问答链路上生成回答，再由裁判模型仅依据"生成时可见的、已按进度过滤的上下文"打分。忠实度=有无虚构具体剧情（通用背景不算），有用性=是否切题具体，无剧透=有无透露未来事件。</p>
      <div class="panel">
        <div class="panel-head">平均得分（${ans.judged}/${ans.n} 题成功评分）</div>
        <div class="ttable">
          ${metricBar('忠实度', ans.avg_faithfulness)}
          ${metricBar('有用性', ans.avg_helpfulness)}
          ${metricBar('无剧透', ans.avg_no_spoiler)}
        </div>
      </div>
      <details open><summary>逐题回答与评分</summary><div class="qalist">${cards}</div></details>
    </section>`;
}

function faceSection(face) {
  const charRows = face.per_character.map(c => `
    <tr>
      <td class="mono">${esc(c.character_id)}</td>
      <td>${esc(c.actor || '')}</td>
      <td class="num">${c.n}</td>
      <td class="num" style="color:${rateColor(c.accuracy, 0.6, 0.35)}">${pct(c.accuracy)}</td>
      <td class="num">${c.correct}</td>
      <td class="num">${c.wrong ? `<span class="bad-text">${c.wrong}</span>` : 0}</td>
      <td class="num">${c.rejected}</td>
    </tr>`).join('');

  const conf = face.confusion.length
    ? face.confusion.map(c => `<li><span class="mono">${esc(c.pair)}</span> <span class="dim">×${c.count}</span></li>`).join('')
    : '<li class="dim">无误识</li>';

  return `
    <section class="zone-face">
      <h2><span class="dot"></span>③ 人脸识别（角色库闭集分离度）</h2>
      <p class="lead">对角色库中每条 ArcFace 特征做留一验证，完全复刻线上匹配决策（阈值 ${face.threshold} + Top1−Top2 间隔 ${face.margin}）。衡量的是<b>角色库本身的可分性</b>与阈值松紧，而非终端使用准确率。<b>误识率</b>（认成别人）比拒识更危险，是重点看的指标。</p>
      <div class="panel note" style="border-left:3px solid var(--face)">
        关于"用剧里清晰截图直接识别"的评测：需要 ArcFace 模型在本机可跑（当前未装 deepface/未起人脸服务），且需要可靠的"这一帧是谁"标注。实测本集 KB 里 <code>characters_on_screen</code> 的自动标注不可靠——同一张脸会被同时标成两个人、片头字幕被标成角色、抽查的帧身份多处对不上，因此不能直接当作 ground truth。要跑真·截图识别，需先启动人脸服务并人工校准一小批清晰帧的身份标签。
      </div>
      <div class="facegrid">
        <div class="fstat"><div class="fnum" style="color:${rateColor(face.top1_accuracy, 0.6, 0.35)}">${pct(face.top1_accuracy)}</div><div class="flab">Top-1 准确率</div></div>
        <div class="fstat"><div class="fnum" style="color:${rateColor(1 - face.false_accept_rate, 0.85, 0.7)}">${pct(face.false_accept_rate)}</div><div class="flab">误识率（认错人）</div></div>
        <div class="fstat"><div class="fnum">${pct(face.reject_rate)}</div><div class="flab">拒识率（不下判断）</div></div>
        <div class="fstat"><div class="fnum" style="color:${rateColor(face.accuracy_when_matched, 0.85, 0.7)}">${pct(face.accuracy_when_matched)}</div><div class="flab">下判断时的准确率</div></div>
      </div>
      <div class="panel note">
        注：本库共 ${face.total_embeddings} 条特征 / ${face.characters} 人，部分角色仅 1-2 条参考。留一验证下，单条参考的角色在被留出时缺少同人对照，天然偏向拒识/误识——这本身也反映"参考太少时线上识别不稳"的真实风险。
      </div>
      <div class="twocol">
        <details open>
          <summary>按角色分解（准确率升序）</summary>
          <div class="tablewrap"><table>
            <thead><tr><th>角色</th><th>演员</th><th>样本</th><th>准确率</th><th>对</th><th>错</th><th>拒识</th></tr></thead>
            <tbody>${charRows}</tbody>
          </table></div>
        </details>
        <details open>
          <summary>混淆对（谁被认成谁）</summary>
          <ul class="conf">${conf}</ul>
        </details>
      </div>
    </section>`;
}

function render(results) {
  const { retrieval, answer, face, meta } = results;
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>项目评测报告 · ${esc(meta.show || '')}</title>
<style>
  :root{
    --bg:#f7f5f2; --surface:#ffffff; --ink:#26221d; --muted:#8a8177; --line:#e7e2da;
    --ret:#5b7a99; --ret-soft:#eef2f6;
    --ans:#7c6aa8; --ans-soft:#f1eef7;
    --face:#c08a3e; --face-soft:#f6efe3;
    --ok:#3f9142; --warn:#c9962f; --bad:#c0503f;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:1040px;margin:0 auto;padding:32px 22px 80px}
  header h1{font-size:24px;margin:0 0 4px}
  header .sub{color:var(--muted);font-size:13px;margin-bottom:24px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:34px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 18px 16px;border-top:3px solid var(--line)}
  .zone-ret .card, .card.zone-ret{border-top-color:var(--ret)}
  .zone-ans .card, .card.zone-ans{border-top-color:var(--ans)}
  .zone-face .card, .card.zone-face{border-top-color:var(--face)}
  .card-tag{font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.02em}
  .card-metric{font-size:34px;font-weight:700;margin:6px 0 2px;line-height:1}
  .card-metric .of5{font-size:16px;color:var(--muted);font-weight:600}
  .card-metric.muted{color:var(--muted)}
  .card-sub{font-size:12.5px;color:var(--muted)}
  .card-note{font-size:12px;margin-top:8px;color:var(--ink)}
  section{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:22px 24px;margin-bottom:22px}
  section h2{font-size:18px;margin:0 0 6px;display:flex;align-items:center;gap:9px}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
  .zone-ret h2 .dot{background:var(--ret)} .zone-ans h2 .dot{background:var(--ans)} .zone-face h2 .dot{background:var(--face)}
  .lead{color:#5c554c;font-size:13.5px;margin:0 0 16px}
  .lead code,.lead b{background:var(--ret-soft);padding:1px 6px;border-radius:5px;font-size:12.5px}
  .zone-ans .lead code,.zone-ans .lead b{background:var(--ans-soft)} .zone-face .lead code,.zone-face .lead b{background:var(--face-soft)}
  .panel{background:#fbfaf8;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:14px}
  .panel-head{font-size:12.5px;color:var(--muted);margin-bottom:10px;font-weight:600}
  .panel.note{font-size:12.5px;color:#6b6459;line-height:1.55}
  .ttable{display:flex;flex-direction:column;gap:9px}
  .trow{display:grid;grid-template-columns:180px 1fr 64px;align-items:center;gap:12px}
  .tname{font-size:13px} .tname .dim{color:var(--muted);font-size:11px}
  .tval{font-size:13px;font-weight:600;text-align:right}
  .tval .of5{font-size:10px;color:var(--muted)}
  .bar{height:8px;background:#ece7df;border-radius:6px;overflow:hidden}
  .bar-fill{height:100%;border-radius:6px}
  details{margin-top:8px} summary{cursor:pointer;font-size:13.5px;font-weight:600;color:#4a443c;padding:6px 0}
  .tablewrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
  th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600;font-size:11.5px;white-space:nowrap}
  td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
  td.q{max-width:280px} td.mono,.mono{font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:11px}
  .small{font-size:10.5px} .dim{color:var(--muted)}
  .ok-text{color:var(--ok)} .bad-text{color:var(--bad);font-weight:600}
  .qalist{display:flex;flex-direction:column;gap:12px;margin-top:10px}
  .qa{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:#fbfaf8}
  .qa-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap}
  .qa-q{font-weight:600;font-size:14px}
  .qa-scores{display:flex;gap:6px;flex-wrap:wrap}
  .jbadge{font-size:11px;border:1px solid var(--line);border-radius:20px;padding:2px 9px;white-space:nowrap}
  .qa-meta{color:var(--muted);font-size:11px;margin:4px 0 9px}
  .qa-answer{font-size:13.5px;color:#33302b;white-space:pre-wrap;background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:11px 13px}
  .qa-rationale{font-size:12px;color:#6b6459;margin-top:8px;padding-left:10px;border-left:3px solid var(--ans)}
  .facegrid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
  .fstat{background:#fbfaf8;border:1px solid var(--line);border-radius:12px;padding:14px;text-align:center}
  .fnum{font-size:24px;font-weight:700}
  .flab{font-size:11.5px;color:var(--muted);margin-top:3px}
  .twocol{display:grid;grid-template-columns:1.4fr 1fr;gap:18px}
  ul.conf{list-style:none;padding:0;margin:8px 0 0;font-size:12.5px;display:flex;flex-direction:column;gap:5px}
  @media(max-width:760px){.cards,.facegrid{grid-template-columns:1fr 1fr}.twocol{grid-template-columns:1fr}.trow{grid-template-columns:130px 1fr 56px}}
</style></head>
<body><div class="wrap">
  <header>
    <h1>项目评测报告</h1>
    <div class="sub">${esc(meta.show || '')} · 生成于 ${esc(meta.generatedAt)} · 检索链路 ${esc(meta.retrievalMode)}</div>
  </header>
  ${summaryCards(results)}
  ${retrievalSection(retrieval)}
  ${answerSection(answer)}
  ${faceSection(face)}
  <footer style="color:var(--muted);font-size:11.5px;text-align:center;margin-top:10px">
    评测集与脚本位于 scripts/eval · 重跑：<span class="mono">node scripts/eval/run_eval.js</span>
  </footer>
</div></body></html>`;
}

module.exports = { render };
