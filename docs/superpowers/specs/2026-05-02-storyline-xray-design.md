# 叙事 X 光（关键事件结构图 + 人物关系合并） — 设计稿

**日期**：2026-05-02
**作者**：kexin chen + Claude
**状态**：待 user review，pending 进入实施计划

## 1. 这是个什么功能

把当前播放器内"看本集叙事结构"这件事统一到一个入口——**叙事 X 光**。视觉参考用户提供的截图：横向节点时间线 + 主线/支线 + 关键转折菱标 + 隐藏支线锁状态 + 节点详情侧栏。

新组件**包两个 tab**：
- **关键事件结构图**（默认 tab，新做）：单集关键剧情节点的可视化时间线
- **人物关系**：现有 `RelationshipGraph` 的内容原封不动塞进来——家族树、focus card、阴谋徽章、人物档案侧栏、点空白关闭等所有现有交互**全部保留**

入口收成一个：沿用现 `RelationshipGraph` 的"HUD 按钮 → 全屏覆盖"模式，按钮文案从 `关系` 改成 `叙事`。

设计原则（同时适用两个 tab）：
- **看剧不打断**：用户主动开，关掉就回到正常播放。
- **运行时不调 LLM**：节点数据全静态 JSON，跟 dialogue-riffs 同套路。
- **手工策展**：单集 demo 范围（`house_of_dragon_05`），10 个节点全部手写。
- **隐藏支线随播放进度解锁**：不一开始就把全部支线摊给用户看。

## 2. Demo 范围

**做**：
- `house_of_dragon_05` 一集
- 7 个主线节点 + 3 条支线节点（每条支线 1 个节点），手工写好（见附录 A）
- 隐藏支线随播放时间到达 `start_time` 自动解锁
- 单击节点 → 详情侧栏（含"跳到此节点"按钮）
- "标记为片段"按钮接现有收藏系统
- "本集完成度" = 已观看主线节点数 / 主线节点总数

**不做**：
- 第三个 tab "回收伏笔"——demo 只做单集，伏笔天然跨集，本集闭环伏笔太少做不出含金量
- 跨集 / 跨剧叙事
- LLM 自动 beat 生成（4 + 3 + 3 = 10 个节点手写更快更准）
- 参考图里"主线 / 支线 / 回收伏笔" 的 chip filter——demo 范围内主线 + 支线在一张图里同时呈现，靠虚线/锁图标区分，filter 没价值
- 双击跳转（避免误触；改成详情侧栏内的"跳到此节点"按钮）
- 节点的"已观看"状态持久化（运行时由 `videoRef.currentTime` 实时算）
- 移动端布局优化（沿用现有桌面布局）

## 3. 架构

### 3.1 数据模型

新建 `server/kb/storyline/house_of_dragon_05.json`（demo schema 范例）：

```json
{
  "_schema_version": 1,
  "show": "house-of-the-dragon",
  "season_canon": "S01",
  "video_id": "house_of_dragon_05",
  "main_track_node_ids": [
    "n_kill_wife",
    "n_father_farewell",
    "n_driftmark_pact",
    "n_knight_elope",
    "n_green_dress",
    "n_wedding_massacre",
    "n_blood_wedding"
  ],
  "side_tracks": [
    { "side_track_id": "st_alicent_probe", "after_node_id": "n_knight_elope",  "node_ids": ["n_alicent_interrogate"] },
    { "side_track_id": "st_daemon_chaos",  "after_node_id": "n_green_dress",   "node_ids": ["n_daemon_disrupt"] },
    { "side_track_id": "st_godswood",      "after_node_id": "n_blood_wedding", "node_ids": ["n_godswood_suicide"] }
  ],
  "nodes": [
    {
      "node_id": "n_knight_elope",
      "title": "骑士求私奔",
      "start_time": 1230.0,
      "end_time": 1860.0,
      "track": "main",
      "narrative_function": "关键转折",
      "summary": "骑士的浪漫幻想撞上公主的政治现实，裂痕不可逆转。",
      "impact": "克里斯顿恳求雷妮拉放弃王位一起私奔到厄索斯，被果断拒绝。两人关系在此刻彻底破裂，为后续婚宴血案埋下导火索。",
      "related_node_ids": ["n_driftmark_pact", "n_green_dress"],
      "is_hidden": false
    }
  ]
}
```

