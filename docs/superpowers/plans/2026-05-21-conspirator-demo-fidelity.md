# 共谋者功能演示页忠实复刻产品 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `conspirator-demo.html` 在保持单文件、离线可开的前提下，补齐关系图+故事线两个招牌交互、深化现有 4 个交互、把数据换成真实 KB 策展数据、并做视觉/动效抠细。

**Architecture:** 单 HTML 文件，页内每个交互是一个独立 IIFE 模块，自带 `const DATA = {...}`（从真实 KB 策展、冻结成 inline 快照），互不共享状态。新增模块追加 `<section>` + 配套 CSS + IIFE；现有模块原地替换数据与分支逻辑。头像用 Vercel URL，`onerror` 回落字母圈。

**Tech Stack:** 原生 HTML / CSS / vanilla JS（无构建、无框架、无 npm 依赖）。数据源 = `server/kb/**` 与 `client/public/relationship-graph/**` 的真实 JSON。

---

## 全局约定（每个 Task 都适用）

**单元边界**：每个交互模块 = 一个 `(function(){ ... })();` IIFE，顶部 `const DATA`，只操作自己 section 内的 DOM（用唯一 id 前缀，如 `rg-`/`tl-`/`st-`/`cv-`/`sym-`/`ap-`），不读写其它模块的全局变量。

**验证方法**（本项目无单测框架，强行加 jsdom/jest 违反单文件 + YAGNI）：
- **B-CHECK（浏览器走查）**：用默认浏览器打开 `conspirator-demo.html`，按 Task 列出的步骤点/拖/步进，肉眼确认反馈，并打开 DevTools Console 确认**无报错**。
- **S-CHECK（脚本语法）**：把 `<script>…</script>` 内容抽出存临时 `.js`，跑 `node --check` 确认无语法错误。
- **G-CHECK（禁词 grep）**：跑禁词扫描确认可见文案无内部标识泄漏（命令见 Task 7）。

**提交策略**：每个 Task 末尾 commit（信息见各 Task）。全部完成后按用户默认 push 到 `origin/main`（注意：本 demo 是仓库根的独立文件，不在 Vercel 构建产物里，push 只是入库，不会自动发布）。

**约束清单**（来自 spec §3，违反即返工）：
- 可见文案无文件名/路径/JSON 字段名/内部 ID/反引号代码/“本剧 KB”；英文模块名（StanceCard/CharacterPanel/SymbolHotspots/AgentPanel）与 `cursor_time` 一律换纯中文。
- 立场/选择类不打分、不归类、不聚合；“观望”可选；轨迹只列选择。
- 关系图 profile 开启后点 panel 外空白渐进关闭（profile→高亮）。
- 配色按语义分区（灰蓝/紫/红/琥珀/绿/绯红），不堆金。
- 时间戳取自真实 KB。

---

## Task 1: 数据策展工具与禁词基线

**Files:**
- Read: `server/kb/stance/house_of_dragon_05.json`, `server/kb/storyline/house_of_dragon_05.json`, `server/kb/symbols/house-of-the-dragon.json`, `server/kb/lore_cards/house-of-the-dragon.json`, `server/kb/dialogue_riffs/house-of-the-dragon.json`, `server/kb/characters/house-of-the-dragon.roleplay.json`, `client/public/relationship-graph/_family-tree.json`, `client/public/relationship-graph/_profiles-house_of_dragon_05.json`
- Modify: none yet（仅建立基线）

- [ ] **Step 1: 通读各数据源，记录字段映射表**

逐个用 Read 打开上列文件（注意 stance KB 是 UTF-8，用 Read 工具而非 PowerShell `Get-Content` 以免乱码）。产出一张「真实字段 → 中文 UI 标签」映射，至少覆盖：
`short_identity→身份`、`analysis→深度解读`、`arc_so_far→至今的剧情节点`、`book_note→血与火 · 背景`、`companion→龙伴`、`convergence_hint→剧情本就如此`、`speculation.by_option→反事实推演`、`is_canonical→剧情线（不显示该词，仅用于判定）`、`scene_label→场景名`、`cursor_time→观看进度`。

