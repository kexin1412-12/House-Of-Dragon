// Renders the human-annotation tool as one self-contained HTML file.
// Data is embedded as JSON; the page builds the DOM with textContent (no injection),
// autosaves each label to localStorage, and exports all labels as a JSON download.
// Three axes: retrieval relevance (graded 核心/相关/无关), answer factuality, answer helpfulness.

function render(data) {
  // Embed as a JS string literal (outer stringify escapes quotes/backslashes/newlines),
  // then neutralize any literal </script> so it can't close the tag early.
  const jsLiteral = JSON.stringify(JSON.stringify(data)).replace(/<\/(script)/gi, '<\\/$1');
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>评测标注 · House of the Dragon</title>
<style>
  :root{
    --bg:#f7f5f2; --surface:#fff; --ink:#26221d; --muted:#8a8177; --line:#e7e2da;
    --ret:#5b7a99; --ret-soft:#eef2f6; --ans:#7c6aa8; --ans-soft:#f1eef7;
    --ok:#3f9142; --warn:#c9962f; --bad:#c0503f; --amber:#c08a3e;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:0 20px 100px}
  header{position:sticky;top:0;z-index:20;background:rgba(247,245,242,.94);backdrop-filter:blur(6px);border-bottom:1px solid var(--line);margin:0 -20px 22px;padding:14px 20px}
  .hrow{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  h1{font-size:18px;margin:0;font-weight:600}
  .prog{flex:1;min-width:160px}
  .pbar{height:8px;background:#ece7df;border-radius:6px;overflow:hidden}
  .pfill{height:100%;background:var(--ok);width:0;transition:width .2s}
  .pnum{font-size:12px;color:var(--muted);margin-top:3px}
  button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:7px 13px;color:var(--ink)}
  button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
  button:hover{border-color:var(--muted)}
  .tabs{display:flex;gap:8px;margin-bottom:16px}
  .tab{font-size:13px;padding:6px 12px;border-radius:20px}
  .tab.on{background:var(--ink);color:#fff;border-color:var(--ink)}
  h2{font-size:16px;margin:26px 0 12px;display:flex;align-items:center;gap:8px}
  h2 .dot{width:10px;height:10px;border-radius:50%}
  .zone-ret h2 .dot{background:var(--ret)} .zone-ans h2 .dot{background:var(--ans)}
  .lead{color:#5c554c;font-size:13px;margin:0 0 14px}
  .item{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px;border-left:3px solid var(--line)}
  .item.done{border-left-color:var(--ok)}
  .zone-ret .item{border-top:1px solid var(--line)}
  .q{font-size:15px;font-weight:600;margin-bottom:3px}
  .meta{font-size:11.5px;color:var(--muted);margin-bottom:12px}
  .meta .tag{background:var(--ret-soft);color:#3d5061;border-radius:5px;padding:1px 7px;margin-right:6px}
  .zone-ans .meta .tag{background:var(--ans-soft);color:#4a4166}
  .chunk{display:flex;gap:12px;align-items:flex-start;padding:9px 0;border-top:1px dashed var(--line)}
  .chunk .body{flex:1;font-size:13px;color:#33302b}
  .ktype{font-size:10.5px;color:var(--muted);font-family:ui-monospace,Menlo,Consolas,monospace;display:block;margin-bottom:2px}
  .pills{display:flex;gap:6px;flex-shrink:0}
  .pill{font-size:12px;border:1px solid var(--line);border-radius:16px;padding:3px 11px;background:var(--surface);white-space:nowrap}
  .pill[data-on="1"]{color:#fff;font-weight:600}
  .pill.core[data-on="1"]{background:var(--ok);border-color:var(--ok)}
  .pill.rel[data-on="1"]{background:var(--amber);border-color:var(--amber)}
  .pill.irr[data-on="1"]{background:var(--muted);border-color:var(--muted)}
  .pill.f-ok[data-on="1"]{background:var(--ok);border-color:var(--ok)}
  .pill.f-minor[data-on="1"]{background:var(--warn);border-color:var(--warn)}
  .pill.f-bad[data-on="1"]{background:var(--bad);border-color:var(--bad)}
  .pill.f-na[data-on="1"]{background:var(--muted);border-color:var(--muted)}
  .pill.h-hi[data-on="1"]{background:var(--ok);border-color:var(--ok)}
  .pill.h-mid[data-on="1"]{background:var(--warn);border-color:var(--warn)}
  .pill.h-no[data-on="1"]{background:var(--bad);border-color:var(--bad)}
  .rowbtn{margin-top:10px;font-size:12px;padding:5px 11px}
  .answer{font-size:14px;background:#fbfaf8;border:1px solid var(--line);border-radius:9px;padding:11px 13px;white-space:pre-wrap;margin-bottom:12px}
  .axis{margin-bottom:10px}
  .axis-lab{font-size:12px;color:var(--muted);margin-bottom:5px}
  details{margin:6px 0 12px} summary{cursor:pointer;font-size:12.5px;color:#4a443c}
  .ref{font-size:12px;color:#6b6459;background:#fbfaf8;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-top:6px}
  .ref b{color:#4a443c} .ref .rk{display:block;margin-top:6px;padding-top:6px;border-top:1px dashed var(--line)}
  .note{width:100%;font:inherit;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:7px 10px;margin-top:6px;resize:vertical;min-height:34px}
  .hide{display:none}
  .toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--ink);color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none}
  .toast.show{opacity:1}
</style></head>
<body><div class="wrap">
  <header>
    <div class="hrow">
      <h1>评测标注</h1>
      <div class="prog"><div class="pbar"><div class="pfill" id="pfill"></div></div><div class="pnum" id="pnum">0 / 0</div></div>
      <button class="primary" id="export">导出标注 JSON</button>
      <button id="reset" title="清空本机所有标注">清空</button>
    </div>
    <div class="tabs" style="margin-top:10px">
      <button class="tab on" data-tab="ret">检索相关性</button>
      <button class="tab" data-tab="ans">回答质量</button>
    </div>
  </header>

  <section class="zone-ret" id="sec-ret">
    <h2><span class="dot"></span>检索相关性 <span id="ret-count" style="font-size:12px;color:var(--muted);font-weight:400"></span></h2>
    <p class="lead">每题下面是系统召回的知识块。给<b>真正回答了这个问题</b>的标「核心」，沾边的标「相关」，其余点「其余无关」一键补齐。核心/相关会用来算召回和 nDCG。</p>
    <div id="ret-list"></div>
  </section>

  <section class="zone-ans hide" id="sec-ans">
    <h2><span class="dot"></span>回答质量 <span id="ans-count" style="font-size:12px;color:var(--muted);font-weight:400"></span></h2>
    <p class="lead">读这条回答，凭你对剧情的了解判两个轴：<b>事实性</b>（有没有编造/说错）和<b>有用性</b>（对理解这一幕有没有帮助）。展开「参考」可看当前场景资料辅助判断。</p>
    <div id="ans-list"></div>
  </section>

  <div class="toast" id="toast"></div>
</div>
<script>
window.__DATA__ = JSON.parse(${jsLiteral});
</script>
<script>
(function(){
  const DATA = window.__DATA__;
  const KEY = 'hotd_annot_v1';
  const state = load();
  function load(){
    let s; try{ s = JSON.parse(localStorage.getItem(KEY))||{ret:{},ans:{}}; }catch{ s = {ret:{},ans:{}}; }
    s.ret = s.ret||{}; s.ans = s.ans||{};
    // If the answers were rebuilt (new prompt/model), the old answer labels judged different
    // text — clear only those, keep retrieval labels, and tell the user.
    if (s.builtAt && s.builtAt !== DATA.generatedAt) {
      s.ans = {};
      setTimeout(()=>toast('答案已用改进后的 prompt 重新生成，请重标「回答质量」；检索标注已保留'), 400);
    }
    s.builtAt = DATA.generatedAt;
    return s;
  }
  function save(){ localStorage.setItem(KEY, JSON.stringify(state)); updateProgress(); }
  function el(tag, cls, txt){ const e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }

  // ---- retrieval ----
  const retList = document.getElementById('ret-list');
  DATA.retrieval.forEach(item=>{
    state.ret[item.id] = state.ret[item.id] || { labels:{}, done:false };
    const st = state.ret[item.id];
    const box = el('div','item'); box.dataset.id=item.id;
    const q = el('div','q', item.query); box.appendChild(q);
    const meta = el('div','meta');
    meta.appendChild(el('span','tag', item.knowledge_type));
    meta.appendChild(document.createTextNode(item.videoId+' · t='+item.cursorTime+'s · 召回 '+item.chunks.length+' 块'));
    box.appendChild(meta);
    if(!item.chunks.length){ box.appendChild(el('div','lead','（没有召回任何块）')); }
    item.chunks.forEach(ch=>{
      const row = el('div','chunk');
      const body = el('div','body');
      body.appendChild(el('span','ktype', ch.knowledge_type+'  ·  '+ch.id));
      body.appendChild(document.createTextNode(ch.content));
      row.appendChild(body);
      const pills = el('div','pills');
      [['core','核心',2],['rel','相关',1],['irr','无关',0]].forEach(([c,label,val])=>{
        const p = el('button','pill '+c, label);
        p.dataset.on = (st.labels[ch.id]===val)?'1':'0';
        p.onclick=()=>{ st.labels[ch.id]=val; refreshRow(pills, ch.id, st); markMaybeDone(item, st, box); save(); };
        pills.appendChild(p);
      });
      row.appendChild(pills);
      box.appendChild(row);
    });
    const rest = el('button','rowbtn','其余全部无关，标记完成');
    rest.onclick=()=>{ item.chunks.forEach(ch=>{ if(st.labels[ch.id]==null) st.labels[ch.id]=0; }); st.done=true; renderRetItem(box,item,st); save(); toast('已完成本题'); };
    box.appendChild(rest);
    if(st.done) box.classList.add('done');
    retList.appendChild(box);
  });
  function refreshRow(pills, chId, st){ [...pills.children].forEach((p,i)=>{ const v=[2,1,0][i]; p.dataset.on=(st.labels[chId]===v)?'1':'0'; }); }
  function markMaybeDone(item, st, box){ const all=item.chunks.every(ch=>st.labels[ch.id]!=null); if(all){ st.done=true; box.classList.add('done'); } }
  function renderRetItem(box,item,st){ const pillsList=box.querySelectorAll('.pills'); item.chunks.forEach((ch,i)=>refreshRow(pillsList[i],ch.id,st)); box.classList.toggle('done',!!st.done); }

  // ---- answers ----
  const ansList = document.getElementById('ans-list');
  DATA.answers.forEach(item=>{
    state.ans[item.id] = state.ans[item.id] || { factuality:null, helpfulness:null, note:'' };
    const st = state.ans[item.id];
    const box = el('div','item'); box.dataset.id=item.id;
    box.appendChild(el('div','q', item.question));
    const meta = el('div','meta');
    meta.appendChild(el('span','tag', item.prompt_kind));
    meta.appendChild(document.createTextNode(item.videoId+' · t='+item.t+'s · scene '+(item.reference.scene_id||'—')));
    box.appendChild(meta);
    box.appendChild(el('div','answer', item.answer||'（空回答）'));

    // reference
    const det = el('details'); det.appendChild(el('summary','','参考资料（当前场景 + 检索到的知识，辅助判断）'));
    const ref = el('div','ref');
    if(item.reference.plot_fact){ const b=el('div'); b.appendChild(el('b',null,'画面事实：')); b.appendChild(document.createTextNode(item.reference.plot_fact)); ref.appendChild(b); }
    if(item.reference.plot_reading){ const b=el('div','rk'); b.appendChild(el('b',null,'解读：')); b.appendChild(document.createTextNode(item.reference.plot_reading)); ref.appendChild(b); }
    (item.reference.retrieved||[]).forEach(r=>{ const b=el('div','rk'); b.appendChild(el('b',null,r.knowledge_type+'：')); b.appendChild(document.createTextNode(r.content)); ref.appendChild(b); });
    det.appendChild(ref); box.appendChild(det);

    box.appendChild(axis('事实性', [['f-ok','完全正确','ok'],['f-minor','有小错','minor'],['f-bad','有编造/错误','bad'],['f-na','无法判断','na']], st, 'factuality', item, box));
    box.appendChild(axis('有用性', [['h-hi','很有用','hi'],['h-mid','一般','mid'],['h-no','没用','no']], st, 'helpfulness', item, box));

    const note = el('textarea','note'); note.placeholder='备注（可选）：错在哪 / 漏了什么'; note.value=st.note||'';
    note.oninput=()=>{ st.note=note.value; save(); };
    box.appendChild(note);
    if(st.factuality) box.classList.add('done');
    ansList.appendChild(box);
  });
  function axis(label, opts, st, field, item, box){
    const wrap = el('div','axis'); wrap.appendChild(el('div','axis-lab', label));
    const pills = el('div','pills');
    opts.forEach(([cls,text,val])=>{
      const p = el('button','pill '+cls, text);
      p.dataset.on=(st[field]===val)?'1':'0';
      p.onclick=()=>{ st[field]=val; [...pills.children].forEach((x,i)=>x.dataset.on=(st[field]===opts[i][2])?'1':'0'); box.classList.toggle('done',!!st.factuality); save(); };
      pills.appendChild(p);
    });
    wrap.appendChild(pills); return wrap;
  }

  // ---- progress / tabs / export ----
  function updateProgress(){
    const rTot=DATA.retrieval.length, aTot=DATA.answers.length;
    const rDone=DATA.retrieval.filter(i=>state.ret[i.id]&&state.ret[i.id].done).length;
    const aDone=DATA.answers.filter(i=>state.ans[i.id]&&state.ans[i.id].factuality).length;
    const done=rDone+aDone, tot=rTot+aTot;
    document.getElementById('pfill').style.width=(tot?done/tot*100:0)+'%';
    document.getElementById('pnum').textContent=done+' / '+tot+' 已标';
    document.getElementById('ret-count').textContent='('+rDone+'/'+rTot+')';
    document.getElementById('ans-count').textContent='('+aDone+'/'+aTot+')';
  }
  document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on')); t.classList.add('on');
    document.getElementById('sec-ret').classList.toggle('hide', t.dataset.tab!=='ret');
    document.getElementById('sec-ans').classList.toggle('hide', t.dataset.tab!=='ans');
    window.scrollTo(0,0);
  });
  document.getElementById('export').onclick=()=>{
    const out={ tool:'hotd-eval-annotation', version:1, exportedAt:new Date().toISOString(), builtAt:DATA.generatedAt,
      retrieval:DATA.retrieval.map(i=>({id:i.id, videoId:i.videoId, cursorTime:i.cursorTime, knowledge_type:i.knowledge_type, query:i.query,
        labels:(state.ret[i.id]||{}).labels||{}, done:!!(state.ret[i.id]||{}).done})),
      answers:DATA.answers.map(i=>({id:i.id, videoId:i.videoId, t:i.t, prompt_kind:i.prompt_kind, question:i.question,
        factuality:(state.ans[i.id]||{}).factuality||null, helpfulness:(state.ans[i.id]||{}).helpfulness||null, note:(state.ans[i.id]||{}).note||''})) };
    const blob=new Blob([JSON.stringify(out,null,1)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='eval-annotations.json'; a.click();
    toast('已导出 eval-annotations.json —— 发给我或放进仓库');
  };
  document.getElementById('reset').onclick=()=>{ if(confirm('清空本机所有标注？不可撤销。')){ localStorage.removeItem(KEY); location.reload(); } };
  let tt; function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(tt); tt=setTimeout(()=>t.classList.remove('show'),2200); }
  updateProgress();
})();
</script>
</body></html>`;
}

module.exports = { render };
