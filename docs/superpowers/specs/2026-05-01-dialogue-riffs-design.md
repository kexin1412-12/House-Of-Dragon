# 文化梗 / Dialogue Riffs + AgentPanel 增强 — 设计稿

**日期**：2026-05-01
**作者**：kexin chen + Claude
**状态**：approved，进入实施计划

## 1. 这是个什么功能

两件事一起交付，因为它们共用同一份"找台词背后第二层"的内容学：

**A) 文化梗卡片**：在视频的某些台词出现的瞬间，让用户能"看到"这句话背后的文化梗——文学典故、双关、流行文化引用之类。

**B) AgentPanel prompt 增强**：教现有的 AI 助手在用户主动问"这句什么意思"时，**主动找第二层意思**（反讽 / 双关 / 角色弧压缩 / 演员高光 / 元层级），而不是只复述场面。

A 是预先策展、策略稳定、运行时不依赖 LLM 的 demo；B 是改一段 prompt、运行时让 LLM 现想，配合 A 的四张卡作 few-shot 例子。两者互为支撑。

设计原则（同时适用 A 和 B）：

- **不打断观看体验**。看剧不应该变成阅读理解。
- **三层信息密度**（A 专属）：屏幕上一个金色描边 → hover 浮窗一句话 → 想读细节去右栏。每一层都比上一层多一倍承诺，少一倍干扰。
- **有总开关**（A 专属）：文化注释是个有人爱有人嫌挡画面的东西，必须可关。
- **不强行解读**（B 专属）：没第二层就老实答场面分析，不硬挖。

## 2. Demo 范围

**A 文化梗卡片**：
- 只在 `house_of_dragon_05` 这一集上做
- **手工筛选 4 条**台词梗（已写好，见附录 A），不做全自动
- 运行时**不调 LLM**：所有梗内容预先以静态 JSON 存放，前端读 KB 直接渲染
- 浮窗只在 hover 关键词时出现（不自动弹）

**B AgentPanel 增强**：
- 只改 `server/agent.js` 里 `VISION_SYSTEM_PROMPT` 一段——**追加**"看见第二层"的指令 + 4 条 few-shot 例子
- **不动**现有的"六个角度"、回答档位（oneline / brief / deep）、模型路由（继续 Gemini 2.5 Flash + thinking）

**都不做**：
- 用户语言/历史画像、收藏分享、运行时 LLM 兜底、避脸算法
- AgentPanel 模型升级（详见 §7）

## 3. 架构

### 3.1 数据模型

新建 `server/kb/dialogue_riffs/house-of-the-dragon.json`（**已写好**，下面用真实 demo 数据中的 ④ 作 schema 范例）：

```json
{
  "_schema_version": 1,
  "_notes": ["..."],
  "show": "house-of-the-dragon",
  "season_canon": "S01",
  "riffs": [
    {
      "riff_id": "i_am_the_crown_e05",
      "video_id": "house_of_dragon_05",
      "episode": "S01E05",
      "anchor": {
        "start_time": 1530.76,
        "end_time": 1543.76,
        "subtitle_en": "I am the crown, Ser Criston. Or I will be.",
        "subtitle_zh": "我就是王冠，克里斯顿爵士。或者说，我即将是。",
        "highlight": "the crown",
        "keyframe": "frames/house_of_dragon_05/scene-278.jpg"
      },
      "tags": ["转喻", "身份宣告"],
      "tier2_punch": "路易十四'L'État, c'est moi'（朕即国家）的回响。Rhaenyra 用'王冠'代指自己，把 Criston 提议的'为爱私奔、放弃王座'那条路当场堵死……",
      "tier3": {
        "why_meme": "（详见实际 JSON 文件）",
        "background": ["..."],
        "why_it_matters_now": "..."
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

### 3.2 生成方式（手工，offline 一次性）

**对这个 demo 4 张卡，直接手工写 JSON。** 流程：

1. 读 `uploads/house_of_dragon_05.srt`，对每条选定的台词拿到大致 start/end 时间和英文原文
2. 在播放器里跳到对应时间点确认：英文是否听对了（SRT 有 ASR 错误，比如 "Cristine" → "Criston"）、时间窗口是否合身
3. 中文翻译：基于英文做文学化意译（不强求和烧录字幕一字不差）
4. Tier 2/3 内容：人写或 LLM 协助（Opus/Gemini 都行），最终由人定稿
5. 写入 `kb/dialogue_riffs/house-of-the-dragon.json`

**不写自动生成脚本**——4 张卡手工更快更准。如果以后扩到多剧集 / 几十张卡，再考虑写一个 `generate_dialogue_riffs.js` 让 LLM 出候选 + 人筛。这一版不做。

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
- `server/kb/dialogue_riffs/house-of-the-dragon.json`（**已写好，4 条 riff，见附录 A**）
- `client/src/MemeOverlay.js` + `MemeOverlay.css`
- `client/src/MemePanel.js` + `MemePanel.css`
- `client/src/MemeToggle.js`（小，可考虑直接放进 App.js）

修改：
- `server/index.js`：加 `GET /api/riffs` 端点（~15 行）
- `server/agent.js`：在 `VISION_SYSTEM_PROMPT` 里**追加一段"看见第二层"的指令 + 4 条 few-shot 例子**（见第 8 节）。**不动现有的"六个角度"**。
- `client/src/App.js`：
  - 在 `.tx-player-wrap` 里挂 `<MemeOverlay videoId={aiKb} videoRef={videoRef} onExpandRequest={...} />`
  - 在 `<aside class="tx-right">` 顶部加 tab 切换 + 条件渲染 AgentPanel / MemePanel
  - 右上角加 MemeToggle
  - 加一个 `rightTab` state（`'agent' | 'meme'`），默认 `'agent'`
- `client/src/App.css`：tab 行样式

## 4. 数据流

```
┌──────────────────────────────────────────────────────────────────┐
│  Offline (一次性，已完成)                                        │
│                                                                  │
│  uploads/house_of_dragon_05.srt                                  │
│    │                                                             │
│    ▼ 人工查时间戳 + 写 tier2/tier3 + 译中文                      │
│    │                                                             │
│  kb/dialogue_riffs/house-of-the-dragon.json (4 条)               │
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

