#!/usr/bin/env node
// Reads the human labels exported from eval-annotate.html and computes the annotation-based
// metrics. Retrieval labels are GRADED relevance on the returned chunks (核心=2 相关=1 无关=0),
// so the right metric is nDCG@k over the returned order (plus precision@k and hit rates).
// Answer labels give factuality accuracy and a helpfulness distribution.
//
//   node scripts/eval/score_annotations.js <path-to-eval-annotations.json>
//
// Writes <same-dir>/annotation-scores.json and prints a summary.
const fs = require('fs');
const path = require('path');

function dcg(gains) { return gains.reduce((s, g, i) => s + g / Math.log2(i + 2), 0); }

function scoreRetrieval(items) {
  const done = items.filter(it => it.done);
  let ndcgSum = 0, precSum = 0, anyRel = 0, coreHit = 0, rrSum = 0;
  const perType = {};
  for (const it of done) {
    // The annotation UI only stores labels for chunks the annotator saw (the returned top-k).
    const gains = Object.values(it.labels || {}).map(Number);
    const ideal = [...gains].sort((a, b) => b - a);
    const nd = dcg(ideal) > 0 ? dcg(gains) / dcg(ideal) : 1; // all-irrelevant → 1 (nothing to order)
    const rel = gains.filter(g => g >= 1).length;
    const prec = gains.length ? rel / gains.length : 0;
    const firstRel = gains.findIndex(g => g >= 1);
    ndcgSum += nd; precSum += prec; anyRel += rel > 0 ? 1 : 0;
    coreHit += gains.some(g => g >= 2) ? 1 : 0;
    rrSum += firstRel >= 0 ? 1 / (firstRel + 1) : 0;
    const t = it.knowledge_type || 'unknown';
    (perType[t] = perType[t] || { ndcg: 0, n: 0 }).ndcg += nd; perType[t].n += 1;
  }
  const n = done.length || 1;
  return {
    n_annotated: done.length, n_total: items.length,
    ndcg_at_k: ndcgSum / n, precision_at_k: precSum / n,
    any_relevant_rate: anyRel / n, core_hit_rate: coreHit / n, mrr: rrSum / n,
    per_type_ndcg: Object.fromEntries(Object.entries(perType).map(([t, v]) => [t, { ndcg: v.ndcg / v.n, n: v.n }])),
  };
}

function scoreAnswers(items) {
  const judged = items.filter(it => it.factuality);
  const fCount = { ok: 0, minor: 0, bad: 0, na: 0 };
  const hCount = { hi: 0, mid: 0, no: 0, none: 0 };
  for (const it of judged) {
    fCount[it.factuality] = (fCount[it.factuality] || 0) + 1;
    hCount[it.helpfulness || 'none'] = (hCount[it.helpfulness || 'none'] || 0) + 1;
  }
  const decidable = fCount.ok + fCount.minor + fCount.bad; // exclude 无法判断
  const helpDecided = hCount.hi + hCount.mid + hCount.no;
  return {
    n_annotated: judged.length, n_total: items.length,
    factuality: fCount,
    factual_accuracy: decidable ? fCount.ok / decidable : null,          // fully-correct rate
    hallucination_rate: decidable ? fCount.bad / decidable : null,        // has fabrication/error
    helpfulness: hCount,
    helpful_rate: helpDecided ? hCount.hi / helpDecided : null,
  };
}

function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('用法: node scripts/eval/score_annotations.js <eval-annotations.json>');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const retrieval = scoreRetrieval(data.retrieval || []);
  const answers = scoreAnswers(data.answers || []);
  const out = { scoredAt: new Date().toISOString(), source: path.basename(file), retrieval, answers };
  const outPath = path.join(path.dirname(file), 'annotation-scores.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  const pct = x => x == null ? 'n/a' : (x * 100).toFixed(1) + '%';
  console.log('\n=== 检索（人工分级相关性）===');
  console.log(`  已标 ${retrieval.n_annotated}/${retrieval.n_total}`);
  console.log(`  nDCG@k        ${retrieval.ndcg_at_k.toFixed(3)}`);
  console.log(`  precision@k   ${pct(retrieval.precision_at_k)}`);
  console.log(`  有相关命中率   ${pct(retrieval.any_relevant_rate)}   核心命中率 ${pct(retrieval.core_hit_rate)}   MRR ${retrieval.mrr.toFixed(2)}`);
  console.log('  按类型 nDCG:', Object.entries(retrieval.per_type_ndcg).map(([t, v]) => `${t} ${v.ndcg.toFixed(2)}(${v.n})`).join(' · '));
  console.log('\n=== 回答（人工事实性/有用性）===');
  console.log(`  已标 ${answers.n_annotated}/${answers.n_total}`);
  console.log(`  事实完全正确率 ${pct(answers.factual_accuracy)}   编造/错误率 ${pct(answers.hallucination_rate)}`);
  console.log(`  分布 事实:`, answers.factuality, ' 有用:', answers.helpfulness);
  console.log(`\n✓ 写入 ${outPath}`);
}

main();
