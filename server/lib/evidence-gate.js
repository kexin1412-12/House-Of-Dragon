// Evidence Gate — 判断当前检索到的证据是否足够回答用户问题。
// 不足时返回补充检索的 query，让 agent loop 继续检索。
// 用 GPT-4o-mini（快、便宜），maxTokens=200，temperature=0。

const MAX_ROUNDS = 2;

const GATE_ELIGIBLE_INTENTS = new Set(['character', 'plot', 'foreshadow']);

const ASSESS_SYSTEM = `你是一个证据充分性裁判。给定用户关于电视剧的问题和已检索到的知识块，判断证据是否足够生成高质量回答。

输出严格 JSON（不要 markdown 包裹）：
{
  "sufficient": true/false,
  "character_identified": true/false,
  "event_identified": true/false,
  "causal_evidence": true/false,
  "temporal_grounded": true/false,
  "missing": "缺少什么（一句话）",
  "supplementary_query": "用于补充检索的中文 query（10-20字）"
}

判断标准：
- character_identified：问题涉及的人物是否在证据中出现且身份明确
- event_identified：问题涉及的事件是否在证据中有具体描述
- causal_evidence：如果问题问"为什么"，因果链是否完整（有前因）
- temporal_grounded：事件的时间/顺序是否清楚

只要有一个维度为 false 且该维度与问题相关，sufficient 就是 false。
supplementary_query 应该针对缺失的维度，用于检索补充证据。`;

function shouldGate(intent, round) {
  if (round >= MAX_ROUNDS) return false;
  return GATE_ELIGIBLE_INTENTS.has(intent);
}

async function assessEvidence(question, retrievedKnowledge, intent, ai) {
  const evidenceSummary = (retrievedKnowledge || [])
    .slice(0, 12)
    .map((e, i) => `[${i + 1}] (${e.knowledge_type || 'unknown'}) ${String(e.content || '').slice(0, 150)}`)
    .join('\n');

  const user = `用户问题：${question}\n意图类型：${intent}\n\n已检索到的证据：\n${evidenceSummary || '（无）'}`;

  try {
    const result = await ai.chat({
      task: 'chat',
      system: ASSESS_SYSTEM,
      messages: [{ role: 'user', content: user }],
      maxTokens: 200,
      temperature: 0,
    });

    const text = typeof result === 'string' ? result : (result?.text || result?.content || '');
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      sufficient: !!parsed.sufficient,
      character_identified: parsed.character_identified !== false,
      event_identified: parsed.event_identified !== false,
      causal_evidence: parsed.causal_evidence !== false,
      temporal_grounded: parsed.temporal_grounded !== false,
      missing: parsed.missing || null,
      supplementary_query: parsed.supplementary_query || null,
    };
  } catch (err) {
    console.error('[evidence-gate] assess failed:', err.message);
    return { sufficient: true, missing: null, supplementary_query: null };
  }
}

module.exports = { shouldGate, assessEvidence, MAX_ROUNDS };
