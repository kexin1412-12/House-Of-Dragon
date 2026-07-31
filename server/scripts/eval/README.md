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

## 人工标注工作流（扩样本 + 事实性/相关性地面真值）

自动指标之外，用人工标注建立更大、去单人偏差的地面真值。三个轴：检索**分级相关性**、回答**事实性**、回答**有用性**。

```bash
node scripts/eval/build_annotation.js         # 跑 54 检索 + 生成 40 回答 → server/eval-annotate.html
# 浏览器打开 eval-annotate.html，逐条标注（localStorage 自动存），点「导出」下载 eval-annotations.json
node scripts/eval/score_annotations.js <下载的 eval-annotations.json>   # → annotation-scores.json + 控制台汇总
```

- 题库：`datasets/annotate_retrieval.json`（54 题，5 类 × 两集）、`datasets/annotate_answers.json`（40 题，5 种 prompt × 两集）。
- 检索相关性是**分级**的（核心=2 / 相关=1 / 无关=0），所以算的是 **nDCG@k + precision@k + 命中率**，不是单 gold recall——修掉了"我猜的单个正确答案"那种评测偏严。
- 回答事实性给出**完全正确率**（事实准确率）和**编造/错误率**（幻觉率），是"忠于上下文"之外真正的事实校验；有用性单独一轴。
- 构建器对代理抽风有韧性：向量预热 6 路并发 + 重试，失败的查询自动降级关键词检索；回答生成也带重试。已嵌入的向量持久化到 `.cache/query_embeddings.json`，重跑更快。

## 三个维度

### ① 检索召回 recall@k（确定性）
在真实的「时序防剧透过滤 + 混合（向量 × 关键词）」检索链路上，衡量应被召回的知识块是否进入 Top-k。

- 数据集：`datasets/retrieval.json`，30 题，覆盖 6 种 knowledge_type × 两集（S1E5 / S3E1）。
- `expected_ids` / `must_not_recall_ids` 都是构建好的向量索引里的真实 chunk id。
- 查询向量会被**预计算并持久化**到 `.cache/query_embeddings.json`，因此 dense 路径必然生效、且结果可复现（不受代理网络抖动影响；否则 `retrieve()` 会静默降级到关键词）。
- 指标：整体 recall@k、MRR、按类型分组召回、逐题命中/未命中、越界泄漏数（硬约束，应为 0）。

### ② 回答质量（真实 LLM 生成 + LLM 裁判）
在主动问答链路上生成回答，再由裁判模型**仅依据生成时可见的、已按进度过滤的上下文**打分。

- 数据集：`datasets/answers.json`，主打**最常用的快捷提问「解释这个镜头」**（客户端 QUICK_QUESTIONS 里观众最常点的那个），在全集多个场景点各问一次，测的是日常主路径而不是刻意难题；另留几个别的快捷提问做覆盖。
- 裁判 rubric：通用世界观背景/历史设定不算编造、不算剧透（LLM 适度发挥是预期行为），只惩罚虚构具体剧情或透露未来事件。改 rubric 后可用 `--rejudge` 复用已缓存回答只重评分。
- 上下文重建：spoiler-safe `retrieve()` 知识 + 当前 cursor 过滤后的场景切片 + 在场关系。
- 评分维度（各 1–5）：忠实度（有无编造）、有用性（是否切题具体）、无剧透（有无引入超前信息）。
- 结果缓存到 `.cache/answers.json`，按输入哈希去重；重跑默认复用，`--refresh` 才重打。无 API key 时该维度整体 skipped。

### ③ 人脸识别 · 真实剧集截图（Gemini Pro 生产链路）
旧的 ArcFace 闭集服务已整体下线（库内向量不可分，真实帧识别率仅 7.5%，评测细节见 git 历史）。人脸识别全量切到 **Gemini Pro 多模态**（`server/lib/face-recognition.js`，router task `face_recognition`，默认 `gemini-3.1-pro-preview`）——评测跑的就是生产同一份代码。

- 输入：本集 53 张真实人脸截图（`datasets/face_frames/*.jpg`，已随仓库提交）+ 一张人工核实的清晰韦赛里斯正脸探针。
- 指标：识别率、拒识率（识别 prompt 要求低置信不猜，拒识是设计行为）、**已核实子集准确率**（manifest 里带 `verified_character_id` 的帧，身份经人工比对官方肖像确认）、探针正误。
- LLM 调用缓存到 `.cache/face_llm.json`（按 文件哈希+模型 去重），重跑读缓存，`--refresh` 才重打；无 key 时该维度 skipped。
- 说明：KB 的 `characters_on_screen` 自动标注不可靠（同一张脸标成两个人、片头帧标成角色），不能当逐帧 ground truth——所以准确率只在人工核实过的子集上计算，未核实帧只计入识别率。

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
