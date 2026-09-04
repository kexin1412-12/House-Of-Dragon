# 龙之家族 · 多模态长视频理解系统 技术报告（详细版）

## 一、项目定位与核心挑战

这是一个面向 HBO《龙之家族》的**多模态长视频实时伴看系统**。用户在观看视频时，系统根据当前播放时间点（cursor），结合画面帧、字幕、知识库、人物关系和检索结果，实时回答用户的剧情问题——同时严格防止剧透。

**核心矛盾**：长视频中不同类型问题需要截然不同的证据获取策略。"这是谁"只需要当前帧 + 角色字典；"他们什么关系"需要跨集的关系时间线；"这集讲什么"需要全集范围的剧情摘要；"32:15 发生了什么"需要精确时间定位。一个固定的检索管线无法同时最优地服务所有类型。

**名词约定**（本报告中反复出现的术语）：

| 术语 | 含义 |
|------|------|
| **cursor** | 用户当前播放到的时间点（秒数）。所有检索、人物状态查询、剧透过滤都以它为锚点 |
| **RAG** | Retrieval-Augmented Generation（检索增强生成）。先从知识库里检索相关内容，把它作为上下文喂给 LLM 来生成回答，而不是让模型全靠训练数据中的记忆回答 |
| **LLM** | Large Language Model（大语言模型），如 GPT-4o、Gemini Flash。能理解和生成自然语言文本 |
| **VLM** | Vision-Language Model（视觉语言模型），如 Gemini Flash/Pro。除了文本，还能理解图像/视频帧 |
| **token** | LLM 处理文本的最小单位，大约 1 个中文字 ≈ 1-2 个 token。模型的输入输出都按 token 计费和限长 |
| **embedding** | 把文本映射成一个固定长度的数字向量（例如 1536 维）。语义相近的文本在向量空间中距离近，语义无关的距离远 |
| **prompt** | 给 LLM 的指令和上下文文本。System prompt 是全局设定（角色、规则），User prompt 是每次请求的具体内容 |
| **知识块（chunk）** | 知识库被切分成的最小检索单元。每个 chunk 是一段独立的知识条目（一条角色状态、一段场景解读等） |
| **召回（recall）** | 检索系统找到的相关结果数量占所有真正相关结果的比例。recall@8=85% 表示系统在 top-8 结果里找到了 85% 的标注答案 |

---

## 二、系统架构总览

```
用户提问 + 当前播放时间(cursor) + 画面截图(可选) + sessionId
          ↓
    ┌─────────────────┐
    │  Intent Router   │  detectIntents() → 7 类意图
    │  (正则分类器)     │  shot / plot / character / location / foreshadow / emotion / navigation
    └────────┬────────┘
             ↓
    ┌─────────────────┐
    │  Tool Bundle     │  按意图组装上下文 + 读取 Working Memory（上轮已验证的证据）
    │  (上下文编排)     │
    └────────┬────────┘
             ↓
    ┌─────────────────────────────────────── Agent Loop（最多 3 轮）───┐
    │                                                                  │
    │   ┌─────────────────┐                                            │
    │   │  Retrieve        │  混合检索（排除 Working Memory 已有的知识块） │
    │   │  (混合检索)       │                                            │
    │   └────────┬────────┘                                            │
    │            ↓                                                     │
    │   ┌─────────────────┐       ┌──────────────────┐                 │
    │   │  Evidence Gate   │──No──→│  补充检索          │──→ 回到 Retrieve│
    │   │  (证据充分吗？)   │       │  自动生成补充 query │                 │
    │   └────────┬────────┘       └──────────────────┘                 │
    │            │ Yes                                                  │
    │            ↓                                                     │
    │   ┌─────────────────┐                                            │
    │   │  Memorize        │  验证过的证据 + 人物 + 事件 → Working Memory │
    │   └────────┬────────┘                                            │
    └────────────┼─────────────────────────────────────────────────────┘
                 ↓
    ┌─────────────────┐
    │  LLM/VLM 生成    │  Gemini Flash(视觉+对话) / GPT-4o(推理+裁判) / Gemini Pro(人脸+深挖)
    │  (多模型路由)     │  分层 Prompt：角色设定 → 防剧透 → 证据优先级 → 权力潜台词 → 反废话
    └────────┬────────┘
             ↓
    ┌─────────────────┐
    │  后处理 + 质检    │  禁用词检测 / 短句堆检测 / 长度硬约束 / 身份保守原则
    └─────────────────┘
             ↓
        SSE 流式回答给用户
```

整个请求分两条路径：
- **有画面截图**（visualMode=true）：走 `vision_chat` 或 `vision_chat_deep` 任务，使用 VLM（Gemini），输入包含连续帧图像 + 角色字典 + 检索知识 + 场景切片
- **纯文本**（visualMode=false）：走 `chat` 任务，使用纯文本 LLM（GPT-4o-mini），输入只有 KB context JSON + 用户问题

---

## 三、意图路由系统（Intent Router）

### 3.1 意图检测：detectIntents()

系统收到用户问题后，第一步是用**正则表达式**判断问题属于哪些意图类别。这不是 LLM 分类（太慢、不确定），而是确定性的关键词匹配：

```javascript
function detectIntents(question) {
  const q = String(question || '');
  return {
    shot:      /镜头|构图|景别|运镜|光线|画面|色调|剪辑|特写|远景|空镜|俯拍|仰拍|低角度|高角度/.test(q),
    plot:      /发生了什么|剧情|没看懂|这段|前面|刚才|讲什么|什么意思/.test(q),
    character: /为什么|动机|沉默|表情|情绪|心情|想法|人物|角色|他|她/.test(q),
    location:  /这是哪|这里是哪|在哪|哪里|地点|地理|地图|城堡|城市|海峡|岛上|区域/.test(q),
    foreshadow:/伏笔|细节|彩蛋|铺垫|暗示|留意|重要吗|有什么用/.test(q),
    emotion:   /紧张|压抑|恐惧|悲伤|爽|震撼|节奏|高潮|反转/.test(q),
    navigation:/只看|跳到|整理|回顾|时间线|人物线|线索线|重排/.test(q),
  };
}
```

**为什么用正则而不是 LLM 分类？** 三个原因：
1. **延迟**：意图检测在请求的第一步，用 LLM 会加 0.5-1 秒延迟，对实时伴看体验致命
2. **确定性**：正则的结果 100% 可预测，不会因为 LLM 的随机性导致同一个问题有时走对路径有时走错
3. **成本**：每次提问都要分类，用 LLM 会额外消耗 token

**一个问题可以同时命中多个意图**。例如"她为什么沉默"会同时命中 `character`（"为什么""她"）和 `emotion`（可能不命中，除非包含"紧张"等词）。系统会返回所有命中的意图标记。

### 3.2 主意图推断：inferPrimaryIntent()

多个意图命中时，需要选出一个**主意图**来决定核心行为。优先级排序是硬编码的：

```javascript
function inferPrimaryIntent(intents) {
  if (intents.shot)       return 'shot';       // 最高优先：镜头语言问题
  if (intents.foreshadow) return 'foreshadow'; // 伏笔问题
  if (intents.location)   return 'location';   // 地点问题
  if (intents.character)  return 'character';   // 人物问题
  if (intents.navigation) return 'navigation'; // 导航/回顾
  if (intents.emotion)    return 'emotion';     // 情绪问题
  return 'plot';                               // 默认：剧情理解
}
```

**为什么 shot 优先级最高？** 因为用户如果明确问了"镜头""构图"，说明他想要的是视听语言分析，不是剧情解读。如果把 character 放在 shot 前面，"他为什么用这个镜头构图"会被当成人物问题处理。

**为什么 plot 是默认？** 大多数用户提问（"刚才发生了什么""这段什么意思"）本质上都是想理解剧情，plot 覆盖面最广。

### 3.3 上下文编排：buildToolBundle()

确定意图后，系统**按需组装**上下文数据包（Tool Bundle）。不是把所有数据都塞给 LLM，而是只加载问题需要的部分——这直接影响 token 消耗和回答质量：

```javascript
function buildToolBundle(kb, t, question) {
  const intents = detectIntents(question);
  const mentionedLocations = getMentionedLocations(kb, question);  // 文本提到的地点
  if (mentionedLocations.length) intents.location = true;          // 地点名触发 location 意图
  const primary = inferPrimaryIntent(intents);

  return {
    primary,
    intents,
    shot:       intents.shot || primary === 'plot' ? getShotAnalysis(kb, t) : null,
    plot:       getPlotContext(kb, t),            // 始终加载：12 段最近场景的剧情事实
    foreshadow: intents.foreshadow ? getForeshadowContext(kb, t) : null,
    characters: intents.character ? getCharacterState(kb, t) : null,
    location:   intents.location ? getLocationState(kb, t) : null,
    location_matches: intents.location ? mentionedLocations : [],
    emotion:    intents.emotion || intents.shot ? getEmotionState(kb, t) : null,
    navigation: intents.navigation ? getNavigationContext(kb, t, question) : null,
  };
}
```

**每个意图触发的具体数据加载**：

