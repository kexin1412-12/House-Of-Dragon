# 文化梗 / Dialogue Riffs — 设计稿

**日期**：2026-05-01
**作者**：kexin chen + Claude
**状态**：approved，进入实施计划

## 1. 这是个什么功能

在视频的某些台词出现的瞬间，让用户能"看到"这句话背后的文化梗——文学典故、双关、流行文化引用之类。设计原则：

- **不打断观看体验**。看剧不应该变成阅读理解。
- **三层信息密度**。屏幕上一个金色描边 → hover 浮窗一句话 → 想读细节去右栏。每一层都比上一层多一倍承诺，少一倍干扰。
- **有总开关**。文化注释是个有人爱有人嫌挡画面的东西，必须可关。

## 2. Demo 范围

- 只在 `house_of_dragon_05` 这一集上做
- 全集**手工筛选 5–8 条**台词梗，不做全自动
- 运行时**不调 LLM**：所有梗内容预先以静态 JSON 存放，前端读 KB 直接渲染
- 浮窗只在 hover 关键词时出现（不自动弹）
- 不做：用户语言/历史画像、收藏分享、运行时 LLM 兜底、避脸算法

## 3. 架构

### 3.1 数据模型

新建 `server/kb/dialogue_riffs/house-of-the-dragon.json`：

```json
{
  "_schema_version": 1,
  "show": "house-of-the-dragon",
  "season_canon": "S01",
  "riffs": [
    {
      "riff_id": "crown_is_heavy_e05",
      "video_id": "house_of_dragon_05",
      "episode": "S01E05",
      "anchor": {
        "start_time": 1695.2,
        "end_time": 1699.0,
        "subtitle_en": "The crown is heavy, and so is the truth.",
        "subtitle_zh": "王冠沉重，真相亦然。",
        "highlight": "crown",
        "keyframe": "frames/house_of_dragon_05/scene-NNN.jpg"
      },
      "tags": ["双关", "历史典故"],
      "tier2_punch": "莎士比亚《亨利四世》——'戴王冠的头颅难安'。一语双关：既指王权之重，也指说出真相的代价。",
      "tier3": {
        "why_meme": "这句台词是双关。表面意思是'王冠很重（继承王位是负担）'，但放在这场戏的语境里，'truth'三个字让它转了个弯，指向'说真话的代价同样沉重'。",
        "background": [
          "典故来源：莎士比亚《亨利四世·下篇》第三幕第一场：'Uneasy lies the head that wears a crown.'（戴上王冠的头颅，难以安睡。）",
          "莎士比亚式修辞：并列句式 + 对照结构，前后句结构一致，第二句替换关键词来形成意义跃迁。",
          "在英美权力叙事中是常见母题，《权力的游戏》《王冠》等多次直接或间接化用。"
        ],
        "why_it_matters_now": "这句台词出现在主角面临继承抉择的关键时刻，预示他将在'守护王朝'与'揭露真相'之间被撕扯——也暗示后续权力斗争的核心矛盾就在这里。"
      }
    }
  ]
}
```

字段说明：

- `anchor.start_time` / `end_time`：从 SRT 拿，以秒为单位（浮点）。这是**触发窗口**——播放时间落在 `[start, end]` 内时，前端启用 overlay。
- `anchor.subtitle_en` / `subtitle_zh`：要重新画的字幕原文。`house_of_dragon_05` 的烧录字幕是中英双语，所以这一版**两个都必填**——overlay 必须把双语都画回来，不然观众会比平时少看到中文。以后接其他视频再放宽。
- `anchor.highlight`：要套金色描边的关键词。前端用 `subtitle_en.indexOf(highlight)` 定位，第一处出现即可。如果以后要支持多关键词或多次出现，再扩展为 `[{word, occurrence}]`。
- `anchor.keyframe`：右栏列表项里显示的缩略图，复用 `kb/frames/` 里已有的 scene 关键帧。
- `tags`：右栏列表显示的小标签。**不再在 Tier 3 详情卡里重复**——遵循"不要信息冗余"原则。
- `tier2_punch`：浮窗一句话。120 字以内，看一眼就懂。
- `tier3.*`：右栏展开后的完整内容。

### 3.2 生成方式（offline 一次性）

新建 `server/scripts/generate_dialogue_riffs.js`：

1. 读 `uploads/house_of_dragon_05.srt`，把所有字幕拼成"`[start–end] text`"列表
2. 调 Gemini（用现有 `lib/ai/providers`）出一次 prompt：
   - 给它整集字幕
   - 让它选 **10–15 条候选**，每条产出完整的 riff JSON 字段
   - 要求每条都给一个 `confidence` 0–1 评分
3. 把候选写到 `kb/dialogue_riffs/_candidates.json`
4. 用户人肉过一遍，删掉不喜欢的，保留 **5–8 条**写到 `house-of-the-dragon.json`

