#!/usr/bin/env node
/**
 * 用 scene-analyst agent 给挑选的 scene 生成深度解读。
 *
 * 与 enrich_scenes_gemini.js 的关系：
 *   - enrich_scenes_gemini 跑全集，输出 plot.fact / shot / tags（客观层）
 *   - 本脚本只跑挑选的"高价值" scene（空镜 / 含母题 / 转折点 / 用户指定），
 *     用 agent + 工具递归查询 KB，输出 plot.reading_v2 + foreshadow + theme + subtext
 *   - 双写：写到 reading_v2、不覆盖 reading（前端验证一段时间后再 swap）
 *
 * 用法：
 *   node scripts/agent_analyze_scenes.js house_of_dragon_05 --scenes s013,s448
 *   node scripts/agent_analyze_scenes.js house_of_dragon_05 --auto --limit 30
 *   node scripts/agent_analyze_scenes.js house_of_dragon_05 --scenes s013 --verbose
 *   node scripts/agent_analyze_scenes.js house_of_dragon_05 --rebuild --scenes s013
 *
 * 触发 agent 的"高价值 scene"启发式（--auto 模式）：
 *   - 已有 symbols 标注（说明含母题）
 *   - 空镜（characters 长度 = 0）
 *   - 长独白（duration > 8s 且 has_dialogue）
 *   - 已被挑进 enrich_high_value_e5.js 的 BEATS 清单
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');
const { ToolBox, sceneIdNum } = require('../lib/scene_analyst/tools');
const { analyzeScene } = require('../lib/scene_analyst/agent');

const SERVER_DIR = path.join(__dirname, '..');

// 与 enrich_high_value_e5 的 BEATS 一致——auto 模式默认从这里挑
const HOTSPOT_SCENES_E5 = [
  's03', 's04', 's05', 's06', 's07', 's08', 's09', 's10',
  's77', 's80', 's82', 's83',
  's115', 's116', 's117', 's118', 's119', 's120', 's121', 's122', 's123', 's124', 's125',
  's133', 's134', 's135', 's136', 's137',
  's140', 's143', 's146', 's149', 's152',
  's269', 's271', 's273',
  's447', 's448', 's449', 's450', 's451', 's453',
  's454', 's460', 's470',
  's544', 's545', 's547', 's550',
  's615', 's620', 's625', 's630', 's640',
  's670', 's680', 's685', 's690',
  's697', 's698', 's699', 's705',
  's100', 's101', 's105', 's106', 's107', 's109',
  's225', 's227', 's230', 's231',
  's238', 's241', 's244',
  's379', 's381', 's385',
  's509', 's512', 's515',
  's657', 's661', 's663',
];

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    videoId: null,
    scenes: null,
    auto: false,
    limit: null,
    cursor: 'S01E05',
    rebuild: false,
    dryRun: false,
    verbose: false,
    concurrency: 1,    // agent loop 默认串行（每次内含多次 LLM 调用 + 工具，不要爆 RPM）
    maxToolCalls: 8,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--scenes' && args[i + 1]) { opts.scenes = args[++i].split(','); continue; }
    if (a === '--auto') { opts.auto = true; continue; }
    if (a === '--limit' && args[i + 1]) { opts.limit = parseInt(args[++i], 10); continue; }
    if (a === '--cursor' && args[i + 1]) { opts.cursor = args[++i]; continue; }
    if (a === '--concurrency' && args[i + 1]) { opts.concurrency = parseInt(args[++i], 10); continue; }
    if (a === '--max-tool-calls' && args[i + 1]) { opts.maxToolCalls = parseInt(args[++i], 10); continue; }
    if (a === '--rebuild') { opts.rebuild = true; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--verbose' || a === '-v') { opts.verbose = true; continue; }
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (!opts.videoId && !a.startsWith('--')) opts.videoId = a;
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/agent_analyze_scenes.js <video_id> [options]

Modes (need at least one):
  --scenes <ids>        逗号分隔的 scene_id（如 s013,s448）
  --auto                自动挑选"高价值" scene（含 symbols / 空镜 / 长独白 / E5 hotspots）

Options:
  --limit <N>           只跑前 N 个（auto 模式调试用）
  --cursor <S01E05>     角色 DB 的剧透边界（默认 S01E05）
  --rebuild             已有 reading_v2 也重跑
  --concurrency <N>     并发 scene 数（默认 1；agent loop 内已有多调用，谨慎调高）
  --max-tool-calls <N>  每个 scene 的工具调用上限（默认 8）
  --dry-run             只列举待跑 scene
  -v, --verbose         打印每一轮 iter / tool 详细日志
  -h, --help            显示帮助

写回字段：
  scene.plot.reading_v2 = narrative_function
  scene.subtext         = character_subtext
  scene.theme_label     = thematic_link.theme_label
  scene.foreshadow.is_setup_for[]   ← agent 写入的 foreshadowing
  scene.foreshadow.is_payoff_of[]   ← 双向链接：被预示 scene 的反向引用
  scene._agent_meta     = { tool_calls, iters, usage, generated_at }
`);
}

function isHotspot(scene) {
  if (HOTSPOT_SCENES_E5.includes(scene.scene_id)) return true;
  if ((scene.symbols || []).length > 0) return true;
  if (!scene.characters || scene.characters.length === 0) return true; // 空镜
  const dur = scene.end_time - scene.start_time;
  if (dur > 8 && scene.audio?.has_dialogue) return true;
  return false;
}

function pickScenes(kb, opts) {
  const all = kb.scenes || [];
  if (opts.scenes) {
    const set = new Set(opts.scenes);
    return all.filter(s => set.has(s.scene_id));
  }
  if (opts.auto) {
    return all.filter(isHotspot);
  }
  return [];
}

function writeBack(kb, scene, reading, meta) {
  scene.plot = scene.plot || {};
  scene.plot.reading_v2 = reading.narrative_function;
  scene.plot.symbolism_v2 = reading.symbolism || null;
  scene.subtext = reading.character_subtext || null;
  scene.theme_label = reading.thematic_link?.theme_label || null;
  scene.theme_how = reading.thematic_link?.how || null;

  scene.foreshadow = scene.foreshadow || {};
  scene.foreshadow.is_setup_for = scene.foreshadow.is_setup_for || [];
  scene.foreshadow.is_payoff_of = scene.foreshadow.is_payoff_of || [];

  if (reading.foreshadowing?.target_scene_id && reading.foreshadowing?.text) {
    // 去重：同一个 (target, text) 只写一次
    const exists = scene.foreshadow.is_setup_for.some(x =>
      x.scene_id === reading.foreshadowing.target_scene_id
    );
    if (!exists) {
      scene.foreshadow.is_setup_for.push({
        scene_id: reading.foreshadowing.target_scene_id,
        text: reading.foreshadowing.text,
        source: 'agent',
      });
    }
    // 双向链接到目标 scene
    const target = (kb.scenes || []).find(s => s.scene_id === reading.foreshadowing.target_scene_id);
    if (target) {
      target.foreshadow = target.foreshadow || {};
      target.foreshadow.is_payoff_of = target.foreshadow.is_payoff_of || [];
      const existsBack = target.foreshadow.is_payoff_of.some(x => x.scene_id === scene.scene_id);
      if (!existsBack) {
        target.foreshadow.is_payoff_of.push({
          scene_id: scene.scene_id,
          text: reading.foreshadowing.text,
          source: 'agent',
        });
      }
    }
  }

  if (reading.callback?.source_scene_id && reading.callback?.text) {
    // callback 在当前 scene 上：is_payoff_of 写入
    const exists = scene.foreshadow.is_payoff_of.some(x =>
      x.scene_id === reading.callback.source_scene_id
    );
    if (!exists) {
      scene.foreshadow.is_payoff_of.push({
        scene_id: reading.callback.source_scene_id,
        text: reading.callback.text,
        source: 'agent',
      });
    }
    // 双向：source scene 的 is_setup_for 也加一条
    const src = (kb.scenes || []).find(s => s.scene_id === reading.callback.source_scene_id);
    if (src) {
      src.foreshadow = src.foreshadow || {};
      src.foreshadow.is_setup_for = src.foreshadow.is_setup_for || [];
      const existsFwd = src.foreshadow.is_setup_for.some(x => x.scene_id === scene.scene_id);
      if (!existsFwd) {
        src.foreshadow.is_setup_for.push({
          scene_id: scene.scene_id,
          text: reading.callback.text,
          source: 'agent_callback',
        });
      }
    }
  }

  scene._agent_meta = meta;
}

async function runOne({ scene, kb, charDb, toolBox, cursor, opts }) {
  const t0 = Date.now();
  const result = await analyzeScene({
    scene, kb, charDb, toolBox, cursor,
    maxToolCalls: opts.maxToolCalls,
    log: opts.verbose ? msg => console.log(msg) : () => {},
  });
  const elapsed = Date.now() - t0;
  return { result, elapsed };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();
  if (!opts.videoId) { console.error('Error: <video_id> required\n'); return printHelp(); }
  if (!opts.scenes && !opts.auto) {
    console.error('Error: must specify --scenes or --auto\n');
    return printHelp();
  }
  if (!ai.isAvailable('agent_analysis')) {
    console.error('Error: agent_analysis task 没可用 provider。检查 OPENAI_API_KEY（agent 必须用 openai，gemini 暂不支持工具调用）。');
    process.exit(1);
  }

  const { box: toolBox, kbPath } = ToolBox.fromVideo({ videoId: opts.videoId, episodeCursor: opts.cursor });
  const kb = toolBox.kb;
  const charDb = toolBox.charDb;
  console.log(`KB: ${path.basename(kbPath)}  (${kb.scenes.length} scenes)`);
  console.log(`Char DB: ${charDb ? `${charDb.characters?.length} characters` : '不存在（agent 仍可跑，但 get_character_profile 会失败）'}`);
  console.log(`Symbols: ${toolBox.symbolDict.symbols?.length || 0} entries`);
  console.log(`SRT: ${toolBox.subs.length || 0} 行`);
  console.log(`Cursor: ${opts.cursor}`);

  let scenes = pickScenes(kb, opts);
  if (!opts.rebuild) scenes = scenes.filter(s => !s.plot?.reading_v2);
  if (opts.limit) scenes = scenes.slice(0, opts.limit);
  // 按 scene_id 数字升序，保证 foreshadowing 双向链接时目标 scene 已经处理过的可能性更高
  scenes.sort((a, b) => (sceneIdNum(a.scene_id) || 0) - (sceneIdNum(b.scene_id) || 0));

  console.log(`\n待处理 scene 数: ${scenes.length}`);
  if (opts.dryRun) {
    scenes.slice(0, 30).forEach(s => {
      console.log(`  ${s.scene_id}  t=${s.start_time.toFixed(0)}s  chars=${(s.characters || []).length}  symbols=${(s.symbols || []).length}  fact="${(s.plot?.fact || '').slice(0, 40)}"`);
    });
    if (scenes.length > 30) console.log(`  ... 还有 ${scenes.length - 30} 个`);
    return;
  }
  if (scenes.length === 0) {
    console.log('没有 scene 需要处理（已全部填充 reading_v2；用 --rebuild 强制重跑）');
    return;
  }

  let okCount = 0, failCount = 0, totalIn = 0, totalOut = 0;
  let lastSaveAt = Date.now();
  const t0 = Date.now();

  // 串行 by default：agent loop 每次包多轮 LLM 调用，concurrency 太高容易撞 OpenAI RPM
  const queue = [...scenes];
  async function worker() {
    while (queue.length > 0) {
      const scene = queue.shift();
      if (!scene) return;
      console.log(`\n[${okCount + failCount + 1}/${scenes.length}] ${scene.scene_id}  t=${scene.start_time.toFixed(0)}s  fact="${(scene.plot?.fact || '').slice(0, 50)}"`);
      try {
        const { result, elapsed } = await runOne({ scene, kb, charDb, toolBox, cursor: opts.cursor, opts });
        if (result.ok) {
          writeBack(kb, scene, result.reading, {
            tool_calls: result.toolCalls.length,
            tool_call_log: result.toolCalls.map(tc => `${tc.name}(${tc.ok ? 'ok' : 'err'})`),
            usage: result.usage,
            elapsed_ms: elapsed,
            generated_at: new Date().toISOString(),
            cursor: opts.cursor,
          });
          okCount++;
          totalIn += result.usage?.input || 0;
          totalOut += result.usage?.output || 0;
          console.log(`  ✓ OK  tool_calls=${result.toolCalls.length}  in=${result.usage?.input || 0} out=${result.usage?.output || 0}  ${(elapsed / 1000).toFixed(1)}s`);
          console.log(`    narrative: ${result.reading.narrative_function.slice(0, 80)}…`);
          if (result.reading.foreshadowing) console.log(`    foreshadow → ${result.reading.foreshadowing.target_scene_id}`);
          if (result.reading.callback)      console.log(`    callback ← ${result.reading.callback.source_scene_id}`);
        } else {
          failCount++;
          console.log(`  ✗ FAIL  ${result.error}`);
        }
      } catch (err) {
        failCount++;
        console.log(`  ✗ EXCEPTION  ${err.message}`);
      }

      // 每 5 个 scene 写盘一次
      if ((okCount + failCount) % 5 === 0 && Date.now() - lastSaveAt > 3000) {
        fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2));
        lastSaveAt = Date.now();
        console.log(`     ↳ checkpoint saved`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()));

  fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2));
  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== Done ===`);
  console.log(`总耗时: ${totalElapsed}s`);
  console.log(`成功:   ${okCount}`);
  console.log(`失败:   ${failCount}`);
  console.log(`总 token: in=${totalIn} out=${totalOut}`);
  console.log(`KB 已保存: ${kbPath}`);
}

main().catch(err => {
  console.error('\nFATAL:', err.stack || err.message || err);
  process.exit(1);
});