- [ ] **Step 2: 建立禁词基线（G-CHECK）**

记录禁词列表，作为 Task 7 验收脚本依据：`StanceCard`、`CharacterPanel`、`SymbolHotspots`、`AgentPanel`、`cursor_time`、`convergence_hint`、`by_option`、`is_canonical`、`short_identity`、`arc_so_far`、`book_note`、`.json`、`server/kb`、`本剧 KB`、`_family-tree`。

Run（建立当前基线，记录现存命中项，后续要清零）：
```
rg -n "StanceCard|CharacterPanel|SymbolHotspots|AgentPanel|cursor_time|本剧 KB" conspirator-demo.html
```
Expected: 现在会命中若干处（现有模块标题里的英文名 + cursor_time）。记下行号，Task 3–6 逐一清除。

- [ ] **Step 3: Commit（仅文档/无代码改动则跳过）**

本 Task 不改 `conspirator-demo.html`，无需 commit。

---

## Task 2: 新增「人物关系图 + 人物档案」模块（交互演示 ⑤）

**Files:**
- Modify: `conspirator-demo.html` — 在 `#symbol` section 后、`#meme` section 前插入新 `<section id="relations">`；在 `<style>` 末尾追加 `.rg2-*` 样式；在 `</script>` 前追加 RG IIFE。

- [ ] **Step 1: 策展关系图数据 `RG_DATA`**

从 `_family-tree.json` 选 8 个角色，按真实 `character_id` 核对。拟定集合（若某 id 不存在则就近替换并记录）：
`viserys_targaryen, daemon_targaryen, rhaenyra_targaryen, alicent_hightower, otto_hightower, laenor_velaryon, corlys_velaryon, rhaenys_targaryen`。

为每个角色从 `_family-tree.json` 取 `display_name / name_en / epithet / house / short_identity / portrait_url / companion`，从 `_profiles-house_of_dragon_05.json` 取 `headline / analysis / arc_so_far[] / book_note`。手排布局坐标（generation 行、列 x），目标对象写进 IIFE 顶部：

```js
const RG_DATA = {
  title_zh: '坦格利安 · 海塔尔', title_en: 'House of the Dragon',
  base: 'https://house-of-dragon-phi.vercel.app',           // 头像前缀
  chars: [
    { id:'viserys_targaryen', zh:'韦赛里斯·坦格利安', en:'Viserys I', epithet:'国王',
      house:'Targaryen', col:1, row:0, portrait:'/kb/characters/face_refs/.../x.png',
      identity:'铁王座上的和事佬', headline:'…', analysis:'…',
      arc:['…','…'], book:'…', companion:{zh:'巴勒里恩？无',portrait:null} },
    // …共 8 个
  ],
  kin: [   // 亲缘边：marriage / sibling / parent(用 parents+children)
    { kind:'marriage', a:'viserys_targaryen', b:'alicent_hightower', label:'夫妻' },
    { kind:'marriage', a:'daemon_targaryen',  b:'rhaenyra_targaryen', label:'夫妻', cross:true },
    { kind:'parent', parents:['viserys_targaryen'], children:['rhaenyra_targaryen'] },
    // …
  ],
  conflict: [ // 冲突/关系边：kind ∈ enemy/ally/blood/secret/friend
    { from:'alicent_hightower', to:'rhaenyra_targaryen', kind:'enemy',  relation:'昔日挚友 · 今日政敌' },
    { from:'otto_hightower',    to:'alicent_hightower',  kind:'ally',   relation:'父女 · 绿党操盘' },
    // …每个角色至少 1–2 条
  ]
};
```

- [ ] **Step 2: 写 section 骨架 + SVG 容器 + profile 侧栏 DOM**

插入（文案纯中文，无英文模块名）：