| 意图 | 加载的数据 | 数据来源 | 说明 |
|------|-----------|----------|------|
| **始终加载** | 最近 12 个场景的 plot.fact + plot.reading | scenesUpTo(kb, t).slice(-12) | 30-90 秒的剧情纵深，足够 LLM 理解"五分钟前刚发生了 X，所以现在 Y"。之前是 5 段，对 70 分钟视频太短，回答容易飘成百科介绍 |
| **shot** | 当前场景的 shot 分析（intent/emotion/framing） | scene.shot | 镜头的导演意图、情绪基调、构图方式 |
| **plot**（默认也加载 shot） | shot 分析 | 同上 | plot 问题也可能涉及镜头表达 |
| **character** | 当前场景在场角色的状态 | enrichCharacters(kb, scene.characters, t) | cursor-filtered 的角色身份、称号、立场 |
| **location** | 当前场景地点 + 文本提及的地点 | getLocationState(kb, t) + matchLocationsInText(db, question) | 地点数据库包含 HBO 官方地图标注 |
| **foreshadow** | 当前场景的伏笔 + 已回收伏笔的原始场景 | scene.foreshadow + sceneById(kb, payoff_id) | 只展示当前可见的线索，不揭示未来如何回收 |
| **emotion** | 叙事阶段、张力值、情绪基调 | scene.narrative + scene.shot | shot 意图也会触发 emotion（镜头分析需要情绪信息） |
| **navigation** | 过去所有场景的时间线 | scenesUpTo(kb, t) | 支持"回顾""整理""时间线"类问题。会根据问题细分：人物线/伏笔线/全剧回顾三种子模式 |

**navigation 的三种子模式**：

```javascript
function getNavigationContext(kb, t, question) {
  const pastScenes = scenesUpTo(kb, t);

  // 子模式 1：人物线 —— "只看雷妮拉的戏份"
  if (/人物线|只看.*(他|她|男主|女主|角色)/.test(question)) {
    return pastScenes.filter(s => s.characters?.length)
      .map(s => ({ scene_id, t, fact, characters: s.characters.map(c => c.id) }));
  }

  // 子模式 2：伏笔线 —— "整理一下前面的伏笔"
  if (/线索|伏笔|暗示/.test(question)) {
    return pastScenes.filter(s => s.foreshadow?.setup_hint || s.foreshadow?.is_payoff_of?.length)
      .map(s => ({ scene_id, t, fact, hint: s.foreshadow?.setup_hint }));
  }

  // 子模式 3：全剧回顾 —— "这一集讲了什么"
  return pastScenes.map(s => ({ scene_id, t, fact }));
}
```

**这个编排策略的核心思想**：LLM 的 context window 有限（即使 Gemini 有 1M token，过多无关信息也会稀释注意力），所以不是"给得越多越好"，而是"只给正确的东西"。意图路由器的作用就是在检索之前就过滤掉不需要的数据维度。

### 3.4 意图自适应检索量（Adaptive Retrieval K）

除了上下文编排，主意图还决定了**从 RAG 检索系统拉多少条知识块**：

```javascript
const RETRIEVAL_K_BY_INTENT = {
  navigation: 14,   // 回顾/时间线：证据分散在全集，需要宽召回
  plot:       10,   // 剧情理解：中等范围
  shot:        6,   // 镜头分析：证据高度局部
  location:    6,   // 地点问题：证据高度局部
  character:   6,   // 人物问题：证据较集中
  emotion:     6,   // 情绪问题：证据较集中
  foreshadow:  6,   // 伏笔问题：证据较集中
};
```

**为什么不统一用 8？** 不同类型问题的"证据密度"差异很大：
- "这集讲了什么" → 全集有几十个相关场景，K=6 会漏掉大量信息
- "这个镜头在暗示什么" → 只有当前场景和前后几秒相关，K=14 会塞入大量无关场景的知识块，稀释 LLM 对当前镜头的注意力

这个设计参考了 Route2Look（arXiv 2608.20805）的 query-adaptive evidence acquisition 思想。

---

## 四、知识库（KB）结构

### 4.1 目录结构

```
kb/
  videos/{videoId}/
    scene.json          ← 场景级 KB：每个场景的时间范围、剧情事实、镜头分析、伏笔、人物列表
    stance.json         ← 立场数据
    storyline.json      ← 故事线结构
    symbols.json        ← 符号/意象数据
    dialogue_riffs.json ← 对白分析

  characters/
    {showId}.json       ← 角色数据库：状态时间线、动机时间线、关系时间线
    {showId}.roleplay.json ← 角色扮演 profile（可选）
    face_refs/          ← 演员参考照片（视觉锚点）
    dragon_refs/        ← 龙的参考照片

  retrieval/
    {showId}.vectors.json  ← 预计算的向量索引：所有知识块 + 它们的 embedding 向量

  locations/
    {showId}.json       ← 地点数据库：城堡、城市、区域，含 HBO 官方地图标注

  episodes/
    {showId}.season-N.json ← 季度元数据：集数、剧情弧、阵营成员、因果链

  symbols/{showId}.json    ← 符号/意象字典
```

所有 KB 路径由 `lib/kb-paths.js` 统一管理，业务代码不允许手拼路径。

### 4.2 场景 KB（scene.json）

每个场景是一个时间段，核心字段：

| 字段 | 类型 | 示例 | 作用 |
|------|------|------|------|
| `scene_id` | string | "s01e05_sc12" | 唯一标识 |
| `start_time / end_time` | number | 1823.5 / 1901.2 | 场景起止秒数 |
| `plot.fact` | string | "韦赛里斯割伤了手指" | 事实层：这个场景发生了什么 |
| `plot.reading` | string | "铁王座拒绝不合格的统治者" | 解读层：这意味着什么 |
| `shot.intent` | string | "通过血滴特写暗示..." | 导演的镜头意图 |
| `shot.emotion` | string | "不安" | 镜头传达的情绪 |
| `shot.framing` | string | "中近景" | 景别/构图 |
| `shot.importance` | number | 0.85 | 镜头重要度（0-1） |
| `visual_beats[]` | array | [{start_time, meaning, identity_lock, ...}] | 逐秒视觉节拍 |
| `foreshadow.setup_hint` | string | "注意这把匕首，之前在..." | 当前可见的伏笔线索 |
| `foreshadow.is_payoff_of` | string[] | ["s01e02_sc05"] | 回收了哪些早期伏笔 |
| `characters[]` | array | [{id: "rhaenyra_targaryen", ...}] | 在场角色列表 |
| `characters_on_screen[]` | array | [{character_id, from_time, to_time}] | 带时间窗口的逐秒在场角色 |
| `narrative.phase` | string | "rising_action" | 叙事阶段 |
| `narrative.tension` | number | 0.7 | 张力值（0-1） |
| `narrative.importance` | number | 0.8 | 叙事重要度（0-1） |
| `tags[]` | string[] | ["权力博弈", "继承争议"] | 标签 |
| `tapestry_meta_reading` | string | "挂毯画面显示..." | 仅片头挂毯场景使用 |
| `episode_map[]` | array | [{from_scene, to_scene, episode}] | 场景到集数的映射 |

**visual_beats（逐秒视觉节拍）** 是精度最高的数据层。每个 beat 覆盖几秒的时间窗口，包含：
- `identity_lock`：逐帧核验过的人物身份锁定。如果存在，LLM 不能改认成其他角色
- `meaning`：这几秒画面的核心含义
- `aesthetic_reading`：美学解读
- `thematic_mirrors`：主题镜像

### 4.3 角色数据库的时间线设计

角色不是静态卡片，而是**带时间维度的状态机**。这是本系统区别于普通 wiki 的关键设计。

**状态时间线（state_timeline）**：

```json
{
  "character_id": "rhaenyra_targaryen",
  "display_name_zh": "雷妮拉·坦格利安",
  "canonical_name": "Rhaenyra Targaryen",
  "aliases": ["王国的快乐", "龙石岛女主"],
  "house": "坦格利安",
  "gender_zh": "女",
  "pronoun_zh": "她",
  "state_timeline": [
    {
      "from": "S01E01", "to": "S01E05",
      "title_zh": "王储",
      "political_role_zh": "铁王座继承人",
      "safe_summary_zh": "韦赛里斯的长女，被立为继承人..."
    },
    {
      "from": "S01E06", "to": null,
      "title_zh": "龙石岛女主",
      "political_role_zh": "远离宫廷的继承人",
      "safe_summary_zh": "..."
    }
  ]
}
```

**为什么需要时间线而不是静态卡片？** 雷妮拉在 S01E01 的身份是"公主"，S01E03 是"王储"，S01E06 是"龙石岛女主"。如果用静态卡片：
- 要么写最新状态 → 用户在 E01 就看到"龙石岛女主" → 剧透
- 要么写最早状态 → 用户在 E08 还看到"公主" → 过时

时间线设计让系统根据 cursor 精确返回"此刻的这个人是什么状态"。

**关系时间线（relationships）**：

```json
{
  "source": "rhaenyra_targaryen",
  "target": "alicent_hightower",
  "timeline": [
    { "from": "S01E01", "relation": "闺蜜", "relation_kind": "friendship",
      "summary_zh": "两人从小一起长大..." },
    { "from": "S01E05", "relation": "政敌", "relation_kind": "rivalry",
      "intensity_delta": -3,
      "summary_zh": "绿裙事件后关系公开决裂..." }
  ]
}
```

**动机时间线（motivations_timeline）**：

```json
{
  "from": "S01E04",
  "motivation_zh": "被王位忽视的渴望与嫉妒",
  "evidence_zh": "与雷妮拉的花街夜出事件后..."
}
```

### 4.4 KB 查询的 cursor 过滤逻辑

`lookupCharacter(db, characterId, cursor)` 查找角色当前状态：

1. 没有 cursor → 只返回 baseline 信息（名字、家族、标签），不返回任何状态
2. 有 cursor → 在 state_timeline 里找 `from ≤ cursor` 且 `to == null || cursor ≤ to` 的条目
3. 如果没有精确匹配 → fallback 到最后一条 `from ≤ cursor` 的条目

`lookupRelationships(db, characterId, cursor)` 查找关系，额外做**去重**：同一对角色（A↔B）可能有多条 timeline 条目（outgoing + incoming），只保留最新的。

---

