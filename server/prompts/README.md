# AI Prompt 分层

视觉解读请求由两部分组成：

## System（长期规则）

`vision/index.js` 按顺序组合以下层：

- `vision/identity.js`：角色与任务边界
- `vision/grounding.js`：防剧透、证据优先级、事实纪律
- `vision/analysis.js`：对白与视觉解读流程
- `vision/style.js`：语言风格与禁止项
- `answer-spec.js`：一句、简明、深挖三档输出契约

## User（本轮输入）

`vision/user.js` 只组装当前图片、用户问题与运行时 JSON。运行时数据不会写进 System，也不携带固定分析规则。

`agent.js` 负责准备本轮数据，并调用以上模块，不再保存大段视觉 Prompt。
