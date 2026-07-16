# AI Prompt 分层

当前解析 prompt 分成三类入口：

1. `server/agent.js`：播放器旁边的实时问答入口。
2. `server/lib/scene_analyst/agent.js`：批量生成 scene 结构化解读。
3. `server/lib/scene_analyst/hotspot_agent.js`：单个符号热点生成。

通用规则放在 `common/`，入口只负责组合。

## Common（跨入口规则）

- `common/anti-bloat.js`：反废话、Lore-first、视觉描述剥离、空话黑名单。

所有实时问答、scene 解读、热点生成都应复用这里的规则，不要在各入口复制一份。

## 实时视觉解读

## System（长期规则）

`vision/index.js` 按顺序组合以下层，随后由 `agent.js` 追加 `common/anti-bloat.js` 与 `answer-spec.js`：

- `vision/identity.js`：角色与任务边界
- `vision/grounding.js`：防剧透、证据优先级、事实纪律
- `vision/analysis.js`：对白与视觉解读流程
- `vision/literary.js`：深挖档的论断、意象、反差与收束
- `vision/style.js`：语言风格与禁止项
- `answer-spec.js`：一句、简明、深挖三档输出契约

## User（本轮输入）

`vision/user.js` 只组装当前图片、用户问题与运行时 JSON。运行时数据不会写进 System，也不携带固定分析规则。

`agent.js` 负责准备本轮数据，并调用以上模块；普通文字问答仍保留基础 `SYSTEM_PROMPT`，但同样追加 `common/anti-bloat.js`。

## Scene / Hotspot 生成

- `scene_analyst/agent.js`：保留结构化字段、工具调用和防剧透规则；写作层复用 `common/anti-bloat.js`。
- `scene_analyst/hotspot_agent.js`：保留单热点输出契约；写作层复用 `common/anti-bloat.js`。

后续如果要调整“不要啰嗦 / Lore-first / 禁止句式”，优先改 `common/anti-bloat.js`。
