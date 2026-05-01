# 文化梗卡片 + AgentPanel 增强 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 4 hand-curated dialogue meme cards on `house_of_dragon_05` with in-player overlay (mask + golden keyword highlight + hover popover) and right-rail tab (list + Tier 3 detail), plus enhance the AgentPanel system prompt to actively look for the "second layer" of meaning when answering user questions.

**Architecture:** Backend serves a static JSON (already written, 4 cards) via a thin endpoint. Frontend has two new components: an in-player overlay that activates only during the 4 riff time windows (~10s each), and a right-rail tab that shows the full list + accordion-expanded Tier 3 detail. AgentPanel gets one inserted prompt section + 4 few-shot examples drawn from the same 4 cards.

**Tech Stack:** React 18 (CRA, hooks-only), Express 4, plain CSS (no framework), Node/CommonJS server, fetch for HTTP. No test runner is configured for this project — verification is manual per spec §6.

**Spec:** `docs/superpowers/specs/2026-05-01-dialogue-riffs-design.md`

**Data already in place:** `server/kb/dialogue_riffs/house-of-the-dragon.json` (4 riffs, all fields populated)

---

## File Structure

**New files:**
- `client/src/MemeOverlay.js` — in-player overlay (mask + HTML subtitle + golden highlight + popover trigger)
- `client/src/MemeOverlay.css` — overlay styling (gradient mask, golden box, popover bubble)
- `client/src/MemePanel.js` — right-rail tab content (list + accordion Tier 3 expansion)
- `client/src/MemePanel.css` — panel styling (list cards, expanded detail card)
- `client/src/MemeToggle.js` — top-right master switch (localStorage-backed)

**Modified files:**
- `server/index.js` — add `GET /api/riffs?videoId=...` endpoint (~20 lines)
- `server/agent.js` — insert one new section into `VISION_SYSTEM_PROMPT` between the existing "回答重点" and "解读角度" sections (~50 lines added, no existing lines changed)
- `client/src/App.js` — add `rightTab` state, render tab row in `<aside class="tx-right">`, mount `<MemeOverlay>` and `<MemeToggle>` in player wrap, wire `onExpandRequest` callback
- `client/src/App.css` — tab-row styles (~30 lines added)

---

## Task 1: Backend — `GET /api/riffs` endpoint

**Files:**
- Modify: `server/index.js` (insert ~20 lines before `app.listen(...)` near line 162)

- [ ] **Step 1: Add the endpoint**

Insert this block in `server/index.js` immediately after the `app.delete('/api/videos/:filename', ...)` handler (around line 160), before `app.listen(...)`:

```javascript
// 文化梗 / Dialogue Riffs —— 静态 KB 直出。
// 扫 server/kb/dialogue_riffs/*.json，flatMap 所有 riffs，按 video_id 过滤。
// 内存缓存：进程内一次性加载，重启失效（demo 不需要 hot-reload）。
let _riffsCache = null;
function loadRiffs() {
  if (_riffsCache) return _riffsCache;
  const dir = path.join(__dirname, 'kb', 'dialogue_riffs');
  const all = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const r of (j.riffs || [])) all.push(r);
      } catch (e) {
        console.warn(`[riffs] skip bad file ${f}:`, e.message);
      }
    }
  }
  _riffsCache = all;
  return all;
}

app.get('/api/riffs', (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  const riffs = loadRiffs()
    .filter(r => r.video_id === videoId)
    .sort((a, b) => (a.anchor?.start_time || 0) - (b.anchor?.start_time || 0));
  res.json({ video_id: videoId, count: riffs.length, riffs });
});
```

- [ ] **Step 2: Restart server and verify with curl**

Stop and restart the dev server (`npm start` in `server/` or however dev runs it).

Run:
```bash
curl -s "http://localhost:5000/api/riffs?videoId=house_of_dragon_05" | head -c 500
```

Expected: JSON starting with `{"video_id":"house_of_dragon_05","count":4,"riffs":[{"riff_id":"moon_tea_innuendo_e05",...`. If you see `count: 0`, the JSON file isn't being loaded — check the path.

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:5000/api/riffs"
```

Expected: `400` (because no videoId).

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "api: add GET /api/riffs serving static dialogue_riffs KB"
```

---

## Task 2: AgentPanel — insert "看见第二层" prompt section

**Files:**
- Modify: `server/agent.js` line 1424 (insert new section between existing "回答重点" and "解读角度" blocks)

- [ ] **Step 1: Locate the insertion point**

Open `server/agent.js`. Find the line that contains exactly:

```
═══ 解读角度（按需融入，不强行）═══
```

(should be around line 1425). The new section goes **immediately before** this line.

- [ ] **Step 2: Insert the new section**

Use Edit tool. The `old_string` is the existing line we found in step 1; the `new_string` prepends the new section before it.

`old_string`:
```
═══ 解读角度（按需融入，不强行）═══
```