```html
<section id="relations">
  <div class="eyebrow accent-r">交互演示 ⑤ · 人物关系与档案</div>
  <h2 class="sec">谁和谁，因何而站到了桌子的两端。</h2>
  <p class="lead">点一个角色，看 TA 牵动的盟友与敌对，<b style="color:var(--text)">右侧滑出这个人到此刻为止的档案——绝不剧透更晚的剧情。</b></p>
  <div class="demo">
    <div class="head"><span class="dot" style="background:var(--reason)"></span><span class="t">人物关系图谱</span><span class="badge">《龙之家族》· S1E5</span></div>
    <div class="body">
      <div class="rg2-stage" id="rg2Stage">
        <svg class="rg2-svg" id="rg2Svg"></svg>
        <aside class="rg2-profile" id="rg2Profile" aria-hidden="true"></aside>
      </div>
      <div class="tiny center" style="margin-top:12px">点角色看冲突线 + 档案 · 点空白处依次收起档案、收起高亮</div>
    </div>
  </div>
</section>
```

- [ ] **Step 3: 追加 CSS `.rg2-*`**

沿用文件既有的 `--reason/--emotion/--instinct/--intuition/--green/--wine` 变量与 `.demo/.head/.body` 风格。要点：`.rg2-stage{position:relative;height:460px;overflow:hidden;border-radius:var(--radius)}`；`.rg2-profile{position:absolute;top:0;right:0;width:320px;height:100%;transform:translateX(100%);transition:.32s;…}` + `.rg2-profile.is-open{transform:none}`；节点圆 `.rg2-node`，冲突线 `.rg2-conf-enemy`（绯红实线）/`-ally`（绿虚线）/`-blood`（暖灰）/`-secret`（紫点线）/`-friend`（蓝），`.is-dim{opacity:.22}`，`.is-future{opacity:.4;stroke-dasharray:3 4}`。字母圈兜底 `.rg2-fallback{…家族色背景+首字}`。

- [ ] **Step 4: 写 RG IIFE — 渲染家族树**

`computeXY(c)= {x: PAD + c.col*COLW, y: PAD + c.row*ROWH}`。渲染顺序：kin 边层 → 节点层。节点 = `<image href=base+portrait onerror=…切换字母圈>` + 中英名 + 称号牌 + 龙伴小圈。婚姻横杠/跨代斜线/父子桥按 spec §5.1。整张图按容器宽度做一次 `viewBox` 自适应缩放（不做手动拖拽缩放）。

- [ ] **Step 5: 写交互 — 点角色高亮 + profile 滑入**

```js
let curId=null, profOpen=false;
function selectChar(id){
  curId=id; highlightConflicts(id); openProfile(id); profOpen=true;
}
function highlightConflicts(id){
  // 与 id 有关的 conflict 边显示（future 的加 .is-future），其余节点 .is-dim
}
function openProfile(id){
  const c = RG_DATA.chars.find(x=>x.id===id);
  // 填充：头像/中英名/称号+House/身份/深度解读/至今的剧情节点(ul)/血与火·背景/龙伴
  profile.classList.add('is-open'); profile.setAttribute('aria-hidden','false');
}
```

- [ ] **Step 6: 写交互 — 点空白渐进关闭（必须保留）**

```js
stage.addEventListener('click', e=>{
  if (e.target.closest('.rg2-node')) return;     // 点节点交给节点 handler
  if (e.target.closest('.rg2-profile')) return;  // 点 panel 内不关
  if (profOpen){ closeProfile(); profOpen=false; return; }  // 第一层：关档案
  if (curId){ clearHighlight(); curId=null; }               // 第二层：关高亮
});
```

- [ ] **Step 7: 把关系图入口写进导航与架构层文案**

在 `.nav .links` 增加 `<a href="#relations">关系</a>`；架构 section ① 层里的“关系图按钮”表述保持，不暴露组件名。

- [ ] **Step 8: B-CHECK + S-CHECK**

B-CHECK：打开页面 → 滚到“人物关系与档案” → 点亚莉森特：出现到雷妮拉的“敌对”绯红线、奥托“盟友”绿虚线，其余节点变暗，右侧档案滑入且字段为中文标签。点空白一次关档案、再点一次关高亮。断网刷新：头像变字母圈，不裂图。Console 无报错。
S-CHECK：抽 `<script>` 跑 `node --check`，无语法错误。