字段说明：

- `start_time` / `end_time`（秒）：触发"当前节点"高亮的时间窗口；`currentTime >= end_time` → 节点 = 已观看。统一规则：`start_time <= currentTime < end_time` 当前节点；`currentTime >= end_time` 已观看。
  - **主线节点**的 `end_time` = 下一个主线节点的 `start_time`（chapter-bar 模式，全集时间无缝瓜分）。最后一个主线节点用视频 duration（3587.96s）。
  - **支线节点**的 `end_time` = `start_time + 90`（典型一场戏长度，不要求和相邻节点连续）。
- `track`：`"main"` | `"side"`。
- `side_tracks`：定义支线归属。`after_node_id` = 这条支线挂在哪个主线节点之后（在 SVG 上从该主线节点向上/下分叉）。`node_ids` = 这条支线包含的节点（demo 每条支线 1 个节点；schema 支持多个）。
- `narrative_function`：叙事功能标签。**受控词表**（5 个，按 demo 实际节点收敛）：
  `铺垫` / `推进` / `关键转折` / `高潮` / `收束`
  **只有 `关键转折` 节点渲染金色菱形角标**（参考图 ◆）。其它标签只显示在详情侧栏。
- `summary`：详情侧栏 "📖 叙事功能" 下面那一句一句话解释（≤ 50 字）。
- `impact`：详情侧栏 "✨ 对剧情的影响" 那一段（一两句话，参考图风格）。
- `related_node_ids`：详情侧栏 "🔗 相关节点" 两枚 chip。约定：**第 1 个 = 前序，第 2 个 = 后续**，缺则写 `null`。
- `is_hidden`：默认 `false`。`true` 的节点（demo 中 3 个支线全部 `true`）在时间线上初始画**虚线 + 🔒 + 标题占位 "???"**；`currentTime >= start_time` 后自动解锁（虚线变实线、🔒 消失、标题恢复）。解锁状态不持久化——切走视频再回来若进度仍在 `start_time` 之后，依旧是解锁。
- 节点的"已观看"状态**不存进 JSON**，运行时由 `videoRef.currentTime > end_time` 实时算。

### 3.2 生成方式（手工，offline 一次性）

**对这个 demo 10 个节点，直接手工写 JSON。**

1. 用户已提供节点大纲（标题 + 时间戳 + 叙事功能 + 内容概要），见附录 A
2. 时间戳 `mm:ss` → 秒：`mm * 60 + ss`
3. `summary` / `impact` 从用户给的"内容概要"拆开，summary 是浓缩版（一句话定调），impact 是展开版（一两句话讲影响）
4. `related_node_ids` 主线节点取相邻主线（首尾节点的缺失方写 `null`）；支线节点 `[after_node_id, null]`
5. 写入 `kb/storyline/house_of_dragon_05.json`

**不写自动生成脚本**——10 个节点手写更快更准。如果以后扩到多集，再考虑写 `generate_storyline.js` 让 LLM 出候选 + 人筛。

### 3.3 后端

`server/index.js` 新增端点：

```
GET /api/storyline?videoId=house_of_dragon_05
→ 返回该 video_id 对应的 storyline 对象
```

实现极薄：扫 `kb/storyline/*.json`，按 `video_id` 命中后整对象返回。可加内存缓存。跟 `/api/riffs` 一个套路。

### 3.4 前端组件结构

```
StorylineXRay.js              (新)  外壳：HUD 按钮 + 蒙板 + tab 容器 + 完成度
├─ StorylineTimeline.js       (新)  Tab 1：关键事件结构图
└─ <RelationshipGraphView>    (改)  Tab 2：人物关系（无 HUD/蒙板的纯内容）
```

#### `RelationshipGraph.js` 的拆分（最关键的改造）

**原则**：不重写、不改内部渲染逻辑，只把外壳剥离出来。