`new_string`:
```
═══ 看见"第二层"的本能 ═══
回答前花一秒判断：这句话/这场戏的表面意思是什么、有没有藏第二层？

第二层常见几种形式：
- 反讽：说出来的话和场面里发生的事相反（婚礼誓词"无论将来如何"——而将来正在外面发生）
- 双关 / 隐喻：字面之外另有所指（"茶"不是茶，是 moon tea）
- 角色弧压缩：一句话浓缩整条命运（"我就是王冠"——把 Criston 的"为爱不为王冠"整条路堵死）
- 演员高光：这句话是某个演员的封神瞬间，值得点出
- 元层级：嵌入剧集自身的设定（"传唱百年的歌"——剧名就是 A Song of Ice and Fire）

有第二层就先说它，表面意思一句带过或跳过。没有就老实答场面分析，不硬挖。

风格示例（这是好回答的样子，不是模板）：

例 1：用户问"Larys 这'茶'什么意思"
→ "Larys 嘴里这'茶'不是普通的茶——是 moon tea，月亮茶，维斯特洛的堕胎药。
   他在向阿莉森特暗示雷妮拉那一晚的私情，但用了宫廷里能装糊涂的措辞。
   一旦阿莉森特消化清楚'茶'指的是什么，她就被默认参与了这场政治流言。"

例 2：用户问"Laenor 在说什么"（餐桌上"我更喜欢烤鸭"那场）
→ "Laenor 用'喜欢烤鸭还是烤鹅'委婉出柜。
   维多利亚到中世纪欧洲贵族用食物隐喻指性偏好的传统在这里被复刻——
   'goose'对应他的真实取向，'duck'是他必须履行的婚姻义务。
   雷妮拉听懂了，没戳破，反过来用同一种委婉语回应他。"

例 3：用户问"Rhaenyra 为什么那么狠"（"我就是王冠"那场）
→ "她这一句不是耍嘴皮——是把 Criston 提议的'为爱不为王冠'那条路当场堵死。
   不是在拒绝爱情，是在拒绝'自己可以不是王冠'这个前提。
   从这一刻起 Criston 从骑士变成怨夫——绿党后续最锋利的那把剑，种子就在这里。"

例 4：用户问"韦赛里斯刚才那段独白什么意思"
→ "Paddy Considine 整季演技顶点。
   一个自知不配伟大、却仍想被记住的国王，用'作不成传唱百年的歌'概括自己一生。
   最辛辣的是：他死后爆发的'龙之舞'内战，恰恰会成为传唱百年的史诗——
   也就是观众正在看的这部剧。"

═══ 解读角度（按需融入，不强行）═══
```

- [ ] **Step 3: Verify the insertion didn't break the surrounding text**

Open `server/agent.js`, jump to line 1424 area. Confirm:
- The `═══ 回答重点 ═══` block ending with "...这段对当前权力关系有什么影响" is intact.
- Immediately after, the new `═══ 看见"第二层"的本能 ═══` block is present with all 4 examples.
- After the new block, the existing `═══ 解读角度（按需融入，不强行）═══` block continues unchanged with the six angles.

If the file got mangled (e.g., examples merged into one line, indentation lost), revert and re-edit.

- [ ] **Step 4: Smoke-test the AgentPanel**

Restart the server. In the browser, play `house_of_dragon_05`, pause near `25:30` (the "I am the crown" scene), and ask the AgentPanel: "她这一句什么意思？".

Expected: response includes "second-layer" framing — refers to Criston's preceding "for love, not for the crown" line, mentions character arc compression, doesn't just summarize the surface scene. If the response is still surface-level only, the prompt insertion may not have taken effect (check for caching or that the server actually restarted).

- [ ] **Step 5: Commit**

```bash
git add server/agent.js
git commit -m "agent: add '看见第二层' instruction + 4 few-shot examples to vision_chat prompt"
```

---

## Task 3: App.js — `rightTab` state + tab row UI

**Files:**
- Modify: `client/src/App.js` (add state in `TencentPlayer`, render tab row in the `<aside class="tx-right">`)
- Modify: `client/src/App.css` (add tab-row styles)

- [ ] **Step 1: Add `rightTab` state to `TencentPlayer`**

Find this block in `App.js` (around line 154):
```javascript
  const [aiChatOpen, setAiChatOpen] = useState(false);
```

Immediately after that line, add:
```javascript
  // 右栏 tab：'agent'（AI 助手）| 'meme'（文化梗）
  const [rightTab, setRightTab] = useState('agent');
  // 当 MemeOverlay 触发"展开详情"时，设置这个 id；MemePanel 监听后自动展开 + 滚动
  const [pendingExpandRiffId, setPendingExpandRiffId] = useState(null);
```

- [ ] **Step 2: Wrap `<AgentPanel>` in tab structure inside `<aside class="tx-right">`**

Find this block in `App.js` (around line 953-977):
```javascript
        {/* Right info panel */}
        <aside className="tx-right">
          <div className="tx-title-row">
            <h1 className="tx-title" title={playing.name}>{playing.name || '未选择视频'}</h1>
            {episodeTag(playing.filename) && (
              <span className="tx-lang">{episodeTag(playing.filename)}</span>
            )}
            <span className="conspirator-badge" title="共谋者 · Co-Conspirator">
              共谋者
            </span>
          </div>

          <AgentPanel
            behavior={aiBehavior}
            messages={aiMessages}
            input={aiInput}
            setInput={setAiInput}
            sending={aiSending}
            onSubmit={submitAiQuestion}
            logRef={aiLogRef}
            depth={aiDepth}
            setDepth={setAiDepth}
            onClear={clearAiMessages}
          />
        </aside>
```