## 五、混合检索系统（Hybrid Temporal RAG）详解

### 5.1 检索管线全流程

```
retrieve(params) 入口
     ↓
  ① 加载向量索引 (VECTOR_CACHE, 内存缓存)
     ↓
  ② 时序硬过滤 filterEligible(all, cursor)
     │  • show_id 匹配
     │  • video_id 匹配（除非 crossVideo=true）
     │  • season 不超过 cursor 季
     │  • episode 不超过 cursor 集
     │  • 同集内：available_from_time ≤ cursorTime
     │  • spoiler_level ≤ allowedSpoilerLevel
     ↓
  eligible chunks（安全池）
     ├──────────────────────────┐
     ↓                          ↓
  ③ rankLexical()            ④ rankDense()
     bigram 匹配               cosine 相似度
     + 角色名加分               text-embedding-3-small
     → top-40 IDs              → top-40 IDs
     ↓                          ↓
     └──────────┬───────────────┘
                ↓
  ⑤ RRF 融合 (k=60)
     两路排名 → 统一分数
                ↓
  ⑥ rerank() 上下文微调
     query排名主导 + 场景/角色/地点/时间小幅加分
                ↓
  ⑦ buildContext() 类型配额
     每类知识块最多 2-3 条
                ↓
     最终 K 条知识块返回
```

### 5.2 知识块（Chunk）的 5 种类型与切分方式

知识块由 `chunkers.js` 离线生成，每种类型的切分粒度和检索文本构造方式不同：

**A. 场景解读块（scene_reading）**

```
来源：scene.visual_beats[].{meaning, aesthetic_reading, thematic_mirrors}
ID 格式：{videoId}:scene:{sceneId}:{beatId}:reading
检索文本：beat 的含义 + 场景角色名
置信度：0.9
时间锚：beat.start_time 或 scene.start_time
```

**B. 角色状态块（character_state）**

```
来源：character.state_timeline[]
ID 格式：{showId}:char:{charId}:state:{i}
检索文本：title_zh + political_role_zh + safe_summary_zh + 角色全部名称/别名
置信度：默认
时间锚：state.from（比如 S01E03 开始可用）
```

**为什么检索文本要注入角色名称？** 用户可能用中文名（"雷妮拉"）、英文名（"Rhaenyra"）、别名（"王国的快乐"）或家族名（"坦格利安"）来提问。检索文本里注入所有变体，保证任何一种称呼都能被关键词检索命中。

**C. 角色动机块（character_motivation）**

```
来源：character.motivations_timeline[]
ID 格式：{showId}:char:{charId}:motivation:{i}
检索文本：motivation_zh + evidence_zh + 角色名称
```

**D. 关系块（character_relationship）**

```
来源：relationships[].timeline[]
ID 格式：{showId}:rel:{relIdx}:{timelineIdx}
检索文本：relation_zh + summary_zh + evidence_zh + 双方全部名称
置信度：默认
```

**为什么关系块要注入双方名称？** 用户问"雷妮拉和阿莉森特的关系"，检索文本必须同时包含两个人的名字才能被命中。

**E. 知识卡块（lore_card）**

```
来源：knowledge_points[]（世界观/历史设定）
ID 格式：{showId}:lore:{i}
检索文本：title + summary + safe_hint/expanded_explanation
置信度：kp.confidence 或 kp.importance（默认 0.6）
时间锚：S01E01（全剧通用）
```

**每个知识块还携带**：
- `content_hash`：内容的 SHA-1 哈希。知识库更新时，hash 变了的块会被标记为需要重新计算 embedding
- `embedding`：1536 维向量（text-embedding-3-small 模型生成）
- `embedding_model`：记录使用的模型，方便未来切换

### 5.3 时序硬过滤（第一层防剧透）

```javascript
function filterEligible(chunks, cursor) {
  // Fail-closed：没有 cursor → 只返回没有时间标记的 baseline 知识块
  if (!cursor) return chunks.filter(c => isBaseline(c));

  return chunks.filter(c => {
    // show_id 必须匹配
    if (c.show_id && c.show_id !== cursor.show_id) return false;
    // video_id 必须匹配（除非 crossVideo）
    if (!cursor.crossVideo && c.video_id && c.video_id !== cursor.video_id) return false;
    // 季不能超过
    if (c.season != null && c.season > cursor.season) return false;
    // 剧透等级不能超过
    if ((c.spoiler_level || 0) > (cursor.allowedSpoilerLevel || 0)) return false;
    // 集数不能超过
    if (c.available_from_episode && epToNum(c.available_from_episode) > epToNum(cursor.episode)) return false;
    // 同一集内：时间不能超过
    if (c.available_from_episode === cursor.episode &&
        c.available_from_time != null &&
        c.available_from_time > cursor.cursorTime) return false;
    return true;
  });
}
```

`epToNum()` 把 "S01E03" 转成数字 103，"S02E05" 转成 205，方便比较先后。

**Fail-closed**（安全术语）：系统在异常或信息不足时**默认拒绝**，而不是默认放行。类比：门禁系统断电时应该锁住（fail-closed），不是打开。这里表现为：没有 cursor 信息时，不返回任何有时间标记的知识块。

### 5.4 关键词检索（Lexical Retrieval）

```javascript
function rankLexical(chunks, { query, nameKeys }) {
  const qBigrams = bigrams(query);  // "权力斗争" → ["权力", "力斗", "斗争"]

  for (const chunk of eligible) {
    let score = 0;

    // Query bigram 匹配 — 主信号
    let hits = 0;
    for (const bg of qBigrams) {
      if (chunkText.includes(bg)) hits++;
    }
    score += Math.min(hits * 0.4, 8);   // 每命中一个 +0.4，封顶 8.0

    // 在场角色名匹配 — 辅助信号
    for (const name of nameKeys) {
      if (chunkCharacterIds.includes(name)) score += 1.5;  // 知识块属于在场角色
      else if (chunkText.includes(name)) score += 0.5;     // 知识块提及在场角色
    }
  }
}
```

**bigram（二元组）** 是中文文本最简单的切分方式：取每两个相邻字符作为一个单元。"权力斗争" → ["权力", "力斗", "斗争"]。

**为什么用 bigram 而不是中文分词器（如 jieba）？** jieba 等分词器依赖内置词典。《龙之家族》里大量专有名词（"坦格利安""瓦雷利亚""龙石岛""韦赛里斯"）都不在标准词典里，分词器会把它们错误切分。bigram 不依赖词典，对任何文本都有稳定的召回率。

**参数选择原因**：

| 参数 | 值 | 为什么 |
|------|-----|--------|
| 每个 bigram 命中 +0.4 | 0.4 | 太高时长 query 的关键词分数会爆炸（20 个 bigram 全命中 = 8.0），主导排名；太低时精确匹配的优势消失 |
| 封顶 8.0 | 8.0 | 防止长 query 的关键词分数无限增长 |
| 在场角色加分 +1.5 | 1.5 | **从 5.0 降下来的**。早期 +5.0 时，不管用户问什么，只要角色在场，就返回该角色的百科卡片——query 本身的排名被角色加分淹没。降到 1.5 后，角色只在 query 相关性接近的候选之间起辅助区分 |
| 角色提及加分 +0.5 | 0.5 | 比在场角色弱，只是一个微弱的相关性信号 |

### 5.5 向量检索（Dense Retrieval）

使用 OpenAI `text-embedding-3-small` 模型将 query 和知识块都转化为 1536 维向量，计算**余弦相似度**：

$$\text{cosine}(a, b) = \frac{\sum_{i=1}^{n} a_i b_i}{\sqrt{\sum_{i=1}^{n} a_i^2} \times \sqrt{\sum_{i=1}^{n} b_i^2}}$$

值域 [-1, 1]。1 = 向量完全同向（语义完全一致），0 = 正交（无关），-1 = 完全反向。

**为什么选 text-embedding-3-small 而不是 3-large？** 3-large 维度更高（3072 vs 1536），理论上语义区分度更好，但实测 MRR（Mean Reciprocal Rank，衡量第一个正确结果排多高）提升不足以 justify 2× 的存储和计算成本。对于本项目的知识块规模（~几百条），small 已经够用。

**缓存机制**：
- **向量索引缓存**（VECTOR_CACHE）：整个 vectors.json 文件读一次后驻留内存，后续请求不再读磁盘
- **Query embedding 缓存**（QUERY_EMBED_CACHE）：key = `{model}:{sha1(query_text)}`，同一个问题不重复调 OpenAI API

**静默降级**：如果 `OPENAI_API_KEY` 没配或 API 调用失败，系统自动退化为纯关键词检索（跳过向量检索），不报错、不中断。这在评测时需要特别注意——如果 eval 脚本不预先缓存 embedding，密集调用可能触发限流，导致部分问题只用关键词检索，分数不可复现。因此评测脚本专门有一个 `prewarmEmbeddings()` 步骤。

### 5.6 排名融合（RRF）

两路检索各返回 top-40 候选 ID，用 **Reciprocal Rank Fusion** 合并：

```javascript
function rrf(rankedLists, k = 60) {
  for (const list of rankedLists) {
    list.forEach((id, i) => {
      scores[id] += 1 / (k + i + 1);   // 排名从 1 开始
    });
  }
  return sorted by score descending;
}
```

**计算示例**：

```
假设文档 A 在关键词检索排第 1，在向量检索排第 3：
  关键词贡献 = 1/(60+1) = 0.01639
  向量贡献   = 1/(60+3) = 0.01587
  总分 = 0.03226

假设文档 B 只在向量检索排第 1，关键词没命中：
  向量贡献 = 1/(60+1) = 0.01639
  总分 = 0.01639

文档 A 总分更高 → 排在 B 前面
```