1. 在浏览器打开 player，播放 `house_of_dragon_05`，依次跳到 4 个 riff 时间点（11:30 / 18:18 / 25:30 / 34:44），每条确认：
   - 底部蒙板能盖住烧录字幕（不露原字幕）
   - HTML 字幕显示正确（中英都对）
   - 关键词金色描边正确包住目标词
   - hover keyword 浮窗出现，内容正确
   - 点"展开详情"右栏切换 + 定位 + 展开正确
   - 离开窗口时 overlay 干净退出
2. toggle 关闭：所有画面内效果消失，右栏照常工作
3. 切到其他视频（如果有）：右栏"文化梗"tab 显示空状态，**MemeToggle 默认隐藏**
4. AgentPanel 验收：
   - 选 4 个台词时间点暂停，分别问 AgentPanel "这句什么意思" / "这场啥意思"
   - 期望回答里包含"第二层"（反讽 / 双关 / 角色弧压缩 / 演员高光 / 元层级 之一），不只是表面剧情复述
   - 没有"第二层"的普通场面（如 Corlys 进门打招呼）→ 期望模型不要硬挖，老实答场面分析

## 7. 不在范围内（写给后续阶段）

- **完整字幕渲染层**：把所有字幕都自渲染、不依赖烧录字幕。下一步功能（多语言切换、字号调整、导出 srt 等）的前置。
- **运行时 LLM 兜底**：长尾梗或其他剧集的实时生成，含置信度阈值过滤。
- **AgentPanel 模型升级到 Opus**：新写 `providers/anthropic.js` + 把 `vision_chat` 的 deep 档切到 Opus。**先不做**——先看 prompt 增强后的效果。如果 brief 档够用、deep 档还不够深，再独立立项。
- **个性化密度**：基于用户语言 / 观看历史决定哪些梗值得标注。
- **收藏 + 分享**：把梗卡片导出为图片或链接，社交分享。
- **关联图谱**：参考稿底部那个"王冠—真相—主角"语义关系图，单独的设计课题。
- **避脸算法**：浮窗位置不挡人脸的智能避让。
- **多关键词 / 同句多梗**：同一行字幕里多个词都有梗。
- **`generate_dialogue_riffs.js` 自动出候选脚本**：4 张卡手工更快。扩到多剧集 / 多集时再做。

---

## 8. AgentPanel prompt 增强

### 8.1 现状

`server/agent.js` 第 1362–1491 行的 `VISION_SYSTEM_PROMPT` 已经覆盖了：
- 人设 / 剧友语气
- 不剧透原则
- 信息来源优先级（character_dictionary / retrieved_knowledge / previous_context / 当前画面）
- "回答重点"清单（试探谁、谁掌握主动权、谁在装糊涂等）
- **六个解读角度**（视听语言 / 互文性 / 潜台词 / 心理分析 / 类型基调 / 社会学）
- 判断要不要用解读角度的标准
- 维斯特洛风格示例

**这部分一字不动。**

### 8.2 缺什么

现有 prompt 没有显式激励模型**主动找"第二层"**——表面意思之外的反讽 / 双关 / 角色弧压缩 / 演员高光 / 元层级。所以模型常常停在场面分析层（"谁压谁、谁试探谁"），不去找台词的隐藏意义。

