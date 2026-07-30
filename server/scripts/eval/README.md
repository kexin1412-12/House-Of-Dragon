# 项目评测集（eval suite）

一条命令跑完三个维度的评测，产出一份自包含的 HTML 报告。

```bash
node scripts/eval/run_eval.js              # 跑全部三维，回答质量命中缓存则复用
node scripts/eval/run_eval.js --refresh    # 重新生成 + 重新评分（忽略回答缓存）
node scripts/eval/run_eval.js --skip-llm   # 只跑确定性维度（①③），不调模型
node scripts/eval/run_eval.js --out foo.html
```

产出：
- `server/eval-report.html` —— 浏览器直接打开的可视化报告
- `server/eval-report.json` —— 原始指标（便于 CI / diff）

## 三个维度

### ① 检索召回 recall@k（确定性）
在真实的「时序防剧透过滤 + 混合（向量 × 关键词）」检索链路上，衡量应被召回的知识块是否进入 Top-k。

- 数据集：`datasets/retrieval.json`，30 题，覆盖 6 种 knowledge_type × 两集（S1E5 / S3E1）。
- `expected_ids` / `must_not_recall_ids` 都是构建好的向量索引里的真实 chunk id。
- 查询向量会被**预计算并持久化**到 `.cache/query_embeddings.json`，因此 dense 路径必然生效、且结果可复现（不受代理网络抖动影响；否则 `retrieve()` 会静默降级到关键词）。
- 指标：整体 recall@k、MRR、按类型分组召回、逐题命中/未命中、越界泄漏数（硬约束，应为 0）。

### ② 回答质量（真实 LLM 生成 + LLM 裁判）
在主动问答链路上生成回答，再由裁判模型**仅依据生成时可见的、已按进度过滤的上下文**打分。

- 数据集：`datasets/answers.json`，12 个观众提问。
- 上下文重建：spoiler-safe `retrieve()` 知识 + 当前 cursor 过滤后的场景切片 + 在场关系。
- 评分维度（各 1–5）：忠实度（有无编造）、有用性（是否切题具体）、无剧透（有无引入超前信息）。
- 结果缓存到 `.cache/answers.json`，按输入哈希去重；重跑默认复用，`--refresh` 才重打。无 API key 时该维度整体 skipped。

### ③ 人脸识别（确定性 leave-one-out）
对角色库中每条 ArcFace 特征做留一验证，完全复刻线上 `face_service.py` 的匹配决策（best-per-group → 阈值 0.45 → Top1−Top2 间隔 0.05），不需要模型或运行服务。

- 指标：闭集 Top-1 准确率、误识率（认成别人，最危险）、拒识率、下判断时的准确率、按角色分解、混淆对。
- 说明：留一验证对「只有 1 条参考」的角色天然偏严（被留出时缺同人对照），这本身也反映线上「参考太少识别不稳」的真实风险。

## 目录

```
scripts/eval/
  run_eval.js            # 入口：编排三维 + 渲染报告
  datasets/
    retrieval.json       # ① 30 题
    answers.json         # ② 12 题
  lib/
    retrieval_eval.js    # ① 召回 + 预热查询向量缓存
    answer_eval.js       # ② 生成 + 裁判 + 缓存
    face_eval.js         # ③ LOO 匹配
    report.js            # HTML 渲染
  .cache/                # 查询向量 / 回答评分缓存（可安全删除后重算）
```