这个脚本**不接到主流程**，是手动跑的。运行时纯吃静态 JSON。

### 3.3 后端

`server/index.js` 新增一个端点：

```
GET /api/riffs?videoId=house_of_dragon_05
→ 返回该 video_id 对应的 riffs 数组（按 start_time 升序）
```

实现极薄：扫 `kb/dialogue_riffs/*.json`，flatMap 所有 `riffs`，按 `video_id` 过滤后返回。可加内存缓存。

### 3.4 前端组件

#### `MemeOverlay.js`（画面内浮层）

挂在 `.tx-player-wrap` 里，跟 `SymbolHotspots`、`RelationshipGraph` 同级。

职责：
- 拉 `/api/riffs?videoId=...`，拿到本视频的 riffs 列表
- 监听 `videoRef.current.currentTime`（`timeupdate` 事件，~250ms 间隔；对 3–5 秒的窗口足够灵敏）
- 找到当前时间 `t` 落入哪个 riff 的 `[start_time, end_time]`
- 命中时：
  - 画一条从底部往上 ~80px 高的**黑色径向渐变蒙板**（`linear-gradient(to top, rgba(0,0,0,0.95), transparent)`），盖住烧录字幕
  - 在蒙板上画 HTML 字幕：英文一行，中文一行（中文可选）
  - 用 `<span class="meme-highlight">` 包住关键词，套金色 1px 描边 + 微弱金色阴影
  - 在 `<span>` 上挂 `onMouseEnter` / `onMouseLeave`：进入时浮出 Tier 2 气泡
- 退出窗口时整个 overlay 卸载（包括蒙板），原烧字幕恢复可见

气泡子组件 `MemePopover`：
- ~280px 宽，深色磨砂背景，金色 `✦ 文化梗` 头标
- 显示 `riff.tier2_punch` 全文 + 一行 `展开详情 >` 链接
- 点 `展开详情`：emit `onExpandRequest(riff_id)` → 父级监听并切换右栏 tab + 滚动定位
- 位置：固定在关键词 `<span>` 上方居中（用 `getBoundingClientRect` 算坐标）。气泡顶部带个小三角指向关键词。
- 不悬停就不显示。气泡显示后，鼠标移到气泡上不消失（鼠标在 `<span>` 或 popover 任意一个内即"悬停态"）；同时离开两者 → 100ms 延迟后消失。

#### `MemeToggle.js`（右上角总开关）

放在播放器右上角，跟全屏按钮一行。`✦ 文化注释已开启 ▼`：
- 状态保存在 `localStorage.memeAnnotationsEnabled`，默认 `true`
- OFF 时：MemeOverlay 不渲染，关键词描边和气泡都没了，但**右栏 tab 仍可看**（被动浏览不影响视频）
- 下拉先做最小：只有"开启 / 关闭"两项；后续可加"密度"等

#### `MemePanel.js`（右栏 tab 内容）

右侧 `<aside class="tx-right">` 顶部加一行 tab：

```
[AI 助手]  [文化梗 (5)]
```

互斥切换。当前 AgentPanel 仍存在，只是当激活的不是它的 tab 时不渲染（保留状态：聊天历史不要丢）。

文化梗 tab 内容自上而下：

1. 标题 + 总数：`本集检测到 5 个文化梗`
2. 列表：每项一卡，包含：
   - 序号 ①②③
   - 缩略图（`anchor.keyframe`，宽高 ~80×60）
   - 引文一句（截断到 ~30 字）
   - 时间戳 `28:15`（`mm:ss`，点击跳转 `videoRef.currentTime = start_time`）
   - 标签小药丸 `双关 · 历史典故`
3. 选中某条 → 该项原地手风琴展开为 Tier 3 详情卡（不弹中央窗）：
   - 引文（双语）
   - **为什么是个梗**（`tier3.why_meme`）
   - **背景知识**（`tier3.background` bullet list）
   - **剧情里为什么重要**（`tier3.why_it_matters_now`）
   - 底部按钮：`▶ 跳到此处`（主操作）+ `♡ 收藏`（次操作，demo 内无后端，仅 localStorage 记一下）
   - **不再显示标签**——上面列表项里已有
4. 接受外部消息 `onExpandRequest(riff_id)`：自动滚动到该项 + 展开

### 3.5 文件改动总览

新增：
- `server/kb/dialogue_riffs/house-of-the-dragon.json`
- `server/scripts/generate_dialogue_riffs.js`（一次性脚本）
- `client/src/MemeOverlay.js` + `MemeOverlay.css`
- `client/src/MemePanel.js` + `MemePanel.css`
- `client/src/MemeToggle.js`（小，可考虑直接放进 App.js）

