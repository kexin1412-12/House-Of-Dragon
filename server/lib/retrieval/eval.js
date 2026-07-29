function recallAtK(returnedIds, expectedIds, k = 8) {
  if (!expectedIds || expectedIds.length === 0) return 1;
  const top = new Set((returnedIds || []).slice(0, k));
  const hits = expectedIds.filter(id => top.has(id)).length;
  return hits / expectedIds.length;
}

function leakCount(returnedIds, mustNotIds) {
  const forbidden = new Set(mustNotIds || []);
  return (returnedIds || []).filter(id => forbidden.has(id)).length;
}

async function evaluate(questions, retrieveFn, k = 8) {
  let recallSum = 0, leaks = 0;
  const perQuestion = [];
  for (const q of questions) {
    const ids = await retrieveFn(q);
    const recall = recallAtK(ids, q.expected_ids, k);
    const leak = leakCount(ids, q.must_not_recall_ids);
    recallSum += recall; leaks += leak;
    perQuestion.push({ id: q.id, recall, leak });
  }
  return { recall: questions.length ? recallSum / questions.length : 1, leaks, perQuestion };
}

module.exports = { recallAtK, leakCount, evaluate };
