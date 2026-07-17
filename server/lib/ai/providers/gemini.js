// Gemini Provider —— Google @google/genai SDK 封装。
//
// 安装：npm i @google/genai
// 环境变量：GEMINI_API_KEY 或 GOOGLE_API_KEY
//
// 与 OpenAI 的差异：
//   - role: 'assistant' → 'model'，没有 'system' role（用 systemInstruction 字段）
//   - 图片：inlineData { mimeType, base64 }，不是 image_url
//   - 流式：generateContentStream 返回 async iterable，每块带 .text
//   - 结构化输出：responseMimeType + responseSchema（JSON Schema 子集，不支持 additionalProperties）

class GeminiProvider {
  constructor() {
    this.client = null;
  }

  isAvailable() {
    return !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  }

  _client() {
    if (this.client) return this.client;
    if (!this.isAvailable()) return null;
    const { GoogleGenAI } = require('@google/genai');
    this.client = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    });
    return this.client;
  }

  // 厂商无关 messages → Gemini contents
  _convertContents(messages) {
    return messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: this._convertParts(m.content),
    }));
  }

  _convertParts(content) {
    if (typeof content === 'string') return [{ text: content }];
    return content.map(part => {
      if (part.type === 'text') return { text: part.text };
      if (part.type === 'image') {
        const m = /^data:(image\/[^;]+);base64,(.+)$/.exec(part.dataUrl);
        if (!m) throw new Error('Gemini: image part must be a base64 data URL');
        return { inlineData: { mimeType: m[1], data: m[2] } };
      }
      if (part.type === 'file') {
        if (!part.uri || !part.mimeType) {
          throw new Error('Gemini: file part requires uri and mimeType');
        }
        return { fileData: { fileUri: part.uri, mimeType: part.mimeType } };
      }
      throw new Error(`Gemini: unsupported content part type: ${part.type}`);
    });
  }

  // JSON Schema → Gemini responseSchema（剥掉不支持的字段）
  _convertSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(s => this._convertSchema(s));
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'additionalProperties' || k === '$schema') continue;
      if (k === 'strict') continue;
      if (k === 'type' && Array.isArray(v)) {
        const concreteTypes = v.filter(type => type !== 'null');
        out.type = concreteTypes[0] || 'string';
        if (v.includes('null')) out.nullable = true;
        continue;
      }
      out[k] = this._convertSchema(v);
    }
    return out;
  }

  _buildConfig({ system, maxTokens, temperature, schema, model }) {
    const config = {};
    if (system) config.systemInstruction = system;
    if (typeof maxTokens === 'number') config.maxOutputTokens = maxTokens;
    if (typeof temperature === 'number') config.temperature = temperature;
    if (schema) {
      config.responseMimeType = 'application/json';
      config.responseSchema = this._convertSchema(schema);
    }
    // gemini-2.5-* 默认会用 thinking tokens，会吃掉 maxOutputTokens 预算导致短回答被截断。
    // 默认设为 0 关闭 thinking；用 GEMINI_THINKING_BUDGET 环境变量可覆盖（pro 模型需要 ≥128）。
    const isGemini31Pro = /^gemini-3\.1-pro(?:$|-)/.test(model || '');
    if (isGemini31Pro) {
      const configuredLevel = String(process.env.GEMINI_PRO_THINKING_LEVEL || 'low').toLowerCase();
      config.thinkingConfig = {
        thinkingLevel: ['low', 'medium', 'high'].includes(configuredLevel) ? configuredLevel : 'low',
      };
      return config;
    }

    const isGemini25Pro = /^gemini-2\.5-pro(?:$|-)/.test(model || '');
    const configuredBudget = isGemini25Pro
      ? process.env.GEMINI_PRO_THINKING_BUDGET
      : process.env.GEMINI_THINKING_BUDGET;
    let thinkingBudget = configuredBudget != null
      ? parseInt(configuredBudget, 10)
      : (isGemini25Pro ? 1024 : 0);
    if (!Number.isFinite(thinkingBudget)) thinkingBudget = isGemini25Pro ? 1024 : 0;
    if (isGemini25Pro && thinkingBudget < 128) thinkingBudget = 128;
    config.thinkingConfig = {
      thinkingBudget,
    };
    return config;
  }

  async *chatStream({ system, messages, model, maxTokens = 420, temperature = 0.4, signal }) {
    const client = this._client();
    if (!client) throw new Error('Gemini provider not configured (GEMINI_API_KEY missing)');

    const stream = await client.models.generateContentStream({
      model,
      contents: this._convertContents(messages),
      config: this._buildConfig({ system, maxTokens, temperature, model }),
    });

    let usage = null;
    for await (const chunk of stream) {
      if (signal?.aborted) break;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      const delta = chunk.text;
      if (delta) yield { type: 'text', delta };
    }
    yield {
      type: 'done',
      usage: usage
        ? {
            input: usage.promptTokenCount,
            output: usage.candidatesTokenCount,
            cache_read: usage.cachedContentTokenCount,
          }
        : null,
    };
  }

  async chat({ system, messages, model, maxTokens = 420, temperature = 0.4 }) {
    const client = this._client();
    if (!client) throw new Error('Gemini provider not configured (GEMINI_API_KEY missing)');

    const resp = await client.models.generateContent({
      model,
      contents: this._convertContents(messages),
      config: this._buildConfig({ system, maxTokens, temperature, model }),
    });
    return {
      text: (resp.text || '').trim(),
      usage: resp.usageMetadata
        ? {
            input: resp.usageMetadata.promptTokenCount,
            output: resp.usageMetadata.candidatesTokenCount,
          }
        : null,
    };
  }

  async generateStructured({ system, messages, model, schema, temperature = 0.1, maxTokens }) {
    const client = this._client();
    if (!client) throw new Error('Gemini provider not configured (GEMINI_API_KEY missing)');

    const resp = await client.models.generateContent({
      model,
      contents: this._convertContents(messages),
      config: this._buildConfig({ system, temperature, schema, maxTokens, model }),
    });
    const text = resp.text || '';
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      // Gemini 偶尔会在 JSON 外裹 ```json ... ``` 兜底
      const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
      return JSON.parse(cleaned);
    }
  }
}

module.exports = GeminiProvider;
