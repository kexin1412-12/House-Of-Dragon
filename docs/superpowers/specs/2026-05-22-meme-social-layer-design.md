# 文化梗 社交层 — 设计稿

**日期**：2026-05-22
**作者**：kexin chen + Claude
**状态**：approved，进入实施计划

## 1. 这是个什么功能

用户看完一个文化梗之后有三种社交冲动，这个功能把三种冲动各做成一块交互，追加到现有
[MemePanel](../../../client/src/MemePanel.js) 条目展开详情的**底部**（现有 tier3 内容
原样保留）：

| 社交冲动 | 对应 UI |
|---|---|
| "原来是这个意思！"——涨知识的惊喜，想知道别人是不是也没看懂 | **涨知识了 / 早就知道** 两个反应键 |
| "这个梗太妙了"——想分享炫耀 | **分享** 键（复制文案到剪贴板） |
| "我知道一个更好的解释"——补充欲 | **viewer notes** 评论区 + add your note |

参考截图是一张深色社交卡（反应键带计数、share/deep dive/collect 操作行、viewer notes
评论区）。本设计把这张卡的能力**增量**叠到真实产品上，视觉沿用现有深底 + 金边
(`#f3c97a`) 体系，不重做。

## 2. Demo 范围

- 只在本集（house_of_dragon_05）7 条已有 riff 上做。
- 反应计数、网友补充都是**预先编写的高拟真种子数据**——本产品没有社交后端，按用户决定
  保留截图那种计数观感，数据写进 KB。
- 运行时不调 LLM、不连后端社交服务；用户的反应/笔记/点赞是**纯内存**状态（F5 归零），
  跟现有 [useMemefavorites](../../../client/src/useMemeFavorites.js) 同一套模式。
- 共撒 **14 条** 网友补充（≥10），分布见附录 A。

**都不做**：真实社交后端、跨设备同步、持久化、举报/折叠/排序、给反应做榜单或聚合分析。

## 3. 数据层（只动 KB JSON，不动 server）

`/api/riffs` 已是整对象透传（[server/index.js](../../../server/index.js) `app.get('/api/riffs')`
直接 `res.json({ ...riffs })`），所以只需给每条 riff 加一个 `social` 块，前端即可读到，
**无需改服务端代码**：

```jsonc
"social": {
  "reactions": { "til": 1243, "knew": 438 },   // 涨知识了 / 早就知道 的种子计数
  "notes": [
    {
      "note_id": "i_am_the_crown_e05_n1",       // 稳定 key，给 React 列表 & 点赞用
      "author": "ShakespeareNerd",
      "time": "2d",                              // 展示原样字符串，不做相对时间计算
      "upvotes": 47,
      "text": "……"
    }
  ]
}
```

字段说明：

- `reactions.til` / `reactions.knew`：种子计数。前端展示时若用户选了某一侧，则该侧
  显示 `种子 + 1`。
- `notes[]`：种子网友补充，按 KB 里给的顺序展示（不在前端排序）。`note_id` 全局唯一。
- 头像用昵称首字（中文取首字、英文取首字母大写）渲染成圆形 initial chip，不引外部图片。

## 4. 反应键（涨知识了 / 早就知道）

- 两个并排键：`💡 涨知识了 N` / `🙂 早就知道 M`（图标用与面板一致的简洁字形/内联 SVG，
  不用花哨 emoji；具体字形实现时定）。N/M 取 KB 种子。
- 交互：点一下选中 → 高亮 + 金色下划线（对齐截图），该侧显示数变 `种子+1`；
  再点同一个取消；两侧互斥（选 A 自动取消 B）。
- 选择状态按 `riff_id` 存内存 hook，F5 归零。**不做榜单、不聚合、不排序**——只是个人
  反应的视觉回执 + 截图要求保留的种子计数。

## 5. 操作行 share / deep dive / collect

一行三键，对齐截图布局，但都映射到**真实动作**（不造空按钮）：

- **collect** = 复用现有「♡ 收藏 / ♥ 已收藏」（`useMemeFavorites`），位置语义不变。
- **share** = 新增：把「台词原文 + 一句话解读(`tier2_punch`) + mm:ss 时间点」拼成一段
  文案，`navigator.clipboard.writeText` 复制到剪贴板，行内变「已复制 ✓」约 2s 后复原。
  clipboard 不可用时回落到选中文本提示。**纯本地，不外发任何数据。**
- **deep dive** = 映射到现有「▶ 跳到此处」（回到该台词时间点重看），不另造动作。

## 6. viewer notes（补充欲）

- 区头：`viewer notes  N`，N = 真实条目数（种子条数 + 用户本地新增条数）。
- 列表：每条显示 头像 initial / 昵称 / 时间 / 正文 / `▲ 点赞数`。
  - 点赞：本地 toggle，点亮时显示 `种子+1`；再点取消。按 `note_id` 存内存。
- `+ add your note`：点开变输入框，提交后**本地**追加一条 `{author:"你", time:"刚刚",
  upvotes:0, text}`，置于列表底部；内存态，F5 归零。空文本不提交。

