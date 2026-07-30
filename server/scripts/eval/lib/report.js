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

  const ff = r.faceFrames;
  if (ff && !ff.skipped) {
    cards.push(`
      <div class="card zone-face">
        <div class="card-tag">③ 人脸识别（真实截图）</div>
        <div class="card-metric" style="color:${rateColor(ff.identified_rate, 0.6, 0.35)}">${pct(ff.identified_rate)}</div>
        <div class="card-sub">真实剧集帧识别率 · ${ff.identified}/${ff.total_frames} 张</div>
        <div class="card-note">候选坍缩到 ${ff.distinct_top1_identities} 个身份 · 库内 LOO Top-1 ${pct(face.top1_accuracy)}</div>
      </div>`);
  } else {
    cards.push(`
      <div class="card zone-face">
        <div class="card-tag">③ 人脸识别</div>
        <div class="card-metric" style="color:${rateColor(face.top1_accuracy, 0.6, 0.35)}">${pct(face.top1_accuracy)}</div>
        <div class="card-sub">库内闭集 Top-1 · ${face.total_embeddings} 样本 / ${face.characters} 人</div>
        <div class="card-note">误识 ${pct(face.false_accept_rate)} · 拒识 ${pct(face.reject_rate)}</div>
      </div>`);
  }

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
      <h2><span class="dot"></span>③b 人脸识别 · 角色库闭集分离度（离线 LOO）</h2>
      <p class="lead">对角色库中每条 ArcFace 特征做留一验证，完全复刻线上匹配决策（阈值 ${face.threshold} + Top1−Top2 间隔 ${face.margin}）。衡量的是<b>角色库本身的可分性</b>与阈值松紧，而非终端使用准确率。<b>误识率</b>（认成别人）比拒识更危险，是重点看的指标。</p>
      <div class="panel note" style="border-left:3px solid var(--face)">
        这是离线代理指标（衡量库本身可不可分）；"用剧里清晰截图直接识别"的真实测试见上面 <b>③a</b>——已用真正的 ArcFace 服务跑过，结论是真实画面上基本失效。另外本集 KB 的 <code>characters_on_screen</code> 自动标注不可靠（同一张脸标成两个人、片头帧标成角色），不能当逐帧 ground truth，所以③a 用"识别率 + 候选坍缩"这类无需逐帧标注的指标来量化。
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