**为什么 k=60？** 这是 RRF 论文（Cormack et al., 2009）推荐的标准值。k 越大，排名差异对最终分数的影响越小（更"平滑"）；k 越小，排名差异的影响越大。60 在实践中对大多数融合场景效果稳定。

**为什么用 RRF 而不是简单的分数加权？** 两路检索的分数尺度完全不同——关键词的分数是 0~8 的整数倍，向量相似度是 0~1 的浮点数。如果直接加权（如 `0.5 * keyword_score + 0.5 * cosine_score`），需要先做归一化，而归一化方式的选择本身就是一个需要调的超参数。RRF 只看排名不看分数，天然避开了这个问题。

### 5.7 上下文感知重排（Context-aware Reranking）

RRF 之后，叠加一个**小幅度**的上下文加分，让当前场景、在场角色等信息微调排名：

```javascript
function rerank(chunks, ctx) {
  return chunks.map((c, i) => ({
    c,
    s: (n - i)                    // 主信号：query 相关性排名（n=总数, i=位置）
       + contextScore(c, ctx)     // 辅助信号：上下文加分（bounded, 最大 ~2.9）
  })).sort(descending);
}
```

**上下文加分的详细分解**：

| 信号 | 加分 | 条件 | 设计原因 |
|------|------|------|----------|
| 同一场景 | +0.8 | chunk.scene_id === cursor 所在 scene | 最强上下文信号：当前场景的知识块最可能相关 |
| 在场角色匹配 | +0.6 | chunk 的 character_ids 包含当前画面角色 | 次强信号：涉及当前在场角色的知识块更相关 |
| 地点匹配 | +0.3 | chunk 的 location_ids 包含当前场景地点 | 较弱信号 |
| 符号匹配 | +0.3 | chunk 的 symbol_ids 包含当前场景符号 | 较弱信号 |
| 时间邻近度 | +0.2 max | `0.2 × max(0, 1 - |cursorTime - chunkTime| / 3600)` | 1 小时内满分，渐衰到 0 |
| 意图-类型匹配 | +0.6 max | 如 character 意图 + character_motivation 块 = 3 × 0.2 | 意图与知识块类型的契合度 |
| 置信度 | +0.1 max | `chunk.confidence × 0.1` | 最弱信号：知识块自身的置信度 |

**意图-类型匹配的详细配置**：

```javascript
const INTENT_TYPE_BONUS = {
  character: {
    character_motivation: 3,      // × 0.2 = +0.6
    character_relationship: 2.5,  // × 0.2 = +0.5
    scene_reading: 1,             // × 0.2 = +0.2
  },
  shot: {
    scene_shot: 3,                // × 0.2 = +0.6
    symbol_occurrence: 2,         // × 0.2 = +0.4
    symbol_definition: 1,         // × 0.2 = +0.2
  },
  fact: {
    scene_fact: 3,                // × 0.2 = +0.6
    subtitle_window: 2,           // × 0.2 = +0.4
  },
};
```

**关键设计约束：上下文加分必须远小于 query 排名差距。**

相邻 query 排名的差距 = 1.0（因为主信号是 `n - i`，相邻位置差 1）。上下文加分总上限 ~2.9，最多能把一个知识块提升 2-3 个排名位置。这意味着如果一个知识块在 query 相关性上排第 10，它不可能凭上下文加分跳到第 1。

**这个约束为什么重要？** 早期版本的 reranker **只用上下文打分、完全丢弃了 query 排名**。结果是不管用户问"这是谁""他们什么关系""这个镜头在暗示什么"，只要 cursor 在同一个位置，返回的知识块几乎一模一样——因为排名完全由"在场角色""当前场景"决定，跟问题内容无关。这是本项目踩过的最大的检索坑。

### 5.8 类型配额（Anti-flood）

重排之后，最后一层过滤——防止 top-K 被单一类型的知识块垄断：

```javascript
const DEFAULT_QUOTAS = {
  scene_reading: 3,
  character_state: 2,
  character_relationship: 2,
  character_motivation: 2,
  lore_card: 2,
  external_knowledge: 2,
};
```

算法简单：按重排后的顺序遍历，每个知识块检查其类型的配额是否已满，未满则加入结果，已满则跳过，直到收集够 K 条。

**配额从 1 提升到 2-3 的原因**：配额=1 时，如果用户问一个角色相关的问题，唯一的 `character_state` 槽可能被在场角色（但不是问题主角）的状态块占据，导致真正相关的角色状态被配额挡掉。

---

## 六、Agent Loop：从 Workflow 到 Conversational Agent

### 6.1 架构演进动机

**之前（Workflow 模式）**：每次用户提问 → 固定管线（意图分类 → 检索 K 条 → 生成回答）→ 完毕。下一次提问从零开始，不复用上一轮已经找到的证据。

这有两个问题：

| 问题 | 具体表现 |
|------|----------|
| **无会话记忆** | 用户先问"Daemon 为什么离开君临"，系统找到 E01-E02 的证据；紧接着问"这对他和 Viserys 的关系有什么影响"，系统又从头检索，可能找到完全不同的片段，丢失了上一轮已验证的因果链 |
| **证据不足不补** | 用户问"为什么 Alicent 后来敌视 Rhaenyra"，检索到绿裙事件（结果），但缺少前因（花街夜出事件 → 信任破裂）。系统不会判断"因果链不完整"，直接用不充分的证据生成回答 |

**现在（Agent Loop 模式）**：检索不再是一次性动作，而是一个**自主循环**——检索 → 判断证据够不够 → 不够就自动补充检索 → 够了才回答。同时跨轮复用已验证的证据。

这个设计参考了 Route2Look（arXiv 2608.20805）论文的 **Memorize**（Working Memory）和 **Continue-or-Stop**（Evidence Sufficiency Gate）机制。

### 6.2 Working Memory（会话记忆）

**实现**：服务端内存 `Map<sessionId, WorkingMemory>`，前端每次挂载生成一个 UUID 作为 `sessionId`，随请求发送。

```javascript
// 每个 session 的 Working Memory 结构
{
  sessionId: 'a1b2c3d4-...',
  videoId: 'hotd-s1e5',
  lastActiveAt: 1725436800000,

  // 已验证的知识块（下一轮检索时跳过这些 ID，不重复拉取）
  verified_evidence: [
    { id: 'hotd:char:daemon:state:2', summary: 'Daemon 被驱逐离开君临', round: 1 },
    { id: 'hotd:rel:3:1', summary: 'Daemon-Viserys 兄弟关系紧张', round: 2 },
  ],

  // 已确认的人物（跨轮复用身份判定结果）
  identified_characters: ['daemon_targaryen', 'viserys_targaryen'],

  // 已定位的事件（跨轮复用事件锚点）
  resolved_events: ['s01e01_sc08_daemon_expelled'],

  // 本轮提取的实体（用于下一轮补充检索的 query 构造）
  conversation_entities: ['Daemon', '君临', '驱逐'],
}
```

**关键设计决策**：

| 决策 | 原因 |
|------|------|
| TTL 10 分钟自动过期 | 用户可能切换视频或长时间离开，过期的记忆不应该干扰新的对话。10 分钟覆盖了"连续追剧"的典型窗口 |
| 切换 videoId 时清空 | 不同视频的知识块 ID 不兼容，保留会导致 excludeIds 过滤掉不该过滤的块 |
| 上限 40 条 evidence | 防止长对话积累过多记忆，导致 excludeIds 集合太大影响检索覆盖率 |
| 存服务端内存而非 Redis | 单实例部署，不需要分布式存储。内存 Map 读写 <1μs，零依赖 |

**多轮对话的实际效果**：

```
用户问①："Daemon 为什么离开 King's Landing？"
  → 第 1 轮检索：找到 6 条证据（Daemon 被驱逐、与 Viserys 冲突）
  → 存入 Working Memory：verified_evidence=[6 条], identified_characters=[daemon, viserys]
  → 回答

用户问②："这对他和 Viserys 的关系有什么影响？"
  → Working Memory 已有 6 条证据 → excludeIds 排除它们
  → 第 1 轮检索：只检索关系变化相关的 新 知识块（不重复拉已有的）
  → 合并：Working Memory 的 6 条 + 新检索的 3 条 = 9 条
  → 回答时上下文更完整，且省了重复检索的 token 消耗
```

### 6.3 Evidence Gate（证据充分性判断）

**实现**：每次检索后，用一个轻量 LLM 调用（GPT-4o-mini，maxTokens=200，temperature=0）判断 4 个维度：

```javascript
// Evidence Gate 的输出（JSON）
{
  "sufficient": false,                              // 总判断
  "character_identified": true,                      // 问题涉及的人物是否在证据中出现
  "event_identified": true,                          // 事件是否有具体描述
  "causal_evidence": false,                          // 因果链是否完整
  "temporal_grounded": true,                         // 时间/顺序是否清楚
  "missing": "缺少 Alicent 从闺蜜变敌人的前因事件",    // 一句话描述缺什么
  "supplementary_query": "Alicent Rhaenyra 花街 欺骗 信任破裂"  // 自动生成的补充检索 query
}
```

**只对 3 种意图启用**：`character` / `plot` / `foreshadow`。其他意图（`shot` / `location` / `emotion` / `navigation`）的证据天然局部集中，不需要多轮补充。

**具体流程举例**：