Replace it with:
```javascript
        {/* Right info panel */}
        <aside className="tx-right">
          <div className="tx-title-row">
            <h1 className="tx-title" title={playing.name}>{playing.name || '未选择视频'}</h1>
            {episodeTag(playing.filename) && (
              <span className="tx-lang">{episodeTag(playing.filename)}</span>
            )}
            <span className="conspirator-badge" title="共谋者 · Co-Conspirator">
              共谋者
            </span>
          </div>

          {/* 右栏 tab 切换 */}
          <div className="tx-right-tabs">
            <button
              className={`tx-right-tab${rightTab === 'agent' ? ' is-active' : ''}`}
              onClick={() => setRightTab('agent')}
            >AI 助手</button>
            <button
              className={`tx-right-tab${rightTab === 'meme' ? ' is-active' : ''}`}
              onClick={() => setRightTab('meme')}
            >文化梗</button>
          </div>

          {rightTab === 'agent' && (
            <AgentPanel
              behavior={aiBehavior}
              messages={aiMessages}
              input={aiInput}
              setInput={setAiInput}
              sending={aiSending}
              onSubmit={submitAiQuestion}
              logRef={aiLogRef}
              depth={aiDepth}
              setDepth={setAiDepth}
              onClear={clearAiMessages}
            />
          )}
          {rightTab === 'meme' && (
            <div style={{ padding: 16, color: '#888' }}>
              文化梗面板待接入（Task 4-6）
            </div>
          )}
        </aside>
```

- [ ] **Step 3: Add tab styles to `App.css`**

Open `client/src/App.css`. Append at the end of the file:

```css
/* ─── 右栏 tab 切换 ─────────────────────────────────── */
.tx-right-tabs {
  display: flex;
  gap: 4px;
  padding: 0 12px;
  margin-bottom: 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.tx-right-tab {
  appearance: none;
  background: transparent;
  border: 0;
  padding: 10px 14px;
  color: rgba(255, 255, 255, 0.5);
  font-size: 13px;
  cursor: pointer;
  position: relative;
  transition: color 120ms ease;
}

.tx-right-tab:hover {
  color: rgba(255, 255, 255, 0.85);
}

.tx-right-tab.is-active {
  color: #f3c97a;
}

.tx-right-tab.is-active::after {
  content: '';
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: -1px;
  height: 2px;
  background: #f3c97a;
}
```

- [ ] **Step 4: Verify in browser**

Restart client (CRA hot-reloads — should be automatic). Open the player. Confirm:
- A tab row with "AI 助手 | 文化梗" appears between the title row and the AgentPanel.
- Default tab is "AI 助手" (gold underline), AgentPanel shows.
- Click "文化梗": underline moves, AgentPanel hides, placeholder text "文化梗面板待接入（Task 4-6）" shows.
- Click back to "AI 助手": AgentPanel returns. **Critical**: the chat history (if any) should still be there — this verifies state lifting is intact.

- [ ] **Step 5: Commit**

```bash
git add client/src/App.js client/src/App.css
git commit -m "ui: add tab row to right rail (AI 助手 | 文化梗), placeholder for meme panel"
```

---

## Task 4: MemePanel — list view (no expansion yet)

**Files:**
- Create: `client/src/MemePanel.js`
- Create: `client/src/MemePanel.css`

- [ ] **Step 1: Create `MemePanel.js` skeleton**

Create file `client/src/MemePanel.js` with:

```javascript
import React, { useEffect, useRef, useState } from 'react';
import './MemePanel.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// mm:ss 格式化（ceil 到整秒，前导零）
function formatMMSS(seconds) {
  const s = Math.floor(seconds);
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

export default function MemePanel({ videoId, videoRef, expandRiffId, onConsumeExpand }) {
  const [riffs, setRiffs] = useState([]);
  const [openId, setOpenId] = useState(null);
  const itemRefs = useRef({}); // riff_id -> DOM node

  useEffect(() => {
    if (!videoId) { setRiffs([]); return; }
    fetch(`${API}/api/riffs?videoId=${encodeURIComponent(videoId)}`)
      .then(r => r.json())
      .then(data => setRiffs(data.riffs || []))
      .catch(() => setRiffs([]));
  }, [videoId]);

  // MemeOverlay 触发"展开详情"时：自动滚动到对应条目并展开
  useEffect(() => {
    if (!expandRiffId) return;
    setOpenId(expandRiffId);
    const node = itemRefs.current[expandRiffId];
    if (node && node.scrollIntoView) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    onConsumeExpand && onConsumeExpand();
  }, [expandRiffId, onConsumeExpand]);

  const jumpTo = (t) => {
    const v = videoRef && videoRef.current;
    if (v) v.currentTime = t;
  };

  if (riffs.length === 0) {
    return (
      <div className="mp-empty">本集无文化梗</div>
    );
  }

  return (
    <div className="mp-root">
      <div className="mp-header">
        本集检测到 <strong>{riffs.length}</strong> 个文化梗
      </div>
      <div className="mp-list">
        {riffs.map((r, i) => {
          const isOpen = openId === r.riff_id;
          return (
            <div
              key={r.riff_id}
              ref={el => { if (el) itemRefs.current[r.riff_id] = el; }}
              className={`mp-item${isOpen ? ' is-open' : ''}`}
            >
              <button
                className="mp-item-head"
                onClick={() => setOpenId(isOpen ? null : r.riff_id)}
              >
                <span className="mp-item-num">{i + 1}</span>
                {r.anchor && r.anchor.keyframe && (
                  <img
                    className="mp-item-thumb"
                    src={`${API}/${r.anchor.keyframe}`}
                    alt=""
                  />
                )}
                <div className="mp-item-body">
                  <div className="mp-item-quote">
                    "{(r.anchor && r.anchor.subtitle_en) || ''}"
                  </div>
                  <div className="mp-item-meta">
                    <span className="mp-item-time">
                      {r.anchor ? formatMMSS(r.anchor.start_time) : ''}
                    </span>
                    {(r.tags || []).map(t => (
                      <span key={t} className="mp-tag">{t}</span>
                    ))}
                  </div>
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `MemePanel.css`**

Create file `client/src/MemePanel.css` with:

```css
/* ─── MemePanel — 文化梗右栏面板 ────────────────── */

