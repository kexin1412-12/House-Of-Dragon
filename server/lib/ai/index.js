// AI 编排层 facade。业务代码只通过这里调用 AI，不直接 import 任何厂商 SDK。
//
// 使用示例：
//   const ai = require('./lib/ai');
//
//   // 流式多模态对话
//   for await (const chunk of ai.chatStream({
//     task: 'vision_chat',
//     system: '...',
//     messages: [{ role: 'user', content: [
//       { type: 'image', dataUrl: 'data:image/jpeg;base64,...' },
//       { type: 'text', text: '画面里发生了什么？' },
//     ]}],
//   })) {
//     if (chunk.type === 'text') process.stdout.write(chunk.delta);
//     if (chunk.type === 'done') console.log('usage:', chunk.usage);
//   }
//
//   // 结构化 JSON 输出
//   const data = await ai.generateStructured({
//     task: 'vision',
//     system: '...',
//     messages: [...],
//     schema: { type: 'object', properties: {...} },
//   });

const TASK_CONFIG = require('./router');
const OpenAIProvider = require('./providers/openai');
const GeminiProvider = require('./providers/gemini');

const PROVIDERS = {
  openai: new OpenAIProvider(),
  gemini: new GeminiProvider(),
};

function _resolve(task) {
  const cfg = TASK_CONFIG[task];
  if (!cfg) throw new Error(`Unknown AI task: ${task}`);

  let providerName = cfg.provider;
  let model = cfg.model;
  let provider = PROVIDERS[providerName];

  // 主 provider 没配 key → 降级到 fallback
  if (!provider || !provider.isAvailable()) {
    if (cfg.fallback && PROVIDERS[cfg.fallback]?.isAvailable()) {
      providerName = cfg.fallback;
      model = cfg.fallbackModel || model;
      provider = PROVIDERS[providerName];
    }
  }

  if (!provider) throw new Error(`Unknown provider for task ${task}: ${cfg.provider}`);
  return { provider, providerName, model };
}

function isAvailable(task) {
  try {
    const { provider } = _resolve(task);
    return provider.isAvailable();
  } catch {
    return false;
  }
}

function describe() {
  const out = {};
  for (const [task, cfg] of Object.entries(TASK_CONFIG)) {
    let resolved = null;
    try {
      const r = _resolve(task);
      resolved = { provider: r.providerName, model: r.model, ready: r.provider.isAvailable() };
    } catch (e) {
      resolved = { error: e.message };
    }
    out[task] = {
      configured: { provider: cfg.provider, model: cfg.model },
      fallback: cfg.fallback ? { provider: cfg.fallback, model: cfg.fallbackModel } : null,
      active: resolved,
    };
  }
  return out;
}

async function* chatStream({ task, system, messages, maxTokens, temperature, signal }) {
  const { provider, model, providerName } = _resolve(task);
  yield { type: 'meta', provider: providerName, model };
  yield* provider.chatStream({ system, messages, model, maxTokens, temperature, signal });
}

async function chat({ task, system, messages, maxTokens, temperature }) {
  const { provider, model, providerName } = _resolve(task);
  const result = await provider.chat({ system, messages, model, maxTokens, temperature });
  return { ...result, provider: providerName, model };
}

async function generateStructured({ task, system, messages, schema, schemaName, temperature }) {
  const { provider, model, providerName } = _resolve(task);
  const data = await provider.generateStructured({
    system,
    messages,
    model,
    schema,
    schemaName,
    temperature,
  });
  return { data, provider: providerName, model };
}

// 单轮工具调用。需要 provider 实现 chatWithTools（目前只有 OpenAI）。
// Agent loop 由调用方驱动：append tool 结果到 messages，重调本函数直到 finalize。
async function chatWithTools({ task, system, messages, tools, maxTokens, temperature, toolChoice }) {
  const { provider, model, providerName } = _resolve(task);
  if (typeof provider.chatWithTools !== 'function') {
    throw new Error(`Provider ${providerName} does not support tool calling (task=${task}).`);
  }
  const result = await provider.chatWithTools({
    system, messages, tools, model, maxTokens, temperature, toolChoice,
  });
  return { ...result, provider: providerName, model };
}

module.exports = {
  chat,
  chatStream,
  generateStructured,
  chatWithTools,
  isAvailable,
  describe,
  // 暴露原始 provider 供脚本直接使用（如 Whisper）
  _providers: PROVIDERS,
};
