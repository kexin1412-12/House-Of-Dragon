// 一次性脚本：为 storyline 每个节点注入 keyframe（找节点 start_time + 5s 附近的 scene）
const fs = require('fs');
const path = require('path');

const STORY_DIR = path.join(__dirname, '..', 'kb', 'storyline');
const KB_DIR    = path.join(__dirname, '..', 'kb');

for (const f of fs.readdirSync(STORY_DIR)) {
  if (!f.endsWith('.json')) continue;
  const storyPath = path.join(STORY_DIR, f);
  const story = JSON.parse(fs.readFileSync(storyPath, 'utf8'));
  const videoId = story.video_id;
  if (!videoId) continue;

  const epPath = path.join(KB_DIR, `${videoId}.json`);
  if (!fs.existsSync(epPath)) {
    console.warn(`[skip] no episode KB for ${videoId}`);
    continue;
  }
  const ep = JSON.parse(fs.readFileSync(epPath, 'utf8'));
  const scenes = (ep.scenes || []).filter(s => s.keyframe);

  let updated = 0;
  for (const node of (story.nodes || [])) {
    // 取节点开始 +5s 附近的 scene 作为 representative shot；
    // 偏移一点避免每段开头都是淡入黑屏。
    const target = (node.start_time || 0) + 5;
    let best = null;
    let bestDt = Infinity;
    for (const sc of scenes) {
      if (sc.start_time > (node.end_time || Infinity)) break;
      const dt = Math.abs(sc.start_time - target);
      if (dt < bestDt) { bestDt = dt; best = sc; }
    }
    if (best) {
      node.keyframe = best.keyframe;
      updated++;
    }
  }
  fs.writeFileSync(storyPath, JSON.stringify(story, null, 2) + '\n', 'utf8');
  console.log(`[${videoId}] keyframes set on ${updated}/${(story.nodes || []).length} nodes`);
}
