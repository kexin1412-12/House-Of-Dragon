// OpenAI Provider —— 把厂商无关的 messages 转成 OpenAI 格式。

const { createOpenAIClient } = require('../openai-client');

class OpenAIProvider {
  constructor() {
    this.client = null;
  }

  isAvailable() {
    return !!process.env.OPENAI_API_KEY;
  }

  _client() {
    if (this.client) return this.client;
    if (!this.isAvailable()) return null;
    this.client = createOpenAIClient();
    return this.client;
  }

  // 厂商无关 messages → OpenAI chat.completions messages
  _convertMessages(system, messages) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
      if (typeof m.content === 'string') {
        out.push({ role: m.role, content: m.content });
        continue;
      }
      const parts = m.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type === 'image') {
          return {
            type: 'image_url',
            image_url: { url: part.dataUrl, detail: part.detail || 'auto' },
          };
        }
        return { type: 'text', text: '' };
      });
      out.push({ role: m.role, content: parts });
    }
    return out;
  }

  async *chatStream({ system, messages, model, maxTokens = 420, temperature = 0.4, signal }) {
    const client = this._client();
    if (!client) throw new Error('OpenAI provider not configured (OPENAI_API_KEY missing)');

    const stream = await client.chat.completions.create(
      {
        model,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        stream_options: { include_usage: true },
        messages: this._convertMessages(system, messages),
      },
      { signal },
    );

    let usage = null;
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield { type: 'text', delta };
    }
    yield {
      type: 'done',
      usage: usage
        ? {
            input: usage.prompt_tokens,
            output: usage.completion_tokens,
            cache_read: usage.prompt_tokens_details?.cached_tokens,
          }
        : null,
    };
  }

  async chat({ system, messages, model, maxTokens = 420, temperature = 0.4 }) {
    const client = this._client();
    if (!client) throw new Error('OpenAI provider not configured (OPENAI_API_KEY missing)');

    const resp = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: this._convertMessages(system, messages),
    });
    return {
      text: resp.choices[0]?.message?.content?.trim() || '',
      usage: resp.usage
        ? {
            input: resp.usage.prompt_tokens,
            output: resp.usage.completion_tokens,
          }
        : null,
    };
  }

  async generateStructured({
    system,
    messages,
    model,
    schema,
    schemaName = 'response',
    temperature = 0.1,
  }) {
    const client = this._client();
    if (!client) throw new Error('OpenAI provider not configured (OPENAI_API_KEY missing)');

    const resp = await client.chat.completions.create({
      model,
      temperature,
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema },
      },
      messages: this._convertMessages(system, messages),
    });
    return JSON.parse(resp.choices[0].message.content || '{}');
  }

  // 单轮工具调用：传入 tools + messages，返回模型的 tool_calls（如有）和文本。
  // Agent loop 由调用方驱动（追加 tool 结果到 messages，循环重调）。
  // tools 形如：[{ name, description, parameters: <jsonschema> }]
  // messages 支持：role='tool', tool_call_id, content（字符串）
  async chatWithTools({
    system,
    messages,
    tools,
    model,
    maxTokens = 1500,
    temperature = 0.2,
    toolChoice = 'auto',
  }) {
    const client = this._client();
    if (!client) throw new Error('OpenAI provider not configured (OPENAI_API_KEY missing)');

    const resp = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature,
      tools: tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: toolChoice,
      messages: this._convertToolMessages(system, messages),
    });

    const msg = resp.choices?.[0]?.message;
    return {
      text: msg?.content || '',
      // 直接透传 OpenAI 的 tool_calls 形态（id / function.name / function.arguments(string)）
      toolCalls: (msg?.tool_calls || []).map(tc => ({
        id: tc.id,
        name: tc.function.name,
        argumentsJson: tc.function.arguments,
      })),
      finishReason: resp.choices?.[0]?.finish_reason || null,
      usage: resp.usage
        ? { input: resp.usage.prompt_tokens, output: resp.usage.completion_tokens }
        : null,
      raw: msg,
    };
  }

  // chatWithTools 专用消息转换：保留 tool_calls / tool_call_id，不要走多模态路径
  _convertToolMessages(system, messages) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
      if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
        continue;
      }
      if (m.role === 'assistant' && m.tool_calls) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.argumentsJson },
          })),
        });
        continue;
      }
      // 普通 user/assistant 文本
      if (typeof m.content === 'string') {
        out.push({ role: m.role, content: m.content });
      } else {
        // agent loop 通常都是纯文本；多模态走 _convertMessages
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }
}

module.exports = OpenAIProvider;