- 现有 `RelationshipGraph` 里的 `open` state、HUD 按钮（`rg-hud-icon` / `rg-hud-edge`）、`rg-scrim` 蒙板、ESC 关闭这些**外壳逻辑** → 抽出去交给 `StorylineXRay`
- 内部留下的就是"全屏覆盖时渲染什么"——树、focus card、阴谋徽章、人物档案侧栏、点空白关闭。这部分**不动**
- 改造后的对外接口：`<RelationshipGraphView videoId videoRef onClose />`
  - 删掉自身的 `open` state 和 HUD 按钮
  - `onClose` 由父级（StorylineXRay）负责
- **Hard 约束**（memory 里反复提过）：人物档案 panel 之外的空白点击必须关闭档案侧栏。**重构时不要清理掉 `RelationshipGraph` 里那段 click-outside 兜底**——它处理了 scrim 不覆盖的 dead zone，只动外壳，不动这段。

#### `StorylineXRay.js`（新外壳）

挂在 `.tx-player-wrap` 里，跟 `SymbolHotspots`、`MemeOverlay` 同级。**替换**现有的 `<RelationshipGraph>` 引用——`App.js` 里那行 `<RelationshipGraph videoId={aiKb} videoRef={videoRef} />` 直接换成 `<StorylineXRay videoId={aiKb} videoRef={videoRef} />`。

职责：
- HUD 入口按钮（位置和样式跟原 `rg-hud-icon` 一致），label = `"叙事"`，icon 换成"分支时间线"风格
- `open` state，控制蒙板 + 顶栏 + tab 内容是否渲染
- 顶栏左侧：标题 `叙事 X 光` + ⓘ 提示（"显示本集关键叙事节点 + 人物关系全景"）
- 顶栏中间：tab 切换器 `关键事件结构图 / 人物关系`，默认选中前者
- 顶栏右侧：`本集完成度 X%` + 进度条 + `查看完整进度 ›`（demo 内此链接点击无操作，留 hook）
- 关闭：右上角 ✕ + ESC + 点蒙板
- 拉一次 `GET /api/storyline?videoId=...` 缓存 storyline 数据，传给 `StorylineTimeline`
- 监听 `videoRef.current.currentTime` 实时算"已观看主线节点数"，喂给完成度

`本集完成度` 算法：
```
已观看主线节点数 = main_track_node_ids.filter(id => nodes[id].end_time <= currentTime).length
完成度 = round(已观看 / main_track_node_ids.length * 100)
```

#### `StorylineTimeline.js`（Tab 1：关键事件结构图）

**布局**——参考用户提供的截图，几个核心元素：

- **顶部图例**：`已观看 / 当前节点 / 关键转折 / 隐藏支线`（4 个色块 + 文字，纯展示）
- **主区**：横向 SVG 画布，可拖拽 + 滚轮缩放
  - **主线**：7 个节点等距（横向 spacing 由 `start_time` 比例计算）水平铺开，节点之间实线连接
  - **支线**：每条支线从其 `after_node_id` 主线节点的上方/下方分叉（A、B、C 交替上/下，避免拥挤），虚线箭头连接
  - **节点形状**：圆角矩形，标题（一行最多 6-8 字）+ 时间戳（`mm:ss`），底部一个 ✓ 表示已观看
  - **关键转折节点**：节点上方加金色菱形小角标（◆）
  - **隐藏支线节点**：虚线描边 + 🔒 + 标题改成 `???`。`currentTime` 走过 `start_time` 后，🔒 消失、虚线变实线、标题恢复。
  - **当前节点**：双层金色发光描边（参考图那个发光的"发现密信"风格）
- **右下角**：缩放控件 `−ㅤ100%ㅤ+` + 全屏按钮
- **左下角**：`💡 拖动或滚动可查看更多内容`

**节点交互**：

- **单击节点** → 主区右侧滑出**详情侧栏**：
  - 标题（节点 title） + 时间戳
  - 区块 1 `📖 叙事功能：<标签>` + 一行 `summary`
  - 区块 2 `✨ 对剧情的影响` + 一段 `impact`
  - 区块 3 `🔗 相关节点`：两个 chip（前序 / 后续，根据 `related_node_ids[0/1]`，`null` 的不渲染），点击 → 主区滚动并选中对应节点（不跳视频时间）
  - 区块 3 下方文字按钮：`← 前序  后续 →`（功能同两 chip，参考图视觉冗余但保留）
  - 底部主操作 `▶ 跳到此节点`：`videoRef.currentTime = node.start_time`
  - 底部次操作 `🔖 标记为片段`：接现有收藏系统（详见 §3.5）