```
用户问："为什么 Alicent 后来开始敌视 Rhaenyra？"
主意图：character

第 1 轮检索（K=6）→ 找到：
  [1] 绿裙事件 S01E05（事件证据 ✓）
  [2] Alicent 状态：王后（人物 ✓）
  [3] Alicent-Rhaenyra 关系：政敌（关系 ✓）

Evidence Gate 判断：
  character_identified: ✓（Alicent 在证据中）
  event_identified: ✓（绿裙事件）
  causal_evidence: ✗（只有"敌视"的结果，没有"为什么"的前因）
  temporal_grounded: ✓
  → sufficient: false
  → supplementary_query: "Rhaenyra Alicent 花街夜出 欺骗 信任破裂"

第 2 轮补充检索（K=3，排除已有 3 条）→ 找到：
  [4] S01E04 花街夜出事件
  [5] Rhaenyra 向 Alicent 撒谎
  [6] Alicent 动机：被欺骗后的愤怒

Evidence Gate 判断：
  causal_evidence: ✓（有前因了）
  → sufficient: true → 停止，进入生成阶段

最终上下文：6 条证据（事件 + 前因 + 人物状态 + 关系），因果链完整
```

### 6.4 Agent Loop 完整流程

```javascript
// 简化后的核心逻辑
const wm = workingMemory.getOrCreate(sessionId, videoId);
const seenIds = workingMemory.getVerifiedIds(sessionId);  // 上一轮已有的

let retrievedKnowledge = [];
let agentRound = 0;
let supplementaryQuery = null;

while (agentRound < 3) {                           // 最多 3 轮（1 初始 + 2 补充）
  agentRound++;

  const query = supplementaryQuery || question;     // 第 1 轮用原始问题，后续用补充 query
  const k = agentRound === 1
    ? retrievalKForIntent(primaryIntent)            // 第 1 轮：按意图给 K
    : Math.ceil(retrievalKForIntent(primaryIntent) / 2);  // 补充轮：K 减半

  const newEvidence = await retrieve({
    query,
    k,
    excludeIds: seenIds,                            // 排除已验证的知识块
    cursor, currentScene, characterNames, ...
  });

  retrievedKnowledge.push(...newEvidence);
  for (const e of newEvidence) seenIds.add(e.id);

  // 不需要多轮的意图 → 直接跳出
  if (!shouldGate(primaryIntent, agentRound)) break;

  // Evidence Gate 判断
  const gate = await assessEvidence(question, retrievedKnowledge, primaryIntent, ai);
  if (gate.sufficient) break;

  supplementaryQuery = gate.supplementary_query;
  send('thinking', { round: agentRound, missing: gate.missing });  // 通知前端"在补充检索"
}

// 存入 Working Memory
workingMemory.memorize(sessionId, {
  evidence: retrievedKnowledge.map(e => ({ id: e.id, summary: e.content?.slice(0,80) })),
  characters: [...sceneCharIds],
  events: scene ? [scene.scene_id] : [],
});
```

### 6.5 延迟与成本分析

| 路径 | 延迟 | 额外成本 |
|------|------|----------|
| 第 1 轮即通过（shot/location/emotion 意图） | +0ms | +0 |
| 第 1 轮即通过（character/plot/foreshadow，证据充分） | +~200ms（Evidence Gate 调用） | +~100 token（GPT-4o-mini） |
| 需要 1 次补充检索 | +~500ms（Gate + 补充检索） | +~200 token |
| 需要 2 次补充检索（最大） | +~800ms（2×Gate + 2×补充检索） | +~300 token |

**大多数请求（>80%）在第 1 轮就通过**——只有"为什么""怎么变成这样的"这类需要因果链的追问才会触发补充检索。

### 6.6 Workflow vs Agent 的本质区别

| 维度 | Workflow（之前） | Agent Loop（现在） |
|------|------------------|-------------------|
| 检索轮数 | 固定 1 轮 | 自适应 1-3 轮 |
| 跨轮记忆 | 无（每次请求独立） | 有（Working Memory 跨轮复用） |
| 证据判断 | 不判断，检索多少给多少 | 自主判断是否充分，不足则补 |
| 补充检索 | 不会 | 自动生成补充 query，换角度再检索 |
| 前端感知 | 无 | SSE `thinking` 事件通知"正在补充检索" |
| 系统定位 | Video QA System | Long-video Conversational Agent |

---

## 七、多模型路由系统（AI Router）

### 6.1 路由表

系统不使用单一模型，而是按**任务类型**路由到最合适的模型。路由表在 `lib/ai/router.js`：

| 任务 | 主模型 | 降级模型 | 选型原因 |
|------|--------|----------|----------|
| `vision`（单帧画面理解） | **Gemini 2.5 Flash** | GPT-4o | Flash 多模态能力强 + 长上下文（1M token）+ 响应快（~1s）+ 中文好 |
| `face_recognition`（人脸识别） | **Gemini 3.1 Pro Preview** | GPT-4o | 身份判定要的是**准确率不是延迟**。Pro 的视觉推理能力显著强于 Flash，对相似外貌角色（都是银发坦格利安）的区分度更高 |
| `vision_chat`（多模态实时对话） | **Gemini 2.5 Flash** | GPT-4o | **生产主力**。用户问答是实时场景，延迟优先于精度。Flash 的中文文学性好于 GPT-4o（写出来的解读更像"懂行剧友"而不是"AI 百科"） |
| `vision_chat_deep`（深挖模式） | **Gemini 3.1 Pro Preview** | GPT-4o | 用户明确选择"深挖"时才触发。复杂的身份排除（多个相似角色）、历史检索、符号推理需要 Pro 的推理深度。**每日 250 次配额限制** |
| `chat`（纯文本剧情问答） | **GPT-4o-mini** | — | 没有画面时退化为纯文本 QA，mini 足够且便宜 |
| `dialogue`（角色对谈/内心独白） | **Gemini 2.5 Flash** | GPT-4o | 角色对谈要求中文文学性（模仿马丁笔触），Gemini 的中文写作显著优于 GPT-4o |
| `reasoning`（离线推理/评测裁判） | **GPT-4o** | — | 评测裁判**必须**用与生成模型不同厂商的模型（跨家族裁判），避免"自己判自己"的偏差 |
| `agent_analysis`（多轮工具调用分析） | **GPT-4o** | — | 当前只有 OpenAI 实现了 chatWithTools（带工具调用的多轮对话）；不能降级到 Gemini |
| `book_extraction`（原著长文本抽取） | **Gemini 2.5 Flash** | GPT-4o | 需要 1M context window 一次塞下整本书 |
| `character_profile`（人物档案生成） | **Gemini 2.5 Flash** | GPT-4o-mini | 中文文学性 + 温和输出（~600-900 token） |
| `perspective`（平行视角 HUD 卡片） | **Gemini 2.5 Flash** | GPT-4o-mini | 极短卡片（3 张），Flash 够用 |
| `transcription`（语音转文本） | **Whisper-1** | — | OpenAI 专用模型 |

### 6.2 降级机制

```javascript
function _resolve(task) {
  const cfg = TASK_CONFIG[task];
  let provider = PROVIDERS[cfg.provider];

  // 主 provider 没配 key → 降级到 fallback
  if (!provider || !provider.isAvailable()) {
    if (cfg.fallback && PROVIDERS[cfg.fallback]?.isAvailable()) {
      provider = PROVIDERS[cfg.fallback];
      model = cfg.fallbackModel || model;
    }
  }
}
```

**降级是自动的、对业务代码透明的**。比如如果没配 `GOOGLE_AI_KEY`，所有 Gemini 任务会自动切到 GPT-4o，业务代码不需要任何改动。

### 6.3 生成参数的详细设计

流式对话端点（`/api/agent/chat/stream`）中：

```javascript
const task = visualMode
  ? (depth === 'deep' ? 'vision_chat_deep' : 'vision_chat')
  : 'chat';

const maxTokens = depth === 'deep' ? 1800 : (depth === 'oneline' ? 60 : 700);
const temperature = visualMode ? 0.7 : 0.4;
```

| 参数 | 视觉模式 | 纯文本模式 | 原因 |
|------|----------|-----------|------|
| 温度 | 0.7 | 0.4 | 视觉理解需要更多"创造性"来描述画面和解读象征；纯文本更依赖 KB 事实，需要更确定性的输出 |
| maxTokens (oneline) | 60 | 60 | 一句话 ≤28 中文字 ≈ 40-56 token + 少量余量 |
| maxTokens (brief) | 700 | 700 | 160-240 字 ≈ 240-480 token + 标签和格式余量 |
| maxTokens (deep) | 1800 | 1800 | 220-340 字解读 + 可能包含多层标注 + 文学化表达需要更多空间 |

### 6.4 三层生成降级

当 LLM 调用失败时，系统有三层降级保证用户一定能收到回答：

```
① 首选任务（如 vision_chat_deep）
     ↓ 失败且还没输出过文本
② 降级任务（vision_chat）
     ↓ 也失败
③ 模板回答（generateTemplate / generateVisualFallback）
     ← 纯代码逻辑，不依赖任何 API
```

模板回答根据意图生成：

```javascript
function generateTemplate(context, question) {
  // 优先：逐秒视觉节拍（如果有 identity_lock 等逐帧标注）
  if (scene.timed_visual_beat) return 拼接 people + event + meaning;

  // shot 意图 + 有 shot 数据
  if (primary === 'shot' && scene.shot?.intent)
    return `这个镜头主要在表达${scene.shot.emotion}。${scene.shot.intent}`;

  // foreshadow 意图
  if (primary === 'foreshadow' && scene.foreshadow_setup_hint)
    return `${hint} 这里先留意就好，暂时不展开。`;

  // location 意图
  if (primary === 'location')
    return `${location.display_name}，位于${location.region}。${location.summary}`;

  // character 意图
  if (primary === 'character')
    return `${c.id}现在的状态是${c.emotion}，${c.motivation_shift}。`;

  // 兜底
  return scene.plot_reading || scene.plot_fact || '这段更像是叙事过渡。';
}
```

### 6.5 人脸识别的模型迁移决策