## 7. 配色细节（顺带，低风险）

截图里 tag `双关` 是琥珀、`典故` 是紫——对齐用户"别一直堆同一个金"的偏好，给 tag 按
语义上色（小改 [MemePanel.css](../../../client/src/MemePanel.css)，只加 class，不动结构）：

- 琥珀（默认金）：双关 / 暗指 / 隐喻 / 转喻 / 时代委婉语
- 紫：典故 / 经典台词
- 暖灰蓝：戏剧反讽 / 地域制度对照 / 角色弧 / 身份宣告 / 演员高光

未列到的 tag 回落默认金。

## 8. 改动范围（严格不碰其他完善代码）

| 文件 | 改动 |
|---|---|
| [client/src/MemePanel.js](../../../client/src/MemePanel.js) | 详情底部追加社交层（纯增量渲染） |
| [client/src/MemePanel.css](../../../client/src/MemePanel.css) | 追加社交层样式 + tag 语义色（纯增量） |
| `client/src/useMemeSocial.js` | 🆕 内存 hook：反应选择 / 我的笔记 / 点赞 toggle |
| [server/kb/dialogue_riffs/house-of-the-dragon.json](../../../server/kb/dialogue_riffs/house-of-the-dragon.json) | 给 7 条 riff 各加 `social` 数据 |

**不动**：server 代码、App.js、MemeOverlay、其他任何组件。

## 9. UI 文案约束

所有用户可见文案不出现文件名 / 内部 ID / 反引号代码 / "本剧 KB" 这类元层级措辞。
网友补充内容写成自然的剧迷口吻。

---

## 附录 A：种子社交数据（14 条 note）

> 以下为每条 riff 的 `social` 种子。计数为编写值，求"像真的"。

**1. moon_tea_innuendo_e05**（隐喻/暗指 · "送茶"暗示）
reactions: til 2143 / knew 891
- 月亮茶研究所 · 3d · 89：moon tea 在原著里第一次出现是 Lysa 那条线，剧版这里把它当全剧暗号在复用，给到这杯茶基本等于"丑闻已被高层掌握"。
- 临冬城老张 · 12h · 34：Larys 全程没说一个露骨的字，这才是高手——把把柄全留给对方，自己一点不沾。

**2. duck_to_goose_e05**（双关/时代委婉语 · 鸭鹅之约）
reactions: til 3402 / knew 1187
- 鸭鹅之约 · 4d · 156：演员 John Macmillan 采访里说，这场戏他排"装作无意"的语气排了最久。
- Polari暗语爱好者 · 1d · 73：用食物隐喻性取向是 19 世纪英国地下黑话 Polari 的老传统，编剧明显是故意复刻。
- 弹幕考据君 · 6h · 41：雷妮拉接的那句"也有人偏爱烤鹅"——她听懂了还顺着回，两个人当场达成默契，这段才封神。

**3. i_am_the_crown_e05**（转喻/身份宣告 · "我即是王冠" · 头牌 3 条）
reactions: til 1243 / knew 438
- ShakespeareNerd · 2d · 47：这句对位的是路易十四"朕即国家"，但更狠——路易十四说的是已有的制度，Rhaenyra 说的是"我即将是"，一个还没拿到权力的人提前宣告主权。
- 美剧老中医 · 5h · 31：中文字幕"我就是王冠"丢了 the crown 的转喻——英文里 crown 既是物也是权力本身，中文只能二选一。
- 权游补习班 · 1d · 62：别忘了上一句是 Criston 的 "a marriage for love, not for the crown"，两人用同一个 the crown 指了相反的东西，这才是这段对白的设计精髓。

**4. marry_for_love_e05**（经典台词/角色弧 · "为爱不为王座"）
reactions: til 986 / knew 624
- 白袍誓约 · 3d · 28：Criston 是国王禁卫军、发过禁欲誓，他说这句等于要拿整个骑士身份换一个回答。
- 黑党后援会 · 8h · 19：这句和下一句"我即是王冠"是绿黑分裂的私人起点，整部剧的火药桶就是这两句点着的。

**5. vale_men_answer_for_crimes_e05**（经典台词/地域制度对照 · 艾林谷）
reactions: til 763 / knew 512
- 谷地法律顾问 · 2d · 22：这句在暗示连坦格利安都能被扔下"月门"——地域制度差异的伏笔，后面会回收。

**6. kept_safe_so_are_we_all_e05**（经典台词/戏剧反讽）
reactions: til 641 / knew 433
- 反讽收集者 · 1d · 26：这句的戏剧反讽在于——台上说"我们都安全"的时候，观众已经知道接下来要出大事了。

**7. good_song_in_a_hundred_years_e05**（经典台词/戏剧反讽/演员高光）
reactions: til 1502 / knew 388
- 百年好歌 · 2d · 58："a hundred years"是全集演员高光，留意他念这句时那个停顿。
- 细节控 · 14h · 33：戏剧反讽叠满——他说百年后会被传唱，可观众知道这场婚礼马上要见血。