- **不做双击跳转**——避免误操作打断观看；跳转走详情侧栏的按钮。

**视频时间同步**：

- 监听 `videoRef.current.currentTime`（`timeupdate`，~250ms）
- `start_time <= currentTime < end_time` → 该节点 = `当前节点`（主线最多一个）
- `currentTime >= end_time` → 该节点 = `已观看`
- `currentTime >= start_time` 且 `is_hidden = true` → 解锁（`is_hidden` 的运行时副本翻成 `false`，UI 重画）

### 3.5 "标记为片段" 接收藏系统

现有 `useMemeFavorites` hook 已经在做"收藏文化梗"。复用它（或它的存储模型）来收藏 storyline 节点，统一存到 `localStorage`。

收藏 payload：
```json
{
  "kind": "storyline_node",
  "videoId": "house_of_dragon_05",
  "node_id": "n_knight_elope",
  "title": "骑士求私奔",
  "start_time": 1230.0,
  "end_time": 1860.0,
  "summary": "骑士的浪漫幻想撞上公主的政治现实，裂痕不可逆转。",
  "saved_at": "2026-05-02T..."
}
```

**实现路径**——两个选项，落 plan 时再决：
- **A.** 把 `useMemeFavorites` 泛化成 `useFavorites`，加个 `kind` 维度（`'meme' | 'storyline_node'`），在 `FavoritesView` 里加一个 storyline 节点的卡片渲染
- **B.** 新建 `useStorylineFavorites`，跟 `useMemeFavorites` 并存，`FavoritesView` 里 merge 两份

倾向 **A**——避免重复造轮子。但因为这会动到现成跑通的收藏页，落 plan 时先确认一下。

### 3.6 文件改动总览

新增：
- `server/kb/storyline/house_of_dragon_05.json`（demo 数据，见附录 A）
- `client/src/StorylineXRay.js` + `StorylineXRay.css`
- `client/src/StorylineTimeline.js` + `StorylineTimeline.css`

修改：
- `server/index.js`：加 `GET /api/storyline` 端点（~15 行）
- `client/src/RelationshipGraph.js`：拆出 `RelationshipGraphView`（剥外壳）；删 HUD 按钮、`open` state、`rg-scrim`、ESC handler；保留所有内部渲染和 click-outside 兜底
- `client/src/App.js`：把 `<RelationshipGraph .../>` 替换成 `<StorylineXRay .../>`，一行替换
- `client/src/useMemeFavorites.js`（如果走 §3.5 方案 A）：泛化成 `useFavorites`，支持 `kind` 维度；改名 + 兼容旧 localStorage key（保留旧 key 的迁移读，新写用新 key）
- `client/src/FavoritesView.js`：增加 storyline 节点的卡片样式

## 4. 数据流

```
┌──────────────────────────────────────────────────────────────────┐
│  Offline (一次性)                                                │
│                                                                  │
│  用户提供节点大纲 (附录 A)                                       │
│    │                                                             │
│    ▼ 手工写 JSON: 时间戳转秒 + summary/impact 拆分               │
│    │                                                             │
│  kb/storyline/house_of_dragon_05.json                            │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  Runtime                                                         │
│                                                                  │
│  StorylineXRay 挂载                                              │
│    │                                                             │
│    ▼ GET /api/storyline?videoId=house_of_dragon_05               │
│    │                                                             │
│  storyline = { nodes, main_track_node_ids, side_tracks }         │
│    │                                                             │
│    ▼ video.timeupdate (250ms)                                    │
│    │                                                             │
│  对每个节点算状态：当前 / 已观看 / 解锁(隐藏支线)                │
│  对主线节点算"完成度 = 已观看主线数 / 主线总数 × 100%"           │
│    │                                                             │
│    ▼ 用户点 HUD "叙事" → setOpen(true)                           │
│    │                                                             │
│  顶栏 tab 默认 "关键事件" → 渲染 StorylineTimeline               │
│    │                                                             │
│    ▼ 用户单击节点                                                │
│    │                                                             │
│  详情侧栏滑出 → 显示 summary / impact / related / 动作按钮       │
│    │                                                             │
│    ├─▶ 点 "▶ 跳到此节点" → videoRef.currentTime = start_time     │
│    └─▶ 点 "🔖 标记为片段" → useFavorites.add({kind:'storyline_node', ...}) │
│                                                                  │
│    ▼ 用户切到 tab "人物关系"                                     │
│    │                                                             │
│  渲染 RelationshipGraphView (现有内容原样)                       │
└──────────────────────────────────────────────────────────────────┘
```