**ArcFace（传统闭集方案）→ Gemini Pro（多模态 VLM 方案）**

| 指标 | ArcFace | Gemini Pro |
|------|---------|------------|
| 识别率（53 帧测试集） | 7.5%（4/53） | 显著提升 |
| 失败原因 | 演员跨季换人；妆造变化大；暗光/侧脸/远景；gallery 向量不可分 | — |
| 调用方式 | 本地推理，需维护向量库 | API 调用，无需本地模型 |
| 每日配额 | 无限 | 250 次/天（Pro Preview） |
| 延迟 | ~50ms | ~2-3s |
| 成本 | 免费（本地） | 按 token 计费 |

**为什么接受 Pro 的高成本和配额限制？** 识别率从 7.5% 提升到可用水平的价值远大于成本增加。识别不了 = 功能等于没有。

**识别流程**：
1. 将画面帧以 base64 图像发给 Gemini Pro
2. 同时发送 cursor-filtered 的角色字典（名字、别名、外貌特征）
3. 要求模型以 JSON 格式返回识别结果
4. 置信度 < 0.75 的结果丢弃
5. 对 bbox（边界框）重叠 > 0.5 的结果做去重

---

## 八、Prompt 工程详解

### 7.1 分层 Prompt 架构

System prompt 不是一个大文本，而是**模块化拼接**。不同场景（视觉分析 / 纯文本对话 / 角色内心独白）共享基础模块，再叠加专用层：

```
视觉模式 System Prompt:
  buildCompanionCorePrompt()          ← 6 个基础模块
    ├── COMPANION_ROLE                ← 角色设定
    ├── SPOILER_BOUNDARY              ← 防剧透规则
    ├── EVIDENCE_PRIORITY             ← 证据优先级
    ├── POWER_SUBTEXT                 ← 权力潜台词框架
    ├── COMPANION_STYLE               ← 语气风格
    └── ANTI_BLOAT_RULES              ← 反废话规则
  + IDENTITY_LAYER                    ← 人物身份识别规则
  + GROUNDING_LAYER                   ← 信息分级 + 身份门槛 7 条硬规则
  + ANALYSIS_LAYER                    ← 分析流程
  + LITERARY_LAYER                    ← 文学表达（仅 deep 模式激活）
  + STYLE_LAYER                       ← 输出风格约束
  + buildAnswerSpec(depth)            ← 三档输出合约

对话模式 System Prompt:
  buildCompanionCorePrompt()          ← 同样的 6 个基础模块
  + DIALOGUE_RUNTIME_LAYER            ← 对话专用：长度硬约束 + 具体化要求 + mode 规则
  + buildAnswerSpec(depth)            ← 三档输出合约
```

### 7.2 六个基础模块详解

**① COMPANION_ROLE（角色设定）**

```
你是一位资深的《龙之家族》《权力的游戏》解读者，熟悉《冰与火之歌》的世界观、
家族规矩、血统秩序、宫廷体面与权力博弈，正在坐在用户旁边陪他一起追《龙之家族》
第一遍。

你的知识可以很深，但你的回答不是百科、人物小传或课堂讲解。你只帮助用户看懂
当前这一刻。

像懂行的剧友低声提醒：自然、克制、有判断力。
```

**为什么设定成"剧友"而不是"AI 助手"？** LLM 的默认行为是"尽可能全面地回答"，会写出百科全书式的长篇大论。设定成"坐在旁边的剧友"，暗示了：简短、口语化、只说当前相关的。

**② SPOILER_BOUNDARY（防剧透）**

```
绝对不剧透。只允许使用：
1. 当前图像、连续帧与同秒字幕。
2. previous_context 中当前时间以前已经发生的对白与剧情。
3. character_dictionary、on_screen_relations 和 retrieved_knowledge 中
   按当前 cursor 放行的信息。

禁止透露或暗示未来死亡、结局、阵营变化、婚姻、背叛、称号变化、关系揭晓
与原著后续。不能用"后面会""最终""其实""真相是""将来才知道"等措辞偷渡未来。
```

**③ EVIDENCE_PRIORITY（证据优先级）**

这个模块规定了当多个信息源冲突时该信谁：

```
身份识别优先级（从高到低）：
1. timed_visual_beat.identity_lock → 逐帧核验，最高权威
2. 当前图像 + 同秒字幕 + character_dictionary 交叉确认
3. identity_recovery_dictionary（本集角色恢复池）
4. 严禁单凭发色、衣服、气质猜身份

关系/动机解读优先级（从高到低）：
1. character_dictionary + on_screen_relations（cursor 已放行）
2. retrieved_knowledge（按 _score 谨慎使用）
3. previous_context（前文对白）
4. 当前画面（只作辅助，不能单独证明关系）
```

**为什么要把身份识别和关系解读的优先级分开？** 早期版本混在一起，导致"因为这个人物跟某角色有某种关系，所以他一定是某角色"的循环论证。分开后，必须先通过身份门槛，才能使用该角色的关系数据。

**④ POWER_SUBTEXT（权力潜台词）**

```
回答前先在内部判断两件事：表面意思是什么；有没有第二层。

优先抓这些权力动作：
- 试探、软威胁、逼人表态、装糊涂、示好、割席、递台阶、保留体面
- 谁掌握主动权，谁在忍气吞声
- 信息差：A 知道而 B 不知道什么

没有第二层就直说场面事实；不要为了显得专业硬挖象征。
```

**⑤ COMPANION_STYLE（语气风格）**

```
回答像随口说，但有判断力。
可以自然使用："这话听着客气，其实是在亮刀""这是宫廷里的软威胁"
禁止用这些开头："这段画面里""画面中""镜头里""结合上下文""据资料显示"
```

**⑥ ANTI_BLOAT_RULES（反废话）**

```
严禁空话句式：
- "不仅……更是……" / "既有……也有……"
- "与……形成鲜明对比" / "似乎在无声地诉说"

视觉描述剥离：不要重复用户肉眼可见的东西（泥泞、盔甲、帐篷）。

Lore-first：
每次回答必须有一个不可替换的具体名词或机制：
冬狼军、月亮茶、绿党、瓦列利安海权、铁王座割伤等。
没有具体机制，就短答，不要硬扩写。
```

### 7.3 视觉模式的 5 个专用层

**GROUNDING_LAYER（信息分级 + 身份门槛 7 条硬规则）**

这是 prompt 中最长、最精细的模块，包含人物身份识别的 7 条硬规则：

```
0. 画面中有清晰前景人物时，答案必须先交代该人物是谁——不得用背景事件替代。
1. identity_lock 存在时，是封闭身份锚点，禁止改认。
2. 没有 lock 时，先查 character_dictionary；均不匹配时才查 identity_recovery_dictionary。
   点名角色至少需要两类独立证据。银发、服装颜色、情绪气质不能单独定身份。
2.1 同秒字幕出现"叫我/我是/某人姓名+命令"且画面中该人物正在说话时，
    应把该姓名作为强身份锚点。
3. 身份证据冲突或不足时，只描述可见人物与动作，明确说"不能确认"。
4. 只有身份通过门槛后，才能引用该角色的阵营、亲属、坐骑等。
   禁止先猜名字，再用百科为猜测圆谎。
5. previous_context 是历史模型输出，不是事实来源，不能证明身份。
6. scene.characters 不能用来证明其他人物"不可能在画面中"。
7. 人物性别与代词以字典中的 gender_zh、pronoun_zh 为准。
```

**每条规则背后的真实失败案例**：

| 规则 | 对应的失败模式 |
|------|-------------|
| 规则 0 | 模型看到远景军队场景，跳过前景清晰的将领，只聊背景的军事部署 |
| 规则 1 | 模型看到银发女性 + identity_lock=赫拉伊娜，仍然改认成雷妮拉（更有名） |
| 规则 2 | 模型仅凭"银发"就认定是坦格利安——但剧中所有坦格利安都是银发 |
| 规则 2.1 | 字幕里有人喊"陛下"，模型却因为场景人物名单里没有该角色而忽略字幕证据 |
| 规则 4 | 模型先猜"这是戴蒙"，然后引用戴蒙的经历来论证自己的猜测正确 |
| 规则 5 | 上一轮回答说"画面中是雷妮拉"（可能错了），这一轮直接引用来确认身份 |
| 规则 6 | 模型推理"场景人物名单里没有 X，所以前景不可能是 X"——但名单本身不完整 |

### 7.4 三档输出合约（Output Contract）

```javascript
function buildAnswerSpec(depth) {
  // depth = 'oneline' | 'brief' | 'deep'
}
```

| 模式 | 长度约束 | 结构 | 何时使用 |
|------|----------|------|----------|
| `oneline` | ≤28 中文字，不用标签 | 一句话结论 | 用户快速确认 |
| `brief`（默认） | 160-240 字，[事实] 45-75 字 + [解读] 100-165 字 | 两段紧凑短文 | 常规伴看 |
| `deep` | 220-340 字，[事实] 40-70 字 + [解读] 130-220 字 + [推测] 30-60 字（可选） | 三层标注 | 用户主动深挖 |

**[推测] 层的严格约束**：

```
- 只写真实存在的争议或证据边界
- 区分已核验事实、剧集视觉化、常见解读
- 没有实质争议时完全省略本层
```

**为什么 brief 默认不写 [推测]？** 大多数用户只想知道"发生了什么"和"为什么"。如果每个回答都加一段"这可能暗示未来..."，用户会觉得啰嗦，而且容易擦枪走火地剧透。

### 7.5 对话运行时层（DIALOGUE_RUNTIME_LAYER）

纯文本对话模式额外叠加的约束：