- [ ] **Step 9: Commit**
```
git add conspirator-demo.html
git commit -m "feat(demo): 新增人物关系图+档案交互（真数据策展，点空白渐进关闭）"
```

---

## Task 3: 新增「故事线时间线」模块（交互演示 ⑥）

**Files:**
- Modify: `conspirator-demo.html` — 在 `#relations` 后插入 `<section id="timeline">`；追加 `.tl-*` CSS 与 TL IIFE。

- [ ] **Step 1: 策展 `TL_DATA`**

读 `server/kb/storyline/house_of_dragon_05.json`，按真实节点取 6–9 个 beat，每个：`t`（真实时间戳，秒→`mm:00` 显示）、`title`、`summary`、`refs`（关联角色/符号名，纯中文）。按 t 升序：

```js
const TL_DATA = { cursor: 31*60, nodes: [
  { t: 8*60+27, title:'…', summary:'…', refs:['韦赛里斯','王座之伤'] },
  // …
]};
```

- [ ] **Step 2: section 骨架 + 进度条**

```html
<section id="timeline">
  <div class="eyebrow accent-g">交互演示 ⑥ · 故事线脉络</div>
  <h2 class="sec">看到哪，故事就解锁到哪。</h2>
  <p class="lead">未播的节点是锁住的——<b style="color:var(--text)">拖动观看进度，剧情脉络随你一格格点亮，不抢先剧透。</b></p>
  <div class="demo"><div class="head">…<span class="t">故事线脉络</span><span class="badge" id="tlBadge">观看进度 31:00</span></div>
    <div class="body">
      <div class="tl-track" id="tlTrack"></div>
      <div class="scrubwrap"><div class="tiny" style="display:flex;justify-content:space-between"><span>观看进度</span><span id="tlCursorTxt">31:00</span></div>
        <input type="range" class="scrub" id="tlScrub" min="0" max="60" value="31"/></div>
    </div></div>
</section>
```

- [ ] **Step 3: CSS `.tl-*`** — 竖直/横向时间轴节点；`.tl-node.locked{filter:blur(3px) grayscale(1);opacity:.5}` 显示“等播到这里再揭晓”；解锁态可点开摘要。用 `--green` 作该区主色（避免堆金）。

- [ ] **Step 4: TL IIFE — 渲染 + 进度联动**

```js
function render(t){
  TL_DATA.nodes.forEach(n=>{
    const locked = n.t > t;
    // locked → 模糊+锁文案；unlocked → 标题可点，点开 summary + refs chips
  });
  badge/cursorTxt = fmt(t);
}
scrub.addEventListener('input', ()=>render(+scrub.value*60));
render(TL_DATA.cursor);
```

- [ ] **Step 5: 导航加 `关于故事线` 链接**：`.nav .links` 增 `<a href="#timeline">脉络</a>`。

- [ ] **Step 6: B-CHECK + S-CHECK**：拖进度条到 50:00，更多节点点亮；拖回 10:00，靠后的节点重新锁住并显示锁文案；点已解锁节点展开摘要+关联 chips。Console 无报错；`node --check` 通过。

- [ ] **Step 7: Commit**
```
git add conspirator-demo.html
git commit -m "feat(demo): 新增故事线脉络时间线（真实节点+进度防剧透解锁）"
```

---

## Task 4: 深化「立场抉择卡」（真实触发点 + 反事实推演 + 轨迹不打分）

**Files:**
- Modify: `conspirator-demo.html` — 替换 `#stance` section 内容（约 403-437 行）与 STANCE IIFE（约 661-698 行）。

- [ ] **Step 1: 策展 `STANCE_DATA`**（读 `server/kb/stance/house_of_dragon_05.json`，用 Read 工具避免乱码）

取 3–4 个触发点，每个：