## 5. 边界情况

- **同时多个节点窗口重叠**：手写 JSON 时主线相邻节点 `[start, end]` 无缝衔接，不会重叠；支线节点窗口可能和主线重叠（这是预期的——同一时刻播主线戏，支线节点也在该时段内"已发生"）。"当前节点"找主线优先：`main_track_node_ids` 顺序遍历，找到第一个 `start ≤ t < end` 即为当前节点；支线节点不竞争"当前节点"高亮，但仍可被解锁。
- **视频 seek 到节点中间**：`timeupdate` 触发时立即重算所有节点状态，UI 立即更新。
- **视频 seek 回到 0**：所有节点 `已观看` 状态清除（因为 `currentTime >= end_time` 不再成立），但**已解锁的 `is_hidden` 节点保持解锁**——一旦 `currentTime >= start_time` 触发过解锁，运行时副本不再翻回。这是个温和的设计：避免观众回看时支线又锁回去看不到。
- **完成度边界**：`currentTime >= 最后一个主线节点的 end_time` → 100%。视频结尾后保持 100%。
- **storyline JSON 缺失**（其他视频）：`/api/storyline` 返回 404 或 `{}`，HUD 按钮**默认隐藏**。这跟 dialogue-riffs 一致。
- **Tab 切换时的状态保留**：从"关键事件"切到"人物关系"再切回来，`StorylineTimeline` 的"当前选中节点"和"详情侧栏开合状态"丢失可接受（重新打开默认收起）。`RelationshipGraphView` 的内部状态（focus card、人物档案）由它自己管，跟现在一致。
- **HUD 按钮替换可能漏交互**：原 `RelationshipGraph` 自带"剧情阴谋徽章" `has-news` 视觉提示——拆出来后这个能力**保留**，由 StorylineXRay 的 HUD 按钮承袭。`useEffect` 监听阴谋点逻辑跟着外壳一起搬过去。
- **`useFavorites` 迁移老 localStorage key**：旧 key 是 `memeFavorites`（推断），新 key 改成 `favorites`。挂载时如果新 key 不存在但旧 key 有数据，读旧 key 写新 key，老 key 保留不删（防回滚）。

## 6. 测试

不写自动化测试。验收靠手动：

1. **基础时间线渲染**：开 player 播 `house_of_dragon_05`，点 HUD "叙事"按钮，期望：
   - 默认 tab 是"关键事件结构图"
   - 7 个主线节点横向铺开，时间戳正确
   - 3 个支线节点初始锁住（虚线 + 🔒 + `???`）
   - 节点 4 (n_knight_elope) 上方有金色菱形（关键转折）
   - 完成度初始 0%（还没播任何 end_time）
2. **隐藏支线解锁**：拖进度条到 26:30 (1590s) → 节点 A "亚莉森审问骑士"(1570s) 应该解锁（虚线变实线、🔒 消失、标题正确显示）
3. **当前节点高亮**：拖到 21:00 (1260s) → 节点 4 "骑士求私奔"应该高亮（双层金色发光描边）
4. **已观看状态**：拖到 25:00 (1500s) → 节点 1-3 应该是"已观看"样式，节点 4 是当前
5. **完成度**：拖到 35:00 (2100s) → 节点 1-4 已观看（4/7 ≈ 57%），完成度应该显示 ~57%
6. **节点单击 → 详情侧栏**：点节点 4，期望侧栏显示：
   - 标题"骑士求私奔" + `20:30`
   - "📖 叙事功能：关键转折" + summary
   - "✨ 对剧情的影响" + impact
   - "🔗 相关节点"两 chip（n_driftmark_pact / n_green_dress）
   - "▶ 跳到此节点" + "🔖 标记为片段"