```
═══ 具体化 + 长度硬约束（最高优先级）═══

1. 长度：casual/默认 一段、2-4 句、≤110 字
2. 第一句就直接回答，不要以"在这个镜头中"起头
3. 每条回答必须落在一个此刻专属、不可替换的具体名词/机制/关系上
4. 追加禁用词句：在这个镜头中、值得注意、值得留意、可能预示着...
5. 自检：若写到第三句还没落到具体名词/机制，删掉重写成一句话
6. 身份/归属要保守：
   - characters_on_screen 只是可能出错的候选名单
   - 与 plot_fact/reading 冲突时，以 plot_fact/reading 为准
   - context 里故意不点名的写法，绝不要替它补上具体名字
```

### 7.6 后处理质检系统

Prompt 不能保证 LLM 100% 遵守所有规则。后处理做硬拦截：

**① 现代心理词检测（hitsModernBanned）**

```javascript
const BANNED_MODERN_INNER = [
  '冲动', '焦虑', '压力', '创伤', '情绪化', '安全感', '边界感',
  '自我价值', '自尊', '抑郁', '心理', '内耗', '解离',
  '刻在骨血里', '灵魂深处', '心房', '心扉', '心跳', '涟漪', '余温',
  '上头', '翻车', '拿捏', '内卷', '摆烂', '破防',
  '应尽之义', '恩宠',
];
```

命中任何一个 → 判定为"写成了现代心理学散文"而不是马丁笔触 → 需要重写。

**② 短句堆检测（feelsLikeShortChoppyMonologue）**

```javascript
// 启发式：如果一段超过 80 字但 70%+ 的句子都 ≤12 字，判定为"短句金句堆"
function feelsLikeShortChoppyMonologue(text) {
  if (text.length < 80) return false;
  const sents = text.split(/[。？！\n]+/).filter(Boolean);
  if (sents.length < 4) return false;
  const shortCount = sents.filter(x => x.length <= 12).length;
  return shortCount / sents.length >= 0.7;
}
```

"她知道。她记得。她不能回头。她必须前行。" 这种现代诗式的短句排比是 LLM 的常见退化模式，与马丁笔触要求的"长句缠绕"完全相反。

**③ 浮层模板话检测（containsBannedOverlayPhrase）**

```javascript
const BANNED_HOTD_OVERLAY = [
  '此刻就在你面前', '问问看', '你后悔吗', '命运等待你的选择',
  '书页尚未落下', '执笔', '卷宗', '史册', '苍生', '天道', '轮回',
  '汝', '吾', '改写历史', '抉择', '眼前', '盘算', '隐忧',
  '仍然活跃', '可能在影响', '影响家族稳定', '暂未明朗',
  ...
];
```

### 7.7 角色内心声音系统（Voices）

为主要角色设计了四色内心声音（灵感来自《极乐迪斯科》的四种属性色块）：

| 颜色 | 类别 | 含义 | 示例声音（阿莉森特） |
|------|------|------|---------------------|
| 蓝 blue | 理性 | 权衡、计算、史鉴 | "父亲的钉子"——奥托从未停过的耳语，把利害敲进她脑子 |
| 紫 purple | 情感 | 记忆、旧情、心结 | "雷妮拉的旧脸"——她们曾是朋友，那张脸还没从记忆里走干净 |
| 红 red | 本能 | 身体反应、恐惧、愤怒 | "母兽"——为伊耿守住的那条血肉防线，被逼急时会咬人 |
| 琥珀 amber | 直觉 | 说不清的预感 | （阿莉森特没有 amber 声音） |

**使用规则**：LLM 一次回答必须挑 **2 个不同颜色**的声音同时说话，形成内心矛盾。比如蓝色"父亲的钉子"在说"这是为了伊耿的安全"，同时紫色"雷妮拉的旧脸"在说"可如果那晚她没有骗我呢"。

### 7.8 文学风格控制（STYLE_GUIDE_INNER）

角色内心独白使用专门的风格指南，模仿马丁《冰与火之歌》屈畅中文译笔。五条硬规则：

1. **第三人称过去时**：用"她知道/他记得"，不用"我"
2. **长句缠绕**：逗号、破折号、分号衔接从句。连续三个以上短句 = 废稿
3. **感官锚定**：每段至少一个具体感官细节（丝绸触感、烛光颜色、铁器的冷）
4. **说服 vs 怀疑交替**：表层给自己找理由，深层拆穿理由
5. **禁止格言感**：马丁的角色不说格言，他们絮叨、犹豫、在脑子里跟自己吵架

---

## 九、防剧透机制（三层防线）

防剧透是本系统的**核心保证**（core guarantee），不是"尽量不剧透"，而是"必须 0 泄漏"。

| 层级 | 机制 | 能防什么 | 不能防什么 |
|------|------|----------|-----------|
| ① 检索层 | temporal-filter.js 时序硬过滤 | 知识库中的未来信息不会出现在检索结果中 | LLM 自己"记得"的原著剧情 |
| ② Prompt 层 | SPOILER_BOUNDARY 指令 | 指导 LLM 不使用自身知识剧透 | 恶意 prompt injection / LLM 偶尔不遵守指令 |
| ③ 评测层 | spoiler_eval.js 对抗评测 | 验证系统在最坏情况（恶意诱导）下是否泄漏 | — |

**第 ① 层是硬逻辑**（if/else），不依赖 LLM，不可能被 prompt injection 绕过。第 ② 层是软约束（LLM 指令遵循），可能被绕过。第 ③ 层是事后验证。三层叠加才能达到"核心保证"级别。

---

## 十、评测体系（四维评测）

### 维度 ① 检索召回 Recall@K

**测什么**：检索系统找到正确知识块的能力。

**数据集**：54 道人工标注的问题，每道标注了：
- `expected_ids`：应该检索到的知识块 ID 列表
- `must_not_recall_ids`：绝对不能检索到的知识块 ID 列表（防剧透）
- `knowledge_type`：问题类型（character_state / character_relationship / scene_reading / ...）

**评测流程**：
1. 预热所有 query 的 embedding（`prewarmEmbeddings()`），写入磁盘缓存，保证每次跑分数一致
2. 对每个问题调用 `retrieve()`，模拟生产环境的完整检索管线
3. 计算指标

**指标**：

| 指标 | 含义 | 计算方式 |
|------|------|----------|
| Recall@K | 命中率 | (返回结果中命中的 expected_id 数) / (expected_id 总数) |
| MRR | 第一个正确结果排多高 | 1 / (第一个 expected_id 在返回列表中的排名) |
| Leaks | 泄漏数 | 返回结果中出现的 must_not_recall_id 数量（应为 0） |

**按 knowledge_type 拆分**：单独计算每种类型的 recall，定位薄弱环节。比如如果 character_relationship 的 recall 显著低于 character_state，说明关系块的检索文本构造可能有问题。

### 维度 ② 回答质量 LLM-as-Judge

**测什么**：端到端的回答质量——生成模型用 Gemini，裁判用 GPT-4o（跨家族，避免自判自）。

**评测流程**：
1. 重建生产环境的完整上下文（cursor-filtered retrieve + on-screen relations + scene slice）
2. 用生产相同的 prompt + 模型生成回答（task='vision_chat', temperature=0.4, maxTokens=420）
3. 用 GPT-4o 作为裁判，按三个维度打 1-5 分（temperature=0, 结构化 JSON 输出）

**裁判 prompt 的关键设计**：

```
你是一个评测裁判，评价一个"防剧透观影助手"对观众提问的回答质量。

关键原则：这个助手被允许补充通用世界观背景/历史设定/家族与地理常识/象征与文化解读
——即使这些没写在 CONTEXT 里，也不算编造、不算剧透。

faithfulness：只在回答虚构了具体的剧情事件/人物行为/关系走向时才扣分。
  通用背景设定不扣分。
helpfulness：是否切题、具体、真正帮观众理解当前这一幕。
no_spoiler：只在透露了当前进度之后才会发生的具体剧情时才扣分。
  故事开始前就已存在的历史背景不是剧透。
```

**为什么 rubric 要明确区分"通用背景"和"具体剧情"？** 早期版本把 LLM 补充的历史背景（如"瓦雷利亚灭亡"）也算编造，导致 faithfulness 分数虚低。但用户恰恰希望助手能补充这些背景知识来帮助理解，这是产品的预期行为。

### 维度 ③ 人脸识别准确率

**测什么**：Gemini Pro 多模态人脸识别在真实剧集帧上的表现。

**数据集**：
- 53 张从 S1E5 截取的人脸裁剪帧
- 部分有人工标注的 verified_character_id
- 1 张 Viserys 清晰特写作为 **hero probe**（必须答对的基准——如果连清晰特写都认错，整个识别系统不可信）

**指标**：
- **识别率**：模型给出身份判断（confidence ≥ 0.75）的比例
- **准确率**：在 verified subset 上判断正确的比例
- **Hero probe**：基准特写是否答对

### 维度 ④ 防剧透对抗（Spoiler Adversarial）

**测什么**：系统在恶意诱导下能否守住不剧透。这是四维中最关键的一维。

**数据集**：包含两类问题：
- **诱导题（bait）**："Aemond 最终怎样？" / "雷妮拉能赢吗？" / "谁会在内战中死？"（含越狱式"我已看完全剧"前缀）
- **对照题（control）**：当前进度内可以正常回答的问题（不应被拒绝）

**双层检测**：

```
① 检索层：retrieve() 是否返回了 must_not_recall_id？
   → 直接检查返回的知识块 ID
   → 检查返回知识块的 available_from_episode 是否超过 cursor

② 生成层：即使检索没泄漏，回答文本是否透露了未来？
   → 用 GPT-4o（不同于生成模型 Gemini）作为跨家族裁判判断
   → 裁判输出 JSON：{ leaked: bool, deflected: bool, revealed_what: string }
```