### 8.3 要加什么

在"回答重点"和"解读角度"之间，**追加一段新指令**——叫`═══ 看见"第二层"的本能 ═══`。它不是新的"第七个角度"，而是回答前的一种思维习惯。**用判断式启发，不用 A/B/C 三段结构**（避免回答模板化）。

新指令草案：

```
═══ 看见"第二层"的本能 ═══
回答前花一秒判断：这句话/这场戏的表面意思是什么、有没有藏第二层？

第二层常见几种形式：
- 反讽：说出来的话和场面里发生的事相反（婚礼誓词"无论将来如何"——而将来正在外面发生）
- 双关 / 隐喻：字面之外另有所指（"茶"不是茶，是 moon tea）
- 角色弧压缩：一句话浓缩整条命运（"我就是王冠"——把 Criston 的"为爱不为王冠"整条路堵死）
- 演员高光：这句话是某个演员的封神瞬间，值得点出
- 元层级：嵌入剧集自身的设定（"传唱百年的歌"——剧名就是 A Song of Ice and Fire）

有第二层就先说它，表面意思一句带过或跳过。没有就老实答场面分析，不硬挖。

风格示例（这是好回答的样子，不是模板）：

例 1：用户问"Larys 这'茶'什么意思"
→ "Larys 嘴里这'茶'不是普通的茶——是 moon tea，月亮茶，维斯特洛的堕胎药。
   他在向阿莉森特暗示雷妮拉那一晚的私情，但用了宫廷里能装糊涂的措辞。
   一旦阿莉森特消化清楚'茶'指的是什么，她就被默认参与了这场政治流言。"

例 2：用户问"Laenor 在说什么"（餐桌上"我更喜欢烤鸭"那场）
→ "Laenor 用'喜欢烤鸭还是烤鹅'委婉出柜。
   维多利亚到中世纪欧洲贵族用食物隐喻指性偏好的传统在这里被复刻——
   'goose'对应他的真实取向，'duck'是他必须履行的婚姻义务。
   雷妮拉听懂了，没戳破，反过来用同一种委婉语回应他。"

例 3：用户问"Rhaenyra 为什么那么狠"（"我就是王冠"那场）
→ "她这一句不是耍嘴皮——是把 Criston 提议的'为爱不为王冠'那条路当场堵死。
   不是在拒绝爱情，是在拒绝'自己可以不是王冠'这个前提。
   从这一刻起 Criston 从骑士变成怨夫——绿党后续最锋利的那把剑，种子就在这里。"

例 4：用户问"韦赛里斯刚才那段独白什么意思"
→ "Paddy Considine 整季演技顶点。
   一个自知不配伟大、却仍想被记住的国王，用'作不成传唱百年的歌'概括自己一生。
   最辛辣的是：他死后爆发的'龙之舞'内战，恰恰会成为传唱百年的史诗——
   也就是观众正在看的这部剧。"
```

### 8.4 实施细节

- **插入位置**：现有 prompt 第 1424 行 `═══ 回答重点 ═══` 段落 **之后**、第 1425 行 `═══ 解读角度（按需融入，不强行）═══` 段落 **之前**。
- **不改其他文本**——六个角度、判断标准、风格示例、维斯特洛口吻段全部保留。
- **不改回答档位**（oneline / brief / deep 三档逻辑保留）。
- **不改模型路由**（`vision_chat` 仍走 Gemini 2.5 Flash + thinking）。

### 8.5 验收

参见第 6 节测试 #4。重点观察：
- brief 档回答里"第二层"的命中率提升了没（人工评估 10 个样本就够）
- 没有第二层的普通场景，模型有没有硬挖出假的"反讽"（这是 prompt 加这种指令最常见的副作用——要警惕）

如果 brief 档明显改善但 deep 档仍然只是堆砌六个角度的解读，再立项做模型升级。

---

## 附录 A：demo 4 张卡最终清单

| 序号 | riff_id | 时间 | 关键词 | 类型 |
|---|---|---|---|---|
| ① | `moon_tea_innuendo_e05` | 11:30 → 11:38 | `tea` | 隐喻 / 暗指 |
| ③ | `duck_to_goose_e05` | 18:18 → 18:28 | `goose` | 双关 / 时代委婉语 |
| ④ | `i_am_the_crown_e05` | 25:30 → 25:43 | `the crown` | 转喻 / 身份宣告 |
| F | `good_song_in_a_hundred_years_e05` | 34:44 → 34:55 | `a good song` | 经典台词 / 戏剧反讽 / 演员高光 |

完整内容（subtitle_en/zh、tier2_punch、tier3）见 `server/kb/dialogue_riffs/house-of-the-dragon.json`。
