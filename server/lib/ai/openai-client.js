function createOpenAIClient(options = {}) {
  const OpenAI = require('openai');
  const proxyUrl = process.env.OPENAI_PROXY_URL?.trim();

  if (!proxyUrl) return new OpenAI(options);

  const { fetch, ProxyAgent } = require('undici');
  const dispatcher = new ProxyAgent(proxyUrl);
  return new OpenAI({
    ...options,
    fetch: (url, init = {}) => fetch(url, { ...init, dispatcher }),
  });
}

module.exports = { createOpenAIClient };