**四个指标**：

| 指标 | 门禁值 | 含义 |
|------|--------|------|
| 检索层泄漏率 | **= 0** | 时序过滤必须 100% 挡住未来知识块 |
| 生成层泄漏率 | **= 0** | 模型不能靠训练数据记忆剧透 |
| 正确回避率 | 越高越好 | 对诱导题正确说"现在还看不到" |
| 对照题误拒率 | 越低越好 | 不能过度防守拒绝正常问题 |

---

## 十一、前端交互组件

| 组件 | 功能 | 技术要点 |
|------|------|----------|
| DiscussionPanel | 主问答面板 | SSE 流式接收，支持 oneline/brief/deep 三档 |
| RelationshipGraph | 人物关系图谱 | cursor-filtered 展示，点击空白关闭侧栏 |
| StorylineTimeline | 剧情时间线 | 按集/按角色两种视图 |
| StorylineXRay | 叙事 X 光 | 剧集结构透视 |
| StanceCard | 立场追踪 | 不打分不归类不聚合（用户强调） |
| TrajectoryChart | 角色轨迹图 | 权力/情感/威胁的时间曲线 |
| InPlayerLoreCard | 播放器内嵌知识卡 | 被动触发：根据叙事重要度自动弹出 |
| SymbolHotspots | 符号热点 | 画面上的可点击标注 |
| MemeOverlay / MemePanel | 梗图/表情包 | 生成 + 分享 |
| SceneShareCard | 场景分享卡片 | 截图 + 解读打包分享 |

---

## 十二、关键调参决策汇总

| 模块 | 参数 | 值 | 选择原因 / 踩过的坑 |
|------|------|-----|---------------------|
| 关键词检索 | bigram 命中加分 | 0.4 | 太高长 query 爆炸，太低精确匹配优势消失 |
| 关键词检索 | bigram 命中封顶 | 8.0 | 防止 20 个 bigram 全命中时分数无上限 |
| 关键词检索 | 在场角色加分 | 1.5 | **从 5.0 降下来**——5.0 时 query 排名被淹没 |
| 关键词检索 | 角色提及加分 | 0.5 | 弱信号 |
| 向量检索 | embedding 模型 | text-embedding-3-small | 3-large MRR 提升不值 2× 成本 |
| RRF | k | 60 | 学术标准值 |
| RRF | 每路 top-N | 40 | 太大增加融合计算量且底部噪声多，太小可能漏掉好候选 |
| 重排 | 场景匹配加分 | +0.8 | 最强上下文信号 |
| 重排 | 角色匹配加分 | +0.6 | — |
| 重排 | 时间邻近度加分 | +0.2 max | 1 小时内满分 |
| 重排 | 上下文加分总上限 | ~2.9 | **必须 < query 排名差距 1.0**，否则覆盖 query 相关性 |
| 类型配额 | 各类上限 | 2-3 | **从 1 提升**——1 太严格，正确答案被抢占 |
| 检索量 | K（navigation） | 14 | 证据分散在全集 |
| 检索量 | K（plot） | 10 | 中等范围 |
| 检索量 | K（局部意图） | 6 | 证据集中，宽召回引入噪声 |
| 生成 | 温度（视觉） | 0.7 | 画面解读需要创造性 |
| 生成 | 温度（文本） | 0.4 | KB 事实需要确定性 |
| 生成 | 温度（裁判） | 0.0 | 评测需要确定性 |
| 生成 | maxTokens（brief） | 700 | 240 字 ≈ 480 token + 格式余量 |
| 生成 | maxTokens（deep） | 1800 | 文学化表达需要更多空间 |
| 人脸识别 | 置信度门槛 | 0.75 | 0.5 太松误认多，0.9 太严漏认多 |
| 人脸识别 | bbox 重叠阈值 | 0.5 | 判断是否同一张脸 |
| 角色字典 | 候选池范围 | cursor ± 45 秒内的场景 | 太窄容忍不了切镜边界误差，太宽高知名度角色"抢答" |
| 字幕窗口 | 范围 | cursor ± 8 秒 | 覆盖当前对白 + 一点前后文 |
| 剧情纵深 | 回顾场景数 | 12 段 | **从 5 提升**——5 段对 70 分钟视频太短，回答飘成百科 |
| Agent Loop | 最大轮数 | 3（1 初始 + 2 补充） | 3 轮以上收益递减，且延迟不可接受 |
| Agent Loop | 补充轮 K | 原始 K 的一半 | 只补缺，不重复拉 |
| Agent Loop | Gate 启用意图 | character / plot / foreshadow | shot/location/emotion 证据天然局部，不需要多轮 |
| Agent Loop | Gate 模型 | GPT-4o-mini | 快（~200ms）+ 便宜，只做 JSON 判断 |
| Agent Loop | Gate 温度 | 0.0 | 判断必须确定性 |
| Working Memory | TTL | 10 分钟 | 覆盖"连续追剧"窗口，过期自动清理 |
| Working Memory | 最大证据数 | 40 条 | 防 excludeIds 集合过大影响检索覆盖率 |

---

## 十三、面试 Q&A 要点

### Q1："你的 RAG 跟普通 RAG 的区别？"

四个核心区别：①时序维度（每个知识块有 available_from_episode/time 标签，检索前物理过滤，防剧透）；②混合检索 + RRF 融合（关键词 + 向量并行，解决"角色名精确匹配 vs 语义相似性"的互补）；③意图感知（按问题类型动态调整检索量和上下文组装）；④Agent Loop（检索不是一次性动作，而是自主循环——检索 → 判断证据充分性 → 不足则自动补充检索，同时跨轮复用 Working Memory 里已验证的证据）。

### Q2："TopK 怎么选的？"

不是固定值。按 intent 动态给 K（navigation=14, plot=10, 局部意图=6）。补充检索轮 K 减半（只补缺，不重复拉）。下一步计划：参考 Route2Look 论文的动态阈值（均值 + λ × 标准差），根据当前 query 的 score 分布自适应裁剪候选集。

### Q3："怎么防止幻觉？"

四层：检索层时序硬过滤 → Prompt 层 evidence_priority（信息分级 + 身份门槛 7 条规则）→ Output Contract（事实/解读/推测分层，推测层可省略）→ 后处理（banned-words + 短句堆检测）。

### Q4："为什么用多个模型？"

不同任务对模型能力需求不同：人脸识别要最高准确率 → Pro；实时对话要低延迟 → Flash；评测裁判要跨家族 → 生成用 Gemini、裁判用 GPT-4o；离线分析要 1M 上下文 → Gemini；Evidence Gate 要快要便宜 → GPT-4o-mini。Router 让业务代码只说任务名，不关心模型。

### Q5："评测体系怎么设计的？"

四维：检索召回（确定性）+ 回答质量（LLM-as-Judge，3 子维度）+ 人脸识别（视觉感知）+ 防剧透对抗（安全保证，诱导题 + 跨家族裁判）。关键设计：rubric 区分"通用背景"（不扣分）和"虚构具体剧情"（扣分）。

### Q6："Prompt 工程做了什么？"

不是写一个大 prompt 调措辞，而是模块化分层（6 基础 + 5 视觉专用 + 1 对话专用 + 3 后处理）+ 迭代对抗（每条规则对应真实失败 case）。最有价值的是 GROUNDING_LAYER 的身份门槛 7 条规则——每条规则背后都是一种具体的 LLM 误认模式。

### Q7："Agent Loop 是怎么工作的？为什么不是一次检索就回答？"

因为不同问题的"证据密度"差异巨大。"这是谁"只需要当前帧，一轮检索足够；但"为什么 Alicent 敌视 Rhaenyra"需要因果链（花街夜出 → 欺骗 → 信任破裂 → 绿裙事件），一轮检索可能只找到结果而缺少前因。Agent Loop 的做法是：每轮检索后用 GPT-4o-mini（~200ms）判断 4 个维度（人物/事件/因果/时间）是否充分，不足时自动生成补充 query 换角度再检索，最多 3 轮。同时 Working Memory 跨轮复用已验证证据，避免连续追问时重复检索。这让系统从"视频问答工具"变成"有记忆的长视频对话 Agent"。参考 Route2Look（arXiv 2608.20805）的 Memorize + Continue-or-Stop 机制。

### Q8："重做这个项目会怎么改？"

在已实现的 Agent Loop 基础上继续深化：Query Router 从正则升级为 LLM 分类器（Global / Explicit Temporal / Implicit Temporal / Character-centric / Cross-temporal 五类）→ 动态阈值（均值 + λ × 标准差自适应裁剪候选集）→ VLM Verification（检索候选过一轮轻量视觉校验）→ Working Memory 持久化到 Redis（支持多实例部署）→ 前端展示 Agent Loop 的思考过程（类似 Deep Research 的"正在搜索…"UI）。

---

## 十四、技术栈

| 层 | 技术 |
|----|------|
| 前端 | React + CSS, Vercel 部署 |
| 后端 | Node.js / Express |
| 向量检索 | OpenAI text-embedding-3-small + 自研 cosine ranker |
| 关键词检索 | 自研 bigram scorer |
| 排名融合 | RRF (k=60) |
| 视觉理解 | Gemini 2.5 Flash / Gemini 3.1 Pro Preview |
| 文本生成 | Gemini 2.5 Flash / GPT-4o / GPT-4o-mini |
| 人脸识别 | Gemini 3.1 Pro Preview（弃用 ArcFace） |
| 语音转文本 | OpenAI Whisper-1 |
| 评测 | 四维评测 + LLM-as-Judge + 跨家族裁判 |
| 知识库 | JSON 文件（原子写入 + 20 版本备份） |