7. **跳到此节点**：在节点 4 详情侧栏点"▶ 跳到此节点" → 视频 seek 到 20:30
8. **相关节点导航**：点"前序" chip → 节点 3 在主区滚动到中间 + 该节点详情侧栏滑入（视频时间不变）
9. **标记为片段**：点"🔖 标记为片段" → 收藏页 (`FavoritesView`) 应该看到这个节点的卡片
10. **Tab 切换**：切到"人物关系"tab → 渲染 `RelationshipGraphView`，所有现有交互正常（focus card 出现、点角色拉档案、徽章显示、点空白关闭档案）。**特别验证 click-outside 关闭档案的兜底没坏**。
11. **HUD 按钮替换**：HUD 按钮 label 是"叙事"不是"关系"；阴谋徽章（如果当前视频时间触发了阴谋点）依旧显示在按钮上
12. **没数据的 fallback**：临时切到一个没 storyline JSON 的 video → HUD 按钮隐藏
13. **关闭交互**：✕ / ESC / 点蒙板都能关闭"叙事 X 光"
14. **收藏迁移**：如果有旧的 memeFavorites localStorage 数据，刷新页面应该能在收藏页看到

## 7. 不在范围内（写给后续阶段）

- **第三个 tab "回收伏笔"**：要做就得跨集 + 多集数据，是产品下一阶段的事。
- **跨集 / 跨剧叙事**：单集 demo 闭环。多集时需要 season-level 时间线（参考图右上"查看完整进度 ›"那个 hook 留好了）。
- **运行时 LLM 兜底**：长尾节点或其他剧集的实时生成。
- **支线 chip filter**：参考图有"主线 / 支线 / 回收伏笔"chip 切换，demo 不实现，主线和支线在一张图里同时呈现。
- **节点的双击跳转 + 拖拽编辑**：避免误操作；跳转走详情侧栏按钮。
- **移动端布局**：横向时间线在手机上要么大幅缩放、要么改成纵向 list。先桌面 demo。
- **节点搜索 / 跳转**：以后多集多节点再做。
- **节点的"已观看"持久化**：现在完全靠 `currentTime` 实时算，刷新即丢。要做需要后端 user state。
- **`generate_storyline.js` 自动出候选脚本**：10 个节点手写更快。

---

## 附录 A：完整 demo 节点数据

> 用户提供的节点大纲（主线 7 + 支线 3）已经填齐 schema，下面是落到 JSON 时的字段映射。最终 `server/kb/storyline/house_of_dragon_05.json` 按这份内容生成。

### 主线（7 个节点）