修改：
- `server/index.js`：加 `GET /api/riffs` 端点（~15 行）
- `client/src/App.js`：
  - 在 `.tx-player-wrap` 里挂 `<MemeOverlay videoId={aiKb} videoRef={videoRef} onExpandRequest={...} />`
  - 在 `<aside class="tx-right">` 顶部加 tab 切换 + 条件渲染 AgentPanel / MemePanel
  - 右上角加 MemeToggle
  - 加一个 `rightTab` state（`'agent' | 'meme'`），默认 `'agent'`
- `client/src/App.css`：tab 行样式

## 4. 数据流

```
┌──────────────────────────────────────────────────────────────────┐
│  Offline (一次性)                                                │
│                                                                  │
│  uploads/house_of_dragon_05.srt                                  │
│    │                                                             │
│    ▼ scripts/generate_dialogue_riffs.js (Gemini)                 │
│    │                                                             │
│  kb/dialogue_riffs/_candidates.json (15 条)                      │
│    │                                                             │
│    ▼ 人工筛选                                                    │
│    │                                                             │
│  kb/dialogue_riffs/house-of-the-dragon.json (5–8 条)             │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  Runtime                                                         │
│                                                                  │
│  Frontend mount                                                  │
│    │                                                             │
│    ▼ GET /api/riffs?videoId=house_of_dragon_05                   │
│    │                                                             │
│  MemeOverlay 拿到 riffs[]                                        │
│  MemePanel 拿到 riffs[]（同一份缓存）                            │
│    │                                                             │
│    ▼ video.timeupdate                                            │
│    │                                                             │
│  当前 riff = riffs.find(r => start ≤ t ≤ end)                    │
│    │                                                             │
│    ▼ 命中                                                        │
│    │                                                             │
│  渲染：底部蒙板 + HTML 字幕 + 关键词金色描边                      │
│    │                                                             │
│    ▼ hover keyword                                               │
│    │                                                             │
│  MemePopover 浮出 → 点 "展开详情"                                │
│    │                                                             │
│    ▼ onExpandRequest(riff_id)                                    │
│    │                                                             │
│  App.js: setRightTab('meme') → MemePanel 自动滚动 + 展开         │
└──────────────────────────────────────────────────────────────────┘
```

## 5. 边界情况

- **多个 riff 时间窗口重叠**：手工筛选时确保不重叠。schema 不强约束，但实现上"找到第一个命中"即可。
- **关键词在字幕里出现多次**：取第一处。如果以后需要其他位置，schema 扩展 `highlight` 为对象 `{word, occurrence: 0}`。
- **总开关 OFF 时点 `展开详情`**：开关只控制画面内浮层，不影响右栏。所以这种状态下右栏照常工作；但因为画面内没有触发点了，"展开详情"这个入口不存在了——只有从右栏 tab 内主动点击列表项进入 Tier 3。
- **视频 seek 到 riff 中间**：`timeupdate` 触发时立即检测 → overlay 直接出现（不需要从 start 才出现）。
- **rightTab 切换时丢状态**：AgentPanel 的 messages 已经 lift 到 App.js state，不会因为不渲染而丢。MemePanel 的"当前展开项"内部状态丢失可接受（重新打开默认收起）。
- **没有 riffs**（其他视频）：`/api/riffs` 返回 `[]`，MemeOverlay/MemePanel 直接空渲染或显示"本集无文化梗"。MemeToggle 仍显示但点击无效果——或者干脆隐藏 toggle。**默认隐藏**。

## 6. 测试

不写自动化测试。验收靠手动：

1. 跑 `node server/scripts/generate_dialogue_riffs.js`，检查 `_candidates.json` 输出合理
2. 人肉筛选写出 `house-of-the-dragon.json`，肉眼检查 anchor 时间戳能跳到正确画面
3. 在浏览器打开 player，播放到 5 个 riff 时间点，依次确认：
   - 底部蒙板能盖住烧录字幕（不露原字幕）
   - HTML 字幕显示正确
   - 关键词金色描边正确包住目标词
   - hover keyword 浮窗出现，内容正确
   - 点"展开详情"右栏切换 + 定位 + 展开正确
   - 离开窗口时 overlay 干净退出
4. toggle 关闭：所有画面内效果消失，右栏照常工作
5. 切到其他视频（如果有）：右栏"文化梗"tab 显示空状态，无 overlay

## 7. 不在范围内（写给后续阶段）

- **完整字幕渲染层**：把所有字幕都自渲染、不依赖烧录字幕。下一步功能（多语言切换、字号调整、导出 srt 等）的前置。
- **运行时 LLM 兜底**：长尾梗或其他剧集的实时生成，含置信度阈值过滤。
- **个性化密度**：基于用户语言 / 观看历史决定哪些梗值得标注。
- **收藏 + 分享**：把梗卡片导出为图片或链接，社交分享。
- **关联图谱**：参考稿底部那个"王冠—真相—主角"语义关系图，单独的设计课题。
- **避脸算法**：浮窗位置不挡人脸的智能避让。
- **多关键词 / 同句多梗**：同一行字幕里多个词都有梗。