.mp-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: 4px 12px 24px;
  color: #ddd;
  font-size: 13px;
}

.mp-empty {
  padding: 24px 16px;
  color: rgba(255, 255, 255, 0.4);
  font-size: 13px;
  text-align: center;
}

.mp-header {
  padding: 8px 4px 16px;
  color: rgba(255, 255, 255, 0.55);
  font-size: 12px;
}

.mp-header strong {
  color: #f3c97a;
  font-weight: 600;
}

.mp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mp-item {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  overflow: hidden;
  transition: border-color 120ms ease, background 120ms ease;
}

.mp-item:hover {
  border-color: rgba(243, 201, 122, 0.3);
}

.mp-item.is-open {
  border-color: rgba(243, 201, 122, 0.55);
  background: rgba(243, 201, 122, 0.04);
}

.mp-item-head {
  appearance: none;
  background: transparent;
  border: 0;
  width: 100%;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px;
  cursor: pointer;
  text-align: left;
  color: inherit;
}

.mp-item-num {
  flex: 0 0 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(243, 201, 122, 0.15);
  color: #f3c97a;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mp-item-thumb {
  flex: 0 0 80px;
  width: 80px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  background: #111;
}

.mp-item-body {
  flex: 1 1 auto;
  min-width: 0;
}

.mp-item-quote {
  font-size: 13px;
  color: #f0e6d2;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.mp-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}

.mp-item-time {
  color: #f3c97a;
  font-variant-numeric: tabular-nums;
}

.mp-tag {
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(243, 201, 122, 0.12);
  color: rgba(243, 201, 122, 0.85);
  font-size: 10px;
}
```

- [ ] **Step 3: Smoke-test by temporarily wiring it in**

Temporarily edit `App.js` to replace the placeholder with `<MemePanel>`. Find:

```javascript
          {rightTab === 'meme' && (
            <div style={{ padding: 16, color: '#888' }}>
              文化梗面板待接入（Task 4-6）
            </div>
          )}
```

Replace with:
```javascript
          {rightTab === 'meme' && (
            <MemePanel
              videoId={aiKb}
              videoRef={videoRef}
              expandRiffId={pendingExpandRiffId}
              onConsumeExpand={() => setPendingExpandRiffId(null)}
            />
          )}
```

Also at top of `App.js` add the import (right after `import SymbolHotspots ...`):
```javascript
import MemePanel from './MemePanel';
```

- [ ] **Step 4: Verify in browser**

Restart client. Open `house_of_dragon_05`. Click "文化梗" tab. Confirm:
- Header reads "本集检测到 4 个文化梗"
- 4 list items appear, each with: number bubble, thumbnail (~80×48), 1-2 line quote, time `mm:ss`, tags
- Thumbnails render (paths `frames/house_of_dragon_05/scene-146.jpg` etc. should exist; if they 404, double-check the keyframe paths in the JSON match files in `server/kb/frames/house_of_dragon_05/`)
- Click an item: it visually marks "open" (gold border), but no expansion content yet — that's Task 5.

- [ ] **Step 5: Commit**

```bash
git add client/src/MemePanel.js client/src/MemePanel.css client/src/App.js
git commit -m "ui: MemePanel list view (4 riff cards with thumbnail, time, tags)"
```

---

## Task 5: MemePanel — Tier 3 accordion expansion

**Files:**
- Modify: `client/src/MemePanel.js` (add expanded body inside `.mp-item`)
- Modify: `client/src/MemePanel.css` (styles for the expanded card)

- [ ] **Step 1: Add expanded body markup**

In `MemePanel.js`, find the JSX for an item (the `<div className="mp-item">` block). Inside it, after the closing `</button>` of `.mp-item-head`, add the expanded body:

```javascript
              {isOpen && r.tier3 && (
                <div className="mp-item-detail">
                  <div className="mp-detail-quote">
                    <div className="mp-detail-quote-en">
                      "{r.anchor.subtitle_en}"
                    </div>
                    {r.anchor.subtitle_zh && (
                      <div className="mp-detail-quote-zh">
                        {r.anchor.subtitle_zh}
                      </div>
                    )}
                  </div>

                  {r.tier2_punch && (
                    <div className="mp-detail-punch">{r.tier2_punch}</div>
                  )}

                  {r.tier3.why_meme && (
                    <section className="mp-detail-section">
                      <h4>为什么是个梗</h4>
                      <p>{r.tier3.why_meme}</p>
                    </section>
                  )}

                  {Array.isArray(r.tier3.background) && r.tier3.background.length > 0 && (
                    <section className="mp-detail-section">
                      <h4>背景知识</h4>
                      <ul>
                        {r.tier3.background.map((b, idx) => (
                          <li key={idx}>{b}</li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {r.tier3.why_it_matters_now && (
                    <section className="mp-detail-section">
                      <h4>剧情里为什么重要</h4>
                      <p>{r.tier3.why_it_matters_now}</p>
                    </section>
                  )}

                  <div className="mp-detail-actions">
                    <button
                      className="mp-detail-jump"
                      onClick={() => jumpTo(r.anchor.start_time)}
                    >▶ 跳到此处</button>
                  </div>
                </div>
              )}
```

- [ ] **Step 2: Add expanded-body styles to `MemePanel.css`**

Append to `client/src/MemePanel.css`:

```css
/* ─── 展开后的 Tier 3 详情 ─────────────────────── */

.mp-item-detail {
  padding: 4px 14px 14px;
  border-top: 1px solid rgba(243, 201, 122, 0.15);
  font-size: 13px;
  line-height: 1.55;
  color: #d8d8d8;
}

.mp-detail-quote {
  margin: 12px 0;
  padding-left: 10px;
  border-left: 2px solid rgba(243, 201, 122, 0.55);
}

.mp-detail-quote-en {
  font-style: italic;
  color: #f0e6d2;
  font-size: 13px;
}

.mp-detail-quote-zh {
  margin-top: 4px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
}

.mp-detail-punch {
  margin: 12px 0;
  padding: 10px 12px;
  background: rgba(243, 201, 122, 0.06);
  border-radius: 4px;
  color: #f0e6d2;
  font-size: 13px;
}

.mp-detail-section {
  margin: 14px 0;
}

.mp-detail-section h4 {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: #f3c97a;
  letter-spacing: 0.5px;
}

.mp-detail-section p {
  margin: 0;
  color: rgba(255, 255, 255, 0.78);
}

.mp-detail-section ul {
  margin: 0;
  padding-left: 18px;
  color: rgba(255, 255, 255, 0.72);
}

.mp-detail-section li {
  margin: 3px 0;
}

.mp-detail-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.mp-detail-jump {
  appearance: none;
  border: 0;
  padding: 7px 14px;
  background: linear-gradient(180deg, #f3c97a, #e0b160);
  color: #1a1208;
  font-size: 12px;
  font-weight: 600;
  border-radius: 4px;
  cursor: pointer;
}

.mp-detail-jump:hover {
  filter: brightness(1.08);
}
```

- [ ] **Step 3: Verify in browser**

Reload. Switch to "文化梗" tab. Click an item. Confirm:
- The card expands inline (no modal pop)
- Shows: bilingual quote (EN italic + ZH), Tier 2 punch in a tinted box, three labeled sections (为什么是个梗 / 背景知识 / 剧情里为什么重要), gold "▶ 跳到此处" button
- Tags do NOT repeat inside the detail card (per spec — they're already in the list head)
- Click "▶ 跳到此处": video jumps to the riff's start time
- Click the head again: closes; only one item open at a time

- [ ] **Step 4: Commit**

```bash
git add client/src/MemePanel.js client/src/MemePanel.css
git commit -m "ui: MemePanel accordion — Tier 3 detail card (quote, punch, 3 sections, jump button)"
```

---

## Task 6: MemeOverlay — time-window detection + masked subtitle render

**Files:**
- Create: `client/src/MemeOverlay.js`
- Create: `client/src/MemeOverlay.css`

- [ ] **Step 1: Create `MemeOverlay.js` with time-window detection + subtitle render**

Create `client/src/MemeOverlay.js`:

```javascript
import React, { useEffect, useRef, useState } from 'react';
import './MemeOverlay.css';

const API = process.env.REACT_APP_API_URL || 'http://localhost:5000';

// 把 subtitle_en 切成 [前段 | 高亮 | 后段]，找不到关键词就返回 [整句]。
function splitHighlight(text, keyword) {
  if (!text || !keyword) return [{ text: text || '', highlight: false }];
  const idx = text.indexOf(keyword);
  if (idx < 0) return [{ text, highlight: false }];
  const before = text.slice(0, idx);
  const after = text.slice(idx + keyword.length);
  return [
    before && { text: before, highlight: false },
    { text: keyword, highlight: true },
    after && { text: after, highlight: false },
  ].filter(Boolean);
}

export default function MemeOverlay({ videoId, videoRef, enabled = true, onExpandRequest }) {
  const [riffs, setRiffs] = useState([]);
  const [activeRiff, setActiveRiff] = useState(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const hoverCloseTimer = useRef(null);

  useEffect(() => {
    if (!videoId) { setRiffs([]); return; }
    fetch(`${API}/api/riffs?videoId=${encodeURIComponent(videoId)}`)
      .then(r => r.json())
      .then(data => setRiffs(data.riffs || []))
      .catch(() => setRiffs([]));
  }, [videoId]);

  useEffect(() => {
    const v = videoRef && videoRef.current;
    if (!v) return;
    const tick = () => {
      const t = v.currentTime;
      const hit = riffs.find(r =>
        r.anchor && t >= r.anchor.start_time && t <= r.anchor.end_time
      );
      setActiveRiff(prev => {
        if ((prev && prev.riff_id) === (hit && hit.riff_id)) return prev;
        // 切换 riff 时关闭悬停
        setHoverOpen(false);
        return hit || null;
      });
    };
    v.addEventListener('timeupdate', tick);
    tick();
    return () => v.removeEventListener('timeupdate', tick);
  }, [riffs, videoRef]);

  if (!enabled || !activeRiff || !activeRiff.anchor) return null;

  const { subtitle_en, subtitle_zh, highlight } = activeRiff.anchor;
  const parts = splitHighlight(subtitle_en, highlight);

  const onKeywordEnter = () => {
    if (hoverCloseTimer.current) {
      clearTimeout(hoverCloseTimer.current);
      hoverCloseTimer.current = null;
    }
    setHoverOpen(true);
  };
  const onKeywordLeave = () => {
    hoverCloseTimer.current = setTimeout(() => setHoverOpen(false), 100);
  };

  const handleExpand = () => {
    setHoverOpen(false);
    onExpandRequest && onExpandRequest(activeRiff.riff_id);
  };

  return (
    <div className="mo-root">
      {/* 底部蒙板：盖住烧录字幕 */}
      <div className="mo-mask" />

      {/* HTML 字幕 */}
      <div className="mo-subs">
        <div className="mo-sub-en">
          {parts.map((p, i) =>
            p.highlight ? (
              <span
                key={i}
                className="mo-highlight"
                onMouseEnter={onKeywordEnter}
                onMouseLeave={onKeywordLeave}
              >
                {p.text}
                {hoverOpen && (
                  <MemePopover
                    riff={activeRiff}
                    onMouseEnter={onKeywordEnter}
                    onMouseLeave={onKeywordLeave}
                    onExpand={handleExpand}
                  />
                )}
              </span>
            ) : (
              <span key={i}>{p.text}</span>
            )
          )}
        </div>
        {subtitle_zh && (
          <div className="mo-sub-zh">{subtitle_zh}</div>
        )}
      </div>
    </div>
  );
}

function MemePopover({ riff, onMouseEnter, onMouseLeave, onExpand }) {
  return (
    <div
      className="mo-popover"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={e => e.stopPropagation()}
    >
      <div className="mo-popover-head">
        <span className="mo-popover-spark">✦</span>
        <span>文化梗</span>
      </div>
      {riff.tier2_punch && (
        <div className="mo-popover-body">{riff.tier2_punch}</div>
      )}
      <button className="mo-popover-expand" onClick={onExpand}>
        展开详情 ›
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create `MemeOverlay.css`**

Create `client/src/MemeOverlay.css`:

```css
/* ─── MemeOverlay — 画面内梗浮层 ─────────────────── */

.mo-root {
  position: absolute;
  inset: 0;
  pointer-events: none; /* 默认透传给视频；只有具体子元素重新启用 */
  z-index: 18;          /* 高于 SymbolHotspots(15) 和 RelationshipGraph(16)，低于 PlayerControls */
}

/* 底部蒙板：盖住烧录字幕。高度按 1080p 字幕带粗略给。 */
.mo-mask {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 60px; /* 距离底部 60px 起，再向上渐变 */
  height: 110px;
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.92) 0%,
    rgba(0, 0, 0, 0.85) 55%,
    rgba(0, 0, 0, 0) 100%
  );
}

/* HTML 字幕 */
.mo-subs {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 80px;
  text-align: center;
  pointer-events: none;
  user-select: none;
}

.mo-sub-en {
  font-size: 22px;
  line-height: 1.35;
  color: #fff;
  font-weight: 500;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.85);
  margin-bottom: 4px;
}

.mo-sub-zh {
  font-size: 18px;
  color: #f0f0f0;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.85);
}

/* 关键词金色描边 */
.mo-highlight {
  position: relative;
  display: inline-block;
  padding: 0 6px;
  margin: 0 1px;
  border: 1px solid rgba(243, 201, 122, 0.85);
  border-radius: 4px;
  color: #f3c97a;
  background: rgba(243, 201, 122, 0.08);
  box-shadow: 0 0 8px rgba(243, 201, 122, 0.25);
  cursor: help;
  pointer-events: auto; /* 允许 hover */
  transition: background 120ms ease, box-shadow 120ms ease;
}

.mo-highlight:hover {
  background: rgba(243, 201, 122, 0.18);
  box-shadow: 0 0 14px rgba(243, 201, 122, 0.45);
}

/* Popover 浮窗 */
.mo-popover {
  position: absolute;
  bottom: calc(100% + 14px);
  left: 50%;
  transform: translateX(-50%);
  width: 320px;
  padding: 14px 16px;
  background: rgba(20, 16, 10, 0.96);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(243, 201, 122, 0.35);
  border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
  text-align: left;
  z-index: 20;
}

/* 三角指针 */
.mo-popover::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 6px solid transparent;
  border-top-color: rgba(20, 16, 10, 0.96);
}

.mo-popover-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #f3c97a;
  font-weight: 600;
  margin-bottom: 8px;
  letter-spacing: 0.5px;
}

.mo-popover-spark {
  font-size: 14px;
}

.mo-popover-body {
  font-size: 13px;
  line-height: 1.5;
  color: #e8e0cc;
  margin-bottom: 10px;
}

.mo-popover-expand {
  appearance: none;
  background: transparent;
  border: 0;
  padding: 0;
  color: #f3c97a;
  font-size: 12px;
  cursor: pointer;
}

.mo-popover-expand:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: Verify by importing standalone (no wiring yet)**

This task only creates the files. Wiring into `App.js` happens in Task 7. To verify the file compiles, just check that `npm start` doesn't error in the client. (CRA will pick up new files without import error since nothing imports them yet.)

- [ ] **Step 4: Commit**

```bash
git add client/src/MemeOverlay.js client/src/MemeOverlay.css
git commit -m "ui: MemeOverlay component (mask + HTML subtitle + golden keyword + hover popover)"
```

---

## Task 7: Wire MemeOverlay into App.js + onExpandRequest callback

**Files:**
- Modify: `client/src/App.js`

- [ ] **Step 1: Import MemeOverlay**

Near the top of `client/src/App.js`, find:
```javascript
import MemePanel from './MemePanel';
```

After it, add:
```javascript
import MemeOverlay from './MemeOverlay';
```

- [ ] **Step 2: Mount `<MemeOverlay>` in `.tx-player-wrap`**

Find this block in `App.js` (around line 932-937):
```javascript
            {/* 共谋者 · 隐藏符号热点 —— 脉冲小点 + 角标 pill，点击查看深度解读 */}
            <SymbolHotspots videoId={aiKb} videoRef={videoRef} />


            {/* 人物关系图 v2 —— HUD 入口 + Focus Card，按真实 videoTime + 角色 KB 动态出图 */}
            <RelationshipGraph videoId={aiKb} videoRef={videoRef} />
```

Immediately after the `<RelationshipGraph .../>` line (before the `<PlayerControls .../>` block), add:
```javascript

            {/* 共谋者 · 文化梗浮层 —— 4 条 riff 命中时段：底部蒙板 + HTML 字幕 + 金色高亮 + hover 浮窗 */}
            <MemeOverlay
              videoId={aiKb}
              videoRef={videoRef}
              enabled={true}
              onExpandRequest={(riffId) => {
                setRightTab('meme');
                setPendingExpandRiffId(riffId);
              }}
            />
```

- [ ] **Step 3: Verify in browser**

Reload. Open `house_of_dragon_05`. Use the player controls to seek to `25:30` (Rhaenyra's "I am the crown" line). Confirm:
- Within the time window (25:30–25:43), the bottom of the video gets darker (mask), the burned-in subtitle is no longer visible
- A new HTML subtitle appears showing the English line, with `the crown` boxed in gold
- Below it, the Chinese line appears
- Hover the gold box: a popover bubble appears above with `✦ 文化梗` header, the Tier 2 punch text, and "展开详情 ›"
- Move mouse off keyword AND popover: bubble fades after ~100ms
- Click "展开详情 ›": right tab switches to "文化梗", auto-scrolls to and expands the matching item
- Seek past 25:43: overlay disappears cleanly, burned-in subtitles return

Repeat the spot-check for the other 3 timestamps: 11:30 (tea), 18:18 (goose), 34:44 (good song).

- [ ] **Step 4: Commit**

```bash
git add client/src/App.js
git commit -m "ui: wire MemeOverlay into player + onExpandRequest callback (switch tab + auto-expand)"
```

---

## Task 8: MemeToggle — top-right master switch

**Files:**
- Create: `client/src/MemeToggle.js`
- Modify: `client/src/App.js` (add toggle to the player area, gate `MemeOverlay` with its state)
- Modify: `client/src/App.css` (add toggle styles)

- [ ] **Step 1: Create `MemeToggle.js`**

Create `client/src/MemeToggle.js`:

```javascript
import React, { useEffect, useState } from 'react';

const STORAGE_KEY = 'memeAnnotationsEnabled';

export default function MemeToggle({ enabled, onChange, hidden }) {
  // 只在挂载时从 localStorage 拉一次初值（父组件保管 enabled state）
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === '0' && enabled !== false) onChange(false);
    if (raw === '1' && enabled !== true) onChange(true);
    // raw === null → 用父组件传进来的默认（true）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => {
    const next = !enabled;
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    onChange(next);
  };

  if (hidden) return null;

  return (
    <button
      className={`meme-toggle${enabled ? ' is-on' : ' is-off'}`}
      onClick={toggle}
      title={enabled ? '点击关闭文化注释' : '点击开启文化注释'}
    >
      <span className="meme-toggle-spark">✦</span>
      <span className="meme-toggle-label">
        文化注释{enabled ? '已开启' : '已关闭'}
      </span>
    </button>
  );
}
```

- [ ] **Step 2: Add toggle styles to `App.css`**

Append to `client/src/App.css`:

```css
/* ─── MemeToggle — 文化注释总开关 ────────────────── */
.meme-toggle {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 21;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(243, 201, 122, 0.35);
  color: #f3c97a;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 200ms ease, background 200ms ease;
}

.meme-toggle.is-off {
  border-color: rgba(255, 255, 255, 0.18);
  color: rgba(255, 255, 255, 0.55);
}

.meme-toggle:hover {
  background: rgba(0, 0, 0, 0.78);
}

.meme-toggle-spark {
  font-size: 13px;
}

/* 鼠标 idle 时跟其他播放器 chrome 一起淡出 */
.tx-player-wrap.is-idle .meme-toggle {
  opacity: 0;
  pointer-events: none;
}
```

- [ ] **Step 3: Wire MemeToggle into App.js + gate MemeOverlay**

In `App.js`, near the other state declarations in `TencentPlayer` (after `pendingExpandRiffId`), add:

```javascript
  const [memeEnabled, setMemeEnabled] = useState(true);
  // 没有 riffs 时直接隐藏 toggle —— 通过 MemePanel 拉到的 riffs.length 决定
  // 这里偷懒：让 toggle 自己探测一下（fetch 同一端点）
  const [hasRiffs, setHasRiffs] = useState(false);
  useEffect(() => {
    if (!aiKb) { setHasRiffs(false); return; }
    fetch(`${API}/api/riffs?videoId=${encodeURIComponent(aiKb)}`)
      .then(r => r.json())
      .then(d => setHasRiffs((d.riffs || []).length > 0))
      .catch(() => setHasRiffs(false));
  }, [aiKb]);
```

Also add the import at the top:
```javascript
import MemeToggle from './MemeToggle';
```

Find the `<MemeOverlay .../>` mount from Task 7 and change `enabled={true}` to:
```javascript
              enabled={memeEnabled}
```

Then mount the toggle. Find the `<SymbolHotspots .../>` line. Just before it (still inside `.tx-player-wrap`), add:

```javascript
            {/* 文化注释总开关 —— 没 riff 不显示 */}
            <MemeToggle
              enabled={memeEnabled}
              onChange={setMemeEnabled}
              hidden={!hasRiffs}
            />
```

- [ ] **Step 4: Verify in browser**

Reload. Open `house_of_dragon_05`. Confirm:
- Top-right of the player shows the gold-bordered "✦ 文化注释已开启" pill
- Click it: changes to "✦ 文化注释已关闭" with neutral border, persists in localStorage
- With toggle OFF, seek to a riff window (e.g., 25:30): no overlay appears (no mask, no HTML subs, no gold box), but right-rail "文化梗" tab still works
- Toggle ON: overlays return
- Reload page: toggle state persists
- Player controls auto-hide (idle): toggle fades with them

If you have a non-house-of-dragon-05 video to switch to, confirm the toggle disappears entirely (no riffs for that video).

- [ ] **Step 5: Commit**

```bash
git add client/src/MemeToggle.js client/src/App.js client/src/App.css
git commit -m "ui: MemeToggle master switch (localStorage, auto-hides when no riffs)"
```

---

## Task 9: End-to-end manual verification + final polish

**Files:** none (manual checks only; fix-up commits if anything is off)

- [ ] **Step 1: Walk through full spec §6 verification list**

Open the player in a fresh browser session (clear localStorage first to test default-on).

For each of the 4 riffs (11:30, 18:18, 25:30, 34:44):

1. Seek to `start_time - 2s`, then play
2. As playback enters the riff window, confirm:
   - Mask appears, fully covers the burned-in subtitle (no double subtitles visible)
   - HTML subtitle renders correct EN + ZH text
   - Gold box wraps the correct keyword
   - Hover keyword: popover appears with correct Tier 2 punch
   - Mouse onto popover: stays open
   - Mouse off both: closes after ~100ms
   - "展开详情 ›": right tab switches to "文化梗", auto-scrolls to + expands the right card
3. Continue playing past `end_time`: overlay cleanly disappears, burned subs return

- [ ] **Step 2: Check toggle behavior**

- Toggle OFF mid-riff: overlay disappears immediately (mask + subs + gold gone)
- With OFF, "文化梗" tab in right rail still functional (list, expansion, jump button)
- Toggle ON, reload page: state persists

- [ ] **Step 3: Check tab persistence**

- Type something in AgentPanel chat, then switch to "文化梗" tab, then back: chat history is still there (state lifted in App.js — should not be lost)
- Expand a meme card, switch to AgentPanel, back to "文化梗": expanded state may reset (acceptable per spec §5)

- [ ] **Step 4: Check AgentPanel "second layer" behavior**

Pause near `25:30`, ask: "她这一句什么意思？"
Expected: response references Criston's prior "for love, not for the crown" line, frames the response as character-arc compression, **not** just a surface-level scene description.

Pause on a non-riff scene (e.g., Corlys greeting Viserys around `09:00`), ask: "这场啥意思？"
Expected: model gives ordinary scene analysis without inventing a fake "second layer" — confirms the "no 2nd layer? answer plainly" rule is working.

- [ ] **Step 5: Edge cases**

- Seek to an exact riff `start_time`: overlay appears immediately (no need to wait for `timeupdate`)
- Seek to within a riff window (mid-line): overlay appears immediately
- Pause inside a riff window: overlay stays
- Switch to a hypothetical other video (if any): MemeOverlay/MemePanel render empty, MemeToggle hidden

- [ ] **Step 6: If any failures, fix-up commits**

For any defect found in steps 1-5, make small fix-up commits with clear messages (e.g., `fix(meme): mask doesn't cover burned-in zh line — bump height to 130px`).

- [ ] **Step 7: Final summary commit (no code, just docs touch-up if needed)**

If all checks pass, no further commits needed. Otherwise, ensure spec or plan reflects any deviations made during implementation.

---

## Out of scope (for this plan)

The following are explicitly deferred per spec §7 — do **not** implement them in this pass:

- Full subtitle rendering layer (only the 4 riff windows are rendered here)
- Runtime LLM fallback for long-tail memes
- AgentPanel model upgrade to Opus (separate spec when ready)
- Personalization by user language / history
- Favorites + social sharing
- Concept relation graph
- Face-avoidance for popover positioning
- Multi-keyword / multi-meme per subtitle line
- `generate_dialogue_riffs.js` auto-candidate script (4 cards is faster by hand)
