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

- 数据集：`datasets/answers.json`，主打**最常用的快捷提问「解释这个镜头」**（客户端 QUICK_QUESTIONS 里观众最常点的那个），在全集多个场景点各问一次，测的是日常主路径而不是刻意难题；另留几个别的快捷提问做覆盖。
- 裁判 rubric：通用世界观背景/历史设定不算编造、不算剧透（LLM 适度发挥是预期行为），只惩罚虚构具体剧情或透露未来事件。改 rubric 后可用 `--rejudge` 复用已缓存回答只重评分。
- 上下文重建：spoiler-safe `retrieve()` 知识 + 当前 cursor 过滤后的场景切片 + 在场关系。
- 评分维度（各 1–5）：忠实度（有无编造）、有用性（是否切题具体）、无剧透（有无引入超前信息）。
- 结果缓存到 `.cache/answers.json`，按输入哈希去重；重跑默认复用，`--refresh` 才重打。无 API key 时该维度整体 skipped。

### ③a 人脸识别 · 真实剧集截图（走真正的 ArcFace 服务）
把本集检测到的 53 张人脸截图（`datasets/face_frames/*.jpg`，已随仓库提交）送进真正的 `face_service.py` 识别，测"用剧里清晰截图识别"到底行不行。

- 指标：真实帧识别率、拒识率、平均 Top1 相似度、**候选身份坍缩**（多少张不同的脸挤到同几个身份上）。外加一张人工核实的清晰韦赛里斯正脸作为标注探针。
- 结论（当前库）：只认出 4/53（7.5%），53 张不同的脸里 44 张 Top-1 都坍缩到 rhaenys@~0.8；清晰的韦赛里斯正脸里韦赛里斯根本不在 Top-3——**现网人脸库在真实画面上基本失效**，根因是库内特征向量不可分（每人参考帧太少 + 疑似对齐/归一化问题）。
- 需要人脸服务在跑（本机用 conda env）：
  ```bash
  conda create -n hotd-face python=3.11 -y
  conda run -n hotd-face pip install -r face-service/requirements.txt   # 或见该文件的固定版本
  conda run -n hotd-face python server/scripts/face_service.py          # 起在 127.0.0.1:5001
  ```
  服务没起时该维度自动 skipped（不影响①②③b）。

### ③b 人脸识别 · 角色库闭集分离度（确定性 leave-one-out）
对角色库中每条 ArcFace 特征做留一验证，复刻线上匹配决策（阈值 0.45 → Top1−Top2 间隔 0.05），不需要服务。衡量**库本身的可分性**，是③a 结论的离线佐证（top1 32%、拒识 52%）。

- 说明：本集 KB 的 `characters_on_screen` 自动标注不可靠（同一张脸标成两个人、片头帧标成角色），不能当逐帧 ground truth，所以③a 用"识别率 + 候选坍缩 + 单张标注探针"这类不依赖逐帧标注的指标来量化。

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