```js
const STANCE_DATA = { triggers: [
  { id:'…', t:290, scene:'谷地 · 戴蒙杀妻', headline:'立场抉择',
    prompt:['戴蒙杀了自己的妻子来摆脱一段他从未想要的政治联姻。'],
    convergence:'无论戴蒙杀不杀，他与雷妮拉的纠葛都会以同样毁灭性的方式继续。',
    options:[
      { id:'…', label:'冷酷但合理', voice:'这桩婚姻困住了他十年。', canonical:true },
      { id:'…', label:'不可接受',   voice:'再不想要也不是出路。',
        spec:'如果戴蒙真的转身离开——婚姻继续，他与雷妮拉的关系会被这层困境拖得更沉。' },
      { id:'…', label:'另有其因',   voice:'真正该追究的是当年安排联姻的人。',
        spec:'如果当年没安排这桩婚姻——戴蒙年少时就在宫廷扎根，雷妮拉的成长会全然不同。' },
    ]},
  // …共 3–4 个
]};
```

- [ ] **Step 2: 替换 section DOM** — 头部标题去掉英文名，改纯中文「立场抉择卡」；加 上一/下一 触发点步进按钮 `#stPrev/#stNext` 与 `#stTraj`（我的立场轨迹列表）。

- [ ] **Step 3: 替换 STANCE IIFE 逻辑**

```js
let idx=0; const traj=[];   // 仅存 {scene,label}，不存任何分数
function renderTrigger(){ /* 填 scene/prompt/options，重置推演区 */ }
function choose(opt){
  // 选项高亮；canonical → 展示 convergence（“剧情本就如此”基调）；否则 typeOut(opt.spec)
  traj.push({scene:cur.scene, label:opt.label});
  renderTraj();   // 仅按时间列出「场景 · 所选」，无打分/排名/归类
}
```

- [ ] **Step 4: 清禁词** — 删除该 section 内 `StanceCard` 字样（G-CHECK 复查该行清零）。

- [ ] **Step 5: B-CHECK + S-CHECK**：选“剧情线”选项出现收敛说明；选其它出现反事实推演打字；步进到下一触发点正常；轨迹只列选择、无任何数字分数。`node --check` 通过。

- [ ] **Step 6: Commit**
```
git add conspirator-demo.html
git commit -m "feat(demo): 立场卡换真实触发点+反事实推演，轨迹只列选择不打分"
```

---

## Task 5: 深化「四色声部」（真实台词 + 真分支追问）

**Files:**
- Modify: `conspirator-demo.html` — 替换 CHARS 数据与 `answer()` 分支逻辑（约 700-778 行）；section 标题去英文名。

- [ ] **Step 1: 策展 `CV_DATA`**（读 `dialogue_riffs/house-of-the-dragon.json` + `characters/house-of-the-dragon.roleplay.json`）

每角色 ≥3 个问题，每个回答带其**自身**的 2–3 个跟问（指向真实的下一问，不再 `(i+1)%`）：

```js
const CV_DATA = { daemon:{ name:'戴蒙·坦格利安', intro:[['表层','…'],['深层','…']],
  qs:{ q1:{ q:'…', said:'…',
        v:[['reason','王座算计','…'],['instinct','龙血','…']], sub:'…',
        follow:[{tag:'血亲', to:'q2'},{tag:'审慎', to:'q3'}] },
      q2:{…}, q3:{…} } }, rhaenyra:{…}, alicent:{…} };
```

- [ ] **Step 2: 改 `answer(qid)` 用 key 寻址**，跟问 chip 点击跳到 `follow[i].to` 指向的真实问题；保留四色（蓝/红/紫/琥珀）、潜台词、轮次计数与“绝不剧透未来”文案。

- [ ] **Step 3: 标题去英文名**（`CharacterPanel · 四色声部` → `四色声部`）。

- [ ] **Step 4: B-CHECK + S-CHECK**：切换 3 个角色；点不同跟问进入**不同**真实回答（非循环）；四色与潜台词正常。`node --check` 通过。

- [ ] **Step 5: Commit**
```
git add conspirator-demo.html
git commit -m "feat(demo): 四色声部换真实台词+真分支追问（不再循环切题）"
```

---

