#!/usr/bin/env node
/**
 * 给已识别的 scene.symbols[] 补上 bbox（归一化 0-1）。
 * 抽象类符号（蒙太奇/缺席仪式/婚礼混乱整体）bbox 为 null —— 前端降级到角标提示。
 *
 * 不动现有的 evidence_in_frame / confidence / deep_reading；只往每个 symbol 加 bbox 字段。
 *
 * 用法：
 *   node scripts/add_symbol_bboxes.js                # 跑所有有 symbols 的 scene
 *   node scripts/add_symbol_bboxes.js --rebuild      # 已有 bbox 也重跑
 *   node scripts/add_symbol_bboxes.js --scenes s146,s448
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');

const SERVER_DIR = path.join(__dirname, '..');

// 抽象类符号 —— 不需要 bbox，直接 null
const ABSTRACT_SYMBOLS = new Set([
  'murder_montage_offscreen',
  'wedding_chaos',
  'kingsguard_no_announcement',
  'extra_chair_added',
  'seahorse_no_greeting',
  'host_keeps_seat',
]);

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { rebuild: false, scenes: null, concurrency: 5, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rebuild') opts.rebuild = true;
    else if (args[i] === '--scenes' && args[i+1]) opts.scenes = args[++i].split(',');
    else if (args[i] === '--concurrency' && args[i+1]) opts.concurrency = parseInt(args[++i], 10);
    else if (args[i] === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

function imageToDataUrl(p) {
  const data = fs.readFileSync(p);
  const mime = /\.png$/i.test(p) ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${data.toString('base64')}`;
}

const SYSTEM_PROMPT = `你是图像目标定位器。

输入：一帧关键帧 + 已经识别出的几个符号（每个符号有 evidence_in_frame 描述了它是画面里的什么东西）。

任务：对每个符号，在画面里找到那个具体物件/人/区域，返回归一化的 bbox。

规则：
- bbox 是 [x, y, w, h]，全部是 0-1 的浮点数（图像左上角是 0,0；右下角是 1,1）
- 范围尽量 tight：刚好包住那个物件/人物上半身/服饰核心区域，留 5-10% margin 即可
- 如果 evidence 提到的东西**画面里看不到**（角度问题、被遮挡、其实是抽象信号），bbox 返回 null
- 如果 evidence 是台词/对白触发（如"台词中提到..."），bbox 返回 null
- 严格按 schema 输出，不要解释。`;

const SCHEMA = {
  type: 'object',
  required: ['bboxes'],
  properties: {
    bboxes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['symbol_id', 'bbox'],
        properties: {
          symbol_id: { type: 'string' },
          bbox: {
            anyOf: [
              { type: 'array', items: { type: 'number' } },
              { type: 'null' },
            ],
          },
        },
      },
    },
  },
};

async function bboxOne({ scene }) {
  const keyframeRel = (scene.keyframe || '').replace(/^\//, '');
  const keyframePath = keyframeRel ? path.join(SERVER_DIR, 'kb', keyframeRel) : null;
  if (!keyframePath || !fs.existsSync(keyframePath)) {
    return { ok: false, reason: 'missing_keyframe' };
  }

  // 拆出需要 bbox 的符号（抽象类直接跳过、不调 LLM）
  const symbolsToLocate = scene.symbols.filter(s => !ABSTRACT_SYMBOLS.has(s.symbol_id));
  if (symbolsToLocate.length === 0) {
    // 全是抽象的 → 直接给所有符号 bbox=null
    return { ok: true, bboxes: scene.symbols.map(s => ({ symbol_id: s.symbol_id, bbox: null })) };
  }

  const userText =
`已识别的符号（请定位到画面里）：
${symbolsToLocate.map((s, i) => `${i+1}. ${s.symbol_id}\n   evidence: ${s.evidence_in_frame}`).join('\n\n')}

对每个符号返回 bbox（归一化 0-1）。如果该 evidence 是台词触发或东西不在画面里，bbox=null。`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', dataUrl: imageToDataUrl(keyframePath) },
      { type: 'text', text: userText },
    ],
  }];

  const r = await ai.generateStructured({
    task: 'vision',
    system: SYSTEM_PROMPT,
    messages,
    schema: SCHEMA,
    temperature: 0.1,
  });

  // 把抽象符号补回去（bbox=null）
  const located = (r.data?.bboxes || []).reduce((m, b) => { m[b.symbol_id] = b.bbox; return m; }, {});
  const allBboxes = scene.symbols.map(s => ({
    symbol_id: s.symbol_id,
    bbox: ABSTRACT_SYMBOLS.has(s.symbol_id) ? null : (located[s.symbol_id] ?? null),
  }));
  return { ok: true, bboxes: allBboxes };
}

async function runConcurrent(items, fn, n, onTick) {
  const results = new Array(items.length);
  let cursor = 0, done = 0;
  await Promise.all(Array.from({length: n}, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (err) { results[i] = { ok: false, reason: 'exception', error: err.message }; }
      done++;
      onTick?.(done, items.length, items[i], results[i]);
    }
  }));
  return results;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!ai.isAvailable('vision')) { console.error('vision provider 不可用'); process.exit(1); }

  const kbPath = path.join(SERVER_DIR, 'kb', 'house_of_dragon_05.json');
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));

  let candidates;
  if (opts.scenes) {
    candidates = opts.scenes.map(id => kb.scenes.find(s => s.scene_id === id)).filter(Boolean);
  } else {
    candidates = kb.scenes.filter(s => s.symbols && s.symbols.length > 0);
  }

  // 跳过已有 bbox 的 scene（除非 --rebuild）
  const items = candidates.filter(s => {
    if (opts.rebuild) return true;
    return s.symbols.some(sym => sym.bbox === undefined);
  });

  console.log(`KB: ${kb.scenes.length} scenes | 待处理: ${items.length} (concurrency=${opts.concurrency})`);
  if (opts.dryRun) {
    items.forEach(s => console.log(' ', s.scene_id, '['+s.symbols.map(x=>x.symbol_id).join(',')+']'));
    return;
  }
  if (items.length === 0) { console.log('全部 scene 已有 bbox。用 --rebuild 强制重跑。'); return; }

  const t0 = Date.now();
  let okCount = 0, failCount = 0, abstractCount = 0, locatedCount = 0;

  await runConcurrent(items.map(scene => ({ scene })), async ({ scene }) => {
    const r = await bboxOne({ scene });
    if (r.ok) {
      // 写回每个 symbol 的 bbox
      const bMap = r.bboxes.reduce((m, b) => { m[b.symbol_id] = b.bbox; return m; }, {});
      for (const sym of scene.symbols) {
        sym.bbox = sym.symbol_id in bMap ? bMap[sym.symbol_id] : null;
        if (sym.bbox === null) abstractCount++; else locatedCount++;
      }
      okCount++;
    } else {
      failCount++;
    }
    return r;
  }, opts.concurrency, (done, total, { scene }, r) => {
    if (r.ok) {
      const bs = r.bboxes.map(b => b.bbox === null ? `${b.symbol_id}=null` : `${b.symbol_id}=ok`).join(' ');
      console.log(`  [${done}/${total}] ${scene.scene_id} OK  ${bs}`);
    } else {
      console.log(`  [${done}/${total}] ${scene.scene_id} FAIL ${r.reason}`);
    }
  });

  fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Done ===`);
  console.log(`成功 scene: ${okCount}  失败: ${failCount}`);
  console.log(`定位到画面的符号: ${locatedCount}  抽象/不在画面: ${abstractCount}`);
  console.log(`耗时: ${elapsed}s | KB: ${kbPath}`);
}

main().catch(e => { console.error('FATAL:', e.stack || e); process.exit(1); });
