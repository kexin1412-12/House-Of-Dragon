// 任务 → Provider/Model 路由表。
// 想换厂商时，只改这里（或用环境变量覆盖），不用动业务代码。
//
// fallback：当主 provider 没配置 key 时，自动降级到 fallback。
// 没 fallback 就直接报错，让调用方知道哪个 key 缺了。

const TASK_CONFIG = {
  // 画面/视频帧理解（人脸识别、镜头分析、多模态问答的视觉部分）
  vision: {
    provider: process.env.AI_VISION_PROVIDER || 'gemini',
    model: process.env.AI_VISION_MODEL || 'gemini-2.5-flash',
    fallback: 'openai',
    fallbackModel: process.env.OPENAI_VISION_MODEL || 'gpt-4o',
  },

  // 多模态问答（画面 + KB context + 历史对话 → 自然语言回答）
  vision_chat: {
    provider: process.env.AI_VISION_CHAT_PROVIDER || 'gemini',
    model: process.env.AI_VISION_CHAT_MODEL || 'gemini-2.5-flash',
    fallback: 'openai',
    fallbackModel: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  // 深挖视觉解读优先使用 Pro 做复杂身份排除、历史检索与符号推理；
  // agent.js 保留失败后自动降级 vision_chat/Flash 的生产兜底。
  vision_chat_deep: {
    provider: process.env.AI_VISION_DEEP_PROVIDER || 'gemini',
    model: process.env.AI_VISION_DEEP_MODEL || 'gemini-3.1-pro-preview',
    fallback: 'openai',
    fallbackModel: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  // 纯文本剧情问答（无画面，只读 KB）
  chat: {
    provider: process.env.AI_CHAT_PROVIDER || 'openai',
    model: process.env.AI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  // 角色对谈生成：玩家立场选项 / 入场前奏 / 内心声音 —— 文案要尽量贴《血与火》原作口吻，
  // 默认走 gemini-2.5-flash（长上下文 + 中文文学性强）；openai 兜底。
  dialogue: {
    provider: process.env.AI_DIALOGUE_PROVIDER || 'gemini',
    model: process.env.AI_DIALOGUE_MODEL || 'gemini-2.5-flash',
    fallback: 'openai',
    fallbackModel: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  // 离线分析（剧情解读、场景标注） —— 需要长上下文 + 强推理
  reasoning: {
    provider: process.env.AI_REASONING_PROVIDER || 'openai',
    model: process.env.AI_REASONING_MODEL || 'gpt-4o',
  },

  // Scene-analyst agent：带工具的多轮推理（看 KB / 查角色 / 查母题 / 查字幕）。
  // 当前只 OpenAI 实现 chatWithTools；不要降级到 gemini 否则会运行时报错。
  agent_analysis: {
    provider: process.env.AI_AGENT_PROVIDER || 'openai',
    model: process.env.AI_AGENT_MODEL || 'gpt-4o',
  },

  // 离线长文本抽取（原著小说 → 角色关系/状态时间线）
  // 用 Gemini 1M ctx 一次塞下整本书；OpenAI 作为兜底（chunk 模式）
  book_extraction: {
    provider: process.env.AI_BOOK_PROVIDER || 'gemini',
    model: process.env.AI_BOOK_MODEL || 'gemini-2.5-flash',
    fallback: 'openai',
    fallbackModel: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  // 人物图谱抽取：读已升级 scene KB 的 deep_reading + foreshadow，产出关系事件 JSON
  // 长上下文 + 结构化输出场景，Gemini 主用；OpenAI 兜底
  character_graph: {
    provider: process.env.AI_CHARGRAPH_PROVIDER || 'gemini',
    model: process.env.AI_CHARGRAPH_MODEL || 'gemini-2.5-flash',
    fallback: 'openai',
    fallbackModel: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  // 关系图侧栏 · 详细人物档案：Gemini Flash 中文文学性 + 长上下文容纳全部 KB 数据
  // 性能预算：单次 ~600-900 tok 输出，温和 temperature。openai 兜底。
  character_profile: {
    provider: process.env.AI_CHARPROFILE_PROVIDER || 'gemini',
    model: process.env.AI_CHARPROFILE_MODEL || 'gemini-2.5-flash',
    fallback: 'openai',
    fallbackModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  // 平行视角 HUD（perspective）·点角色头像后弹出的 3 张极短卡片
  // 走 Gemini 2.5 Flash：上下文里有完整 scene 切片 + cursor-过滤关系 + 角色 profile，
  // Flash 已经够用且无须 thinking_budget。openai gpt-4o-mini 兜底。
  perspective: {
    provider: process.env.AI_PERSPECTIVE_PROVIDER || 'gemini',
    model: process.env.AI_PERSPECTIVE_MODEL || 'gemini-2.5-flash',
    fallback: 'openai',
    fallbackModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  // 字幕/语音转文本
  transcription: {
    provider: process.env.AI_TRANSCRIPTION_PROVIDER || 'openai',
    model: process.env.AI_TRANSCRIPTION_MODEL || 'whisper-1',
  },
};

module.exports = TASK_CONFIG;