## Task 6: 深化「符号热点」与「AI 解析面板」

**Files:**
- Modify: `conspirator-demo.html` — 扩充 SYM 与 AGENT 数据（约 781-857 行）；两处标题去英文名。

- [ ] **Step 1: 扩充 `SYM`**（读 `symbols/house-of-the-dragon.json`）到 4–6 个真实符号，真实时间戳、真实分类（色彩编码/伏笔/文化梗），含至少 1 个跨集回看 `callback`。同步更新 `symbolsAt` 与画面光点坐标。

- [ ] **Step 2: 扩充 `AGENT`**（读 `lore_cards/house-of-the-dragon.json`）到 4–5 个问题，分层 [事实]/[解读]/[推测] + lore 卡，沿用流式打字。

- [ ] **Step 3: 标题去英文名**（`SymbolHotspots`/`AgentPanel` → `画面叠加层`/`快捷提问`）；进度条文案 `cursor_time` → `观看进度`（约 488 行）。

- [ ] **Step 4: B-CHECK + S-CHECK**：点新增光点出档案；拖进度条过滤未来符号且计数正确；回看 callback 显示；AI 面板新问题分层流式正常。`node --check` 通过。

- [ ] **Step 5: Commit**
```
git add conspirator-demo.html
git commit -m "feat(demo): 符号热点与AI解析面板换真实数据并去除内部命名"
```

---

## Task 7: 视觉/动效抠细 + 全局约束验收

**Files:**
- Modify: `conspirator-demo.html` — 跨模块 CSS/动效统一。

- [ ] **Step 1: 配色分区复查** — 通读各 section 的 accent，确保按语义分区：理性区灰蓝、情感区紫、本能区红、直觉区琥珀、绿党/故事线绿、品牌区绯红；删掉“处处金/绯红”的堆叠。

- [ ] **Step 2: 动效统一** — profile/时间线展开过渡、流式打字节奏、reveal 进场统一缓动；给关系图与时间线套与现有 `.demo` 一致的类播放器外壳质感。

- [ ] **Step 3: G-CHECK（禁词清零）**

Run:
```
rg -n "StanceCard|CharacterPanel|SymbolHotspots|AgentPanel|cursor_time|本剧 KB|server/kb|_family-tree|convergence_hint|by_option|is_canonical|short_identity|arc_so_far|book_note" conspirator-demo.html
```
Expected: **0 命中**（数据对象内部 key 若仍用英文是允许的——它们不渲染进可见文案；但若上面这些词出现在 `<text>/<div>` 等可见位置必须清除。逐条人工确认命中行是否可见文案）。

- [ ] **Step 4: 离线兜底验收** — 断网打开页面：全部文字与交互可用，所有头像退化为字母圈，无裂图、无 Console 报错。

- [ ] **Step 5: 全量 B-CHECK** — 顶部导航每个锚点可跳；6 个交互逐一走查一遍；移动端窄屏（DevTools 手机视图）无错位。

- [ ] **Step 6: Commit + Push**
```
git add conspirator-demo.html
git commit -m "style(demo): 视觉/动效统一抠细 + 全局约束验收（禁词清零、离线兜底）"
git push origin main
```

---

## Self-Review（写完计划后对照 spec 复查）

- **Spec 覆盖**：§5.1→Task2；§5.2→Task3；§5.3→Task4；§5.4→Task5；§5.5/§5.6→Task6；§5.7→Task7；§4 数据源→各 Task Step 1；§3 约束→各 Task + Task7 G-CHECK。无遗漏。
- **占位符**：数据对象用 `…` 是“执行时按真实 KB 填充”的明确指示 + 给了完整 schema 与字段映射，非 TODO 黑洞；交互逻辑给了可直接落地的函数骨架。
- **命名一致**：id 前缀 `rg2-/tl-/st-/cv-/sym-/ap-` 全程一致；`RG_DATA/TL_DATA/STANCE_DATA/CV_DATA/SYM/AGENT` 命名一致；`selectChar/highlightConflicts/openProfile/closeProfile` 跨步骤一致。