| ID | title | start (mm:ss → s) | end (s) | narrative_function | summary（一句话） | impact（剧情影响） |
|---|---|---|---|---|---|---|
| `n_kill_wife` | 开场杀妻 | 00:00 → 0 | 340 | 铺垫 | 开场即定调：这集没人是干净的。 | 戴蒙在谷地惊马杀死妻子蕾雅·罗伊斯，用石头补刀。一场冷血私刑给本集所有"忠诚 / 私情 / 政治"的张力定下基调。 |
| `n_father_farewell` | 父女诀别 | 05:40 → 340 | 735 | 铺垫 | 亚莉森的立场从这一刻开始动摇。 | 奥托被解除国王之手，临走警告亚莉森："雷妮拉登基之日就是你孩子的死期。"绿党立场的种子在此种下。 |
| `n_driftmark_pact` | 潮汐堡谈判 | 12:15 → 735 | 1230 | 推进 | 两个棋子试图在棋盘上找到自己的空间。 | 雷妮拉与莱诺在海岸散步，坦诚协商开放式婚姻——各取所需、各有情人。政治联姻的轮廓清晰起来，但也暴露了"私情留缝"。 |
| `n_knight_elope` | 骑士求私奔 | 20:30 → 1230 | 1860 | 关键转折 | 骑士的浪漫幻想撞上公主的政治现实，裂痕不可逆转。 | 克里斯顿恳求雷妮拉放弃王位一起私奔到厄索斯，被果断拒绝。两人关系彻底破裂，为后续婚宴血案埋下导火索。 |
| `n_green_dress` | 绿裙登场 | 31:00 → 1860 | 2325 | 推进 | 无声宣战，阵营从此划定。 | 婚宴已开，亚莉森身着海塔尔家族战争色"绿色"礼裙迟到入场。全场起立，唯戴蒙未动。这一刻黑党 vs 绿党的分裂正式公开化。 |
| `n_wedding_massacre` | 婚宴血案 | 38:45 → 2325 | 2660 | 高潮 | 婚宴变屠场，莱诺崩溃。 | 乔弗里识破克里斯顿是雷妮拉的情人并试图结盟，克里斯顿精神崩溃当场将其殴打致死。一场公开侮辱性的血案，所有伪装彻底撕掉。 |
| `n_blood_wedding` | 血色婚礼 | 44:20 → 2660 | 3587.96 | 收束 | 一切才刚刚开始——本集是钩子的起点，不是终点。 | 婚礼在血泊中仓促举行，雷妮拉含泪宣誓，莱诺只给了嘴角一吻。老鼠舔血的镜头收尾。本集冲突收束，下一段权力撕裂正式开锣。 |

主线 `related_node_ids`（[前序, 后续]）：
- `n_kill_wife`: `[null, "n_father_farewell"]`
- `n_father_farewell`: `["n_kill_wife", "n_driftmark_pact"]`
- `n_driftmark_pact`: `["n_father_farewell", "n_knight_elope"]`
- `n_knight_elope`: `["n_driftmark_pact", "n_green_dress"]`
- `n_green_dress`: `["n_knight_elope", "n_wedding_massacre"]`
- `n_wedding_massacre`: `["n_green_dress", "n_blood_wedding"]`
- `n_blood_wedding`: `["n_wedding_massacre", null]`

`is_hidden` 全部 `false`。`track` 全部 `"main"`。

### 支线（3 个节点）

| ID | title | start (mm:ss → s) | end (s) | after_node_id | narrative_function | summary | impact |
|---|---|---|---|---|---|---|---|
| `n_alicent_interrogate` | 亚莉森审问骑士 | 26:10 → 1570 | 1660 | `n_knight_elope` | 推进 | 亚莉森获得了关键把柄。 | 亚莉森试探克里斯顿是否知道雷妮拉与戴蒙的事，克里斯顿主动坦白了自己与公主的关系。从此绿党握有一张可以随时摊开的牌。 |
| `n_daemon_disrupt` | 戴蒙搅局 | 35:20 → 2120 | 2210 | `n_green_dress` | 推进 | 韦赛里斯目睹一切，无力阻止。 | 戴蒙在宴会中挑衅谷地爵士、调戏雷妮拉，试图当众带走她私奔龙石岛。婚宴的情绪压力被推到爆炸前夜。 |
| `n_godswood_suicide` | 神木林自杀 | 46:50 → 2810 | 2900 | `n_blood_wedding` | 收束 | 拥王者的起点——从此骑士不再效忠公主，而是效忠王后。 | 克里斯顿在神木林前拔刀准备切腹，亚莉森及时阻止。绿党核心战士的"忠诚转向"在此完成，权力天平倾斜。 |

支线 `related_node_ids`：
- `n_alicent_interrogate`: `["n_knight_elope", null]`
- `n_daemon_disrupt`: `["n_green_dress", null]`
- `n_godswood_suicide`: `["n_blood_wedding", null]`

`is_hidden` 全部 `true`。`track` 全部 `"side"`。

### 视频元数据
- duration: `3587.96` 秒（来自 `server/kb/house_of_dragon_05.json`）
- 主线 7 节点的 `end_time` 严格按"下一节点 start"算，最后一个用 duration
- 支线 3 节点的 `end_time = start + 90`