function faceFramesSection(ff) {
  if (!ff || ff.skipped) {
    return `
      <section class="zone-face">
        <h2><span class="dot"></span>③a 人脸识别 · 真实剧集截图</h2>
        <p class="lead">把剧里检测到的人脸截图送进真正的 ArcFace 服务识别。本次未运行：${esc(ff && ff.reason || '人脸服务未启动')}。启动 <code>scripts/face_service.py</code> 后重跑即可。</p>
      </section>`;
  }
  const hero = ff.hero;
  const heroBlock = hero && !hero.error ? `
    <div class="hero">
      <img class="hero-img" src="${hero.thumb}" alt="verified frame"/>
      <div class="hero-body">
        <div class="hero-title">人工核实：这是一张清晰正脸的<b>韦赛里斯</b>特写</div>
        <div class="hero-verdict">服务判定：<span class="bad-text">${esc(hero.status === 'matched' ? ('认成 ' + hero.matched) : '拒识（ambiguous）')}</span></div>
        <div class="hero-cands">Top 候选：${hero.candidates.map(c => `<span class="mono">${esc(c.id)}@${c.sim}</span>`).join('　')}</div>
        <div class="hero-note">真人（韦赛里斯）${hero.truth_in_top3 ? '在' : '<b class="bad-text">根本不在</b>'} Top-3 候选里——而韦赛里斯的官方肖像送进去能 0.998 命中自己。说明库里的特征向量不可分。</div>
      </div>
    </div>` : '';

  const collapseTop = ff.collapse.slice(0, 4).map(c =>
    `<span class="mono">${esc(c.id)}</span> <span class="dim">×${c.count}</span>`).join('　');

  const sampleThumbs = ff.samples.map(s => `
    <div class="fsample">
      <img src="${s.thumb}" alt="crop"/>
      <div class="fsample-cap">
        <span class="${s.status === 'matched' ? 'ok-text' : 'dim'}">${esc(s.status)}</span>
        ${s.top1 ? `<br><span class="mono">${esc(s.top1.id)}@${s.top1.sim}</span>` : ''}
      </div>
    </div>`).join('');

  return `
    <section class="zone-face">
      <h2><span class="dot"></span>③a 人脸识别 · 真实剧集截图（走 ArcFace 服务）</h2>
      <p class="lead">这才是"用剧里清晰截图识别"的直接测试：把本集检测到的 ${ff.total_frames} 张人脸截图送进真正的 ArcFace 服务。<b>结论：现网人脸库在真实画面上基本失效</b>——只认出 ${ff.identified}/${ff.total_frames} 张（${pct(ff.identified_rate)}），其余因候选过于接近被判"模糊"拒识。</p>
      <div class="facegrid">
        <div class="fstat"><div class="fnum" style="color:${rateColor(ff.identified_rate, 0.6, 0.35)}">${pct(ff.identified_rate)}</div><div class="flab">真实帧识别率 (${ff.identified}/${ff.total_frames})</div></div>
        <div class="fstat"><div class="fnum">${pct(ff.reject_rate)}</div><div class="flab">拒识率（不敢下判断）</div></div>
        <div class="fstat"><div class="fnum">${f2(ff.avg_top1_sim)}</div><div class="flab">平均 Top1 相似度</div></div>
        <div class="fstat"><div class="fnum" style="color:var(--bad)">${ff.distinct_top1_identities}</div><div class="flab">${ff.total_frames} 张脸只坍缩到几个身份</div></div>
      </div>
      <div class="panel note" style="border-left:3px solid var(--bad)">
        <b>特征向量坍缩</b>：${ff.total_frames} 张明明是不同人的脸，Top-1 候选却几乎都落在 ${collapseTop} 上（相似度都 ~0.8）。健康的人脸库里，不同人之间余弦相似度应该在 0.2–0.35，这里却普遍 ~0.8——库里的向量几乎没有区分度。唯一挡住"全体误认"的是 Top1−Top2 间隔阈值，它把绝大多数都判成"模糊"拒掉了。这与库里每人参考帧过少、以及 embedding_count 与实际存量不符是同一个根因。
      </div>
      ${heroBlock}
      <details open><summary>抽样截图 + 服务判定</summary><div class="fsamples">${sampleThumbs}</div></details>
      <p class="lead" style="margin-top:14px">修复方向：重建人脸库——每个角色补足更多、更清晰、正脸的参考特征，并复核 build_face_gallery 的对齐与归一化。重建后本评测可一键复跑验证。</p>
    </section>`;
}

function render(results) {
  const { retrieval, answer, face, faceFrames, meta } = results;
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
  .hero{display:flex;gap:16px;align-items:center;background:#fbf3f1;border:1px solid #eccfc9;border-radius:12px;padding:14px;margin:14px 0}
  .hero-img{width:130px;height:auto;border-radius:8px;flex-shrink:0}
  .hero-title{font-size:14px;margin-bottom:5px}
  .hero-verdict{font-size:13px;margin-bottom:4px}
  .hero-cands{font-size:11.5px;color:#5c554c;margin-bottom:6px}
  .hero-note{font-size:12px;color:#6b6459}
  .fsamples{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
  .fsample{width:110px;text-align:center}
  .fsample img{width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
  .fsample-cap{font-size:10.5px;margin-top:4px;line-height:1.35}
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
  ${faceFramesSection(faceFrames)}
  ${faceSection(face)}
  <footer style="color:var(--muted);font-size:11.5px;text-align:center;margin-top:10px">
    评测集与脚本位于 scripts/eval · 重跑：<span class="mono">node scripts/eval/run_eval.js</span>
  </footer>
</div></body></html>`;
}

module.exports = { render };
