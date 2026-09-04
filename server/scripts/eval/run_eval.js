#!/usr/bin/env node
// Project eval suite → single self-contained HTML report.
//
//   node scripts/eval/run_eval.js            # run all three dimensions, reuse answer cache
//   node scripts/eval/run_eval.js --refresh  # re-generate + re-judge answers (ignore cache)
//   node scripts/eval/run_eval.js --skip-llm  # skip dimension ② entirely (fully deterministic)
//   node scripts/eval/run_eval.js --out path.html
//
// Dimensions:
//   ① 检索召回 recall@k   — deterministic (needs API key only for the query embedding)
//   ② 回答质量            — real LLM generate + LLM judge, cached
//   ③ 人脸识别 LOO         — deterministic, offline, no model/service
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const retrievalEval = require('./lib/retrieval_eval');
const answerEval = require('./lib/answer_eval');
const faceFramesEval = require('./lib/face_frames_eval');
const spoilerEval = require('./lib/spoiler_eval');
const report = require('./lib/report');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const rejudge = process.argv.includes('--rejudge');
  const skipLlm = process.argv.includes('--skip-llm');
  const outPath = arg('--out', path.join(__dirname, '..', '..', 'eval-report.html'));

  const dataDir = path.join(__dirname, 'datasets');
  const retrievalSet = JSON.parse(fs.readFileSync(path.join(dataDir, 'retrieval.json'), 'utf8'));
  const answerSet = JSON.parse(fs.readFileSync(path.join(dataDir, 'answers.json'), 'utf8'));

  console.log('▶ ① 检索召回 recall@k …');
  const retrieval = await retrievalEval.run(retrievalSet);
  console.log(`   recall@${retrieval.k}=${(retrieval.recall_at_k * 100).toFixed(1)}%  MRR=${retrieval.mrr.toFixed(2)}  leaks=${retrieval.leaks}`);

  let answer;
  if (skipLlm) {
    answer = { skipped: true, reason: '--skip-llm 已启用', per_question: [] };
    console.log('▶ ② 回答质量 … 跳过 (--skip-llm)');
  } else {
    console.log(`▶ ② 回答质量 (LLM 生成 + 裁判${refresh ? '，忽略缓存' : rejudge ? '，复用回答仅重评分' : '，命中缓存则复用'}) …`);
    answer = await answerEval.run(answerSet, { refresh, rejudge });
    if (answer.skipped) console.log(`   跳过：${answer.reason}`);
    else console.log(`   overall=${answer.avg_overall.toFixed(2)}/5  忠实=${answer.avg_faithfulness.toFixed(2)}  有用=${answer.avg_helpfulness.toFixed(2)}  无剧透=${answer.avg_no_spoiler.toFixed(2)}`);
  }

  console.log('▶ ③ 人脸识别 真实剧集截图（Gemini Pro 生产链路）…');
  const faceFrames = await faceFramesEval.run({ refresh });
  if (faceFrames.skipped) console.log(`   跳过：${faceFrames.reason}`);
  else console.log(`   识别率=${(faceFrames.identified_rate * 100).toFixed(1)}% (${faceFrames.identified}/${faceFrames.total_frames})  已核实子集准确率=${faceFrames.verified.accuracy_when_identified == null ? 'n/a' : (faceFrames.verified.accuracy_when_identified * 100).toFixed(1) + '%'} (${faceFrames.verified.correct}/${faceFrames.verified.identified})  hero=${faceFrames.hero ? (faceFrames.hero.correct ? '✓' : '✗ ' + (faceFrames.hero.predicted || '拒识')) : '-'}`);

  let spoiler;
  if (skipLlm) {
    spoiler = { skipped: true, reason: '--skip-llm 已启用（生成层需要模型）' };
    console.log('▶ ④ 防剧透对抗 … 跳过 (--skip-llm)');
  } else {
    const spoilerSet = JSON.parse(fs.readFileSync(path.join(dataDir, 'spoiler_adversarial.json'), 'utf8'));
    console.log('▶ ④ 防剧透对抗（检索层 + 生成层双重，跨家族裁判）…');
    spoiler = await spoilerEval.run(spoilerSet, { refresh });
    if (spoiler.skipped) console.log(`   跳过：${spoiler.reason}`);
    else console.log(`   检索泄漏=${(spoiler.retrieval_leak_rate * 100).toFixed(1)}%  生成泄漏=${(spoiler.generation_leak_rate * 100).toFixed(1)}%  回避率=${(spoiler.deflection_rate * 100).toFixed(1)}%  误拒=${(spoiler.over_refusal_rate * 100).toFixed(1)}%`);
  }

  const results = {
    retrieval, answer, faceFrames, spoiler,
    meta: {
      show: retrievalSet.showId,
      generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      retrievalMode: process.env.OPENAI_API_KEY ? '混合（向量 × 关键词）+ 时序过滤' : '关键词 + 时序过滤（无向量）',
    },
  };

  const html = report.render(results);
  fs.writeFileSync(outPath, html, 'utf8');

  // Also drop the raw metrics next to the report for CI / diffing.
  const jsonPath = outPath.replace(/\.html$/, '') + '.json';
  const slim = {
    ...results,
    answer: results.answer.skipped ? results.answer
      : { ...results.answer, per_question: results.answer.per_question.map(q => ({ id: q.id, judgment: q.judgment })) },
    faceFrames: results.faceFrames.skipped ? results.faceFrames
      : { ...results.faceFrames, samples: undefined, hero: results.faceFrames.hero ? { ...results.faceFrames.hero, thumb: undefined } : null },
    spoiler: results.spoiler.skipped ? results.spoiler
      : { ...results.spoiler, rows: results.spoiler.rows.map(r => ({ id: r.id, bait_type: r.bait_type, is_control: r.is_control, retrieval_leaked: r.retrieval_leaked, gen: r.gen })) },
  };
  fs.writeFileSync(jsonPath, JSON.stringify(slim, null, 2), 'utf8');

  console.log(`\n✓ 报告已生成：${outPath}`);
  console.log(`  原始指标：${jsonPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
