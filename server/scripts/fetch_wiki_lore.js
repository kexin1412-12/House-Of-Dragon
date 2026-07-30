#!/usr/bin/env node
/**
 * 从 Fandom wiki 抓背景 lore，经 LLM 过滤成「不剧透的世界观/家族/设定/象征」知识点，
 * 输出 references/wiki-<wiki>.knowledge.json（格式兼容 enrich_with_insights.js）。
 *
 * 用法：
 *   node scripts/fetch_wiki_lore.js --wiki gameofthrones \
 *     --entities "House Targaryen,House Velaryon,Valyria,Dragonstone,Old Valyria,Dragons"
 *
 *   node scripts/fetch_wiki_lore.js --wiki gameofthrones --from-kb <video_id>
 *     (自动从 kb/<id>.json 的 scene.characters[].id 提取实体)
 *
 * 细节：
 *   - 用标准 MediaWiki api.php（Fandom 的 /api/v1 被 Cloudflare 挡）
 *   - 只取 section=0（intro），避免整页剧情长文
 *   - 同页 wikitext 缓存到 references/wiki-cache/<wiki>__<title>.wiki，再跑跳过 fetch
 *   - LLM 提示明确："只要 pre-story 世界观/家族/地理/符号/物件；任何来自剧集的具体事件/结局/死亡一律丢"
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const kbPaths = require('../lib/kb-paths');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const FETCH_DELAY_MS = 400; // 对 Fandom 礼貌一点
const UA = 'hotd-kb-builder/0.1 (educational/demo use; one-shot)';

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    wiki: null,
    entities: [],
    fromKb: null,
    model: DEFAULT_MODEL,
    output: null,
    force: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wiki' && args[i + 1]) { opts.wiki = args[++i]; continue; }
    if (args[i] === '--entities' && args[i + 1]) {
      opts.entities = args[++i].split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }
    if (args[i] === '--from-kb' && args[i + 1]) { opts.fromKb = args[++i]; continue; }
    if (args[i] === '--model' && args[i + 1]) { opts.model = args[++i]; continue; }
    if (args[i] === '--output' && args[i + 1]) { opts.output = args[++i]; continue; }
    if (args[i] === '--force') { opts.force = true; continue; }
    if (args[i] === '-h' || args[i] === '--help') { opts.help = true; continue; }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/fetch_wiki_lore.js --wiki <fandom_slug> [--entities "A,B,C" | --from-kb <video_id>] [options]

Options:
  --wiki <slug>        Fandom wiki subdomain, e.g. "gameofthrones"
  --entities "a,b,c"   Comma-separated page titles
  --from-kb <video_id> Extract character ids from kb/<video_id>.json
  --model <name>       OpenAI model (default: ${DEFAULT_MODEL})
  --output <path>      Output path (default: references/wiki-<wiki>.knowledge.json)
  --force              Re-fetch even if wikitext is cached
  -h, --help           Show help
`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWikitext(wiki, title) {
  const url = new URL(`https://${wiki}.fandom.com/api.php`);
  url.searchParams.set('action', 'parse');
  url.searchParams.set('page', title);
  url.searchParams.set('prop', 'wikitext');
  url.searchParams.set('section', '0');
  url.searchParams.set('redirects', '1');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${title}`);
  const json = await res.json();
  if (json.error) return { missing: true, error: json.error.info };
  const wikitext = json.parse?.wikitext;
  if (!wikitext) return { missing: true };
  return {
    title: json.parse.title,
    pageid: json.parse.pageid,
    wikitext,
  };
}

function cleanWikitext(wt) {
  let t = wt;
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<ref[^>]*\/>/g, '');
  t = t.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '');
  t = t.replace(/<gallery[\s\S]*?<\/gallery>/g, '');
  t = t.replace(/<[^>]+>/g, '');

  // 重复剥离最内层模板 {{...}}，直到不再变化
  let prev;
  do {
    prev = t;
    t = t.replace(/\{\{[^{}]*\}\}/g, '');
  } while (t !== prev);

  // 文件/图片嵌入
  t = t.replace(/\[\[File:[^\]]*\]\]/gi, '');
  t = t.replace(/\[\[Image:[^\]]*\]\]/gi, '');

  // 重复剥离最内层 wikilink：[[target|display]] → display，[[target]] → target
  do {
    prev = t;
    t = t.replace(/\[\[([^\[\]|]+)\|([^\[\]]+)\]\]/g, '$2');
    t = t.replace(/\[\[([^\[\]]+)\]\]/g, '$1');
  } while (t !== prev);

  // 外链 [url text] → text；单独 [url] 丢
  t = t.replace(/\[https?:[^\s\]]+\s+([^\]]+)\]/g, '$1');
  t = t.replace(/\[https?:[^\]]+\]/g, '');

  // 列表/加粗/斜体/标题符号
  t = t.replace(/^[*#;:]+\s?/gm, '');
  t = t.replace(/'{2,5}/g, '');
  t = t.replace(/^={1,6}\s*(.+?)\s*={1,6}$/gm, '\n$1\n');

  // HTML entity
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

  // 压缩空白
  t = t.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

const EXTRACT_SYSTEM = `你是影视世界观 lore 提炼 Agent。

输入是一段 wiki 条目（角色/家族/地点/物件/概念），会同时包含：
- 世界观/地理/历史/家族关系/象征物件/设定（✅ 我们要的）
- 剧集里的具体剧情事件、角色死亡、最终结局、某一集发生的事（❌ 一律丢弃，视为剧透）

任务：
1. 只提取 pre-story 性质的世界观/家族/地理/物件/风俗/象征类知识点。
2. 如果一段描述同时混着"设定 + 剧情事件"，只保留设定部分，改写。
3. 不要出现具体集数、具体事件、谁死了、谁杀了谁、结局走向、某阵营获胜。
4. 不要编造 wiki 里没说的。
5. 不要直接大段复制 wiki，要改写成中文短句。
6. summary 要写得对一个刚开始看剧的观众有用（解释这是什么、为什么重要）。

只输出严格 JSON，不要 Markdown，不要解释。`;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['knowledge_points'],
  properties: {
    knowledge_points: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kid', 'type', 'title', 'summary', 'evidence', 'related_characters', 'related_symbols', 'use_in_agent', 'safe_hint', 'expanded_explanation', 'possible_user_questions', 'recommended_card_type', 'importance', 'confidence'],
        properties: {
          kid: { type: 'string' },
          type: { type: 'string', enum: ['lore', 'character', 'foreshadow', 'shot_analysis', 'emotion', 'directing', 'missable_detail', 'plot'] },
          title: { type: 'string' },
          summary: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          related_characters: { type: 'array', items: { type: 'string' } },
          related_symbols: { type: 'array', items: { type: 'string' } },
          use_in_agent: { type: 'string' },
          safe_hint: { type: 'string' },
          expanded_explanation: { type: 'string' },
          possible_user_questions: { type: 'array', items: { type: 'string' } },
          recommended_card_type: { type: 'string', enum: ['shot', 'foreshadow', 'character', 'emotion', 'lore', 'missed'] },
          importance: { type: 'number' },
          confidence: { type: 'number' },
        },
      },
    },
  },
};

async function extractLore(client, model, title, cleaned, idxBase) {
  const user = `wiki 条目：${title}

条目内容（已清洗）：
${cleaned.slice(0, 8000)}

kid 从 kp_${String(idxBase).padStart(3, '0')} 开始顺序编号。
如果整段内容都是剧情事件、没有任何 pre-story lore 可抽取，返回 {"knowledge_points": []}。`;

  const res = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'wiki_lore', strict: true, schema: RESPONSE_SCHEMA },
    },
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: user },
    ],
  });
  return JSON.parse(res.choices[0].message.content);
}

function dedupeEntities(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const norm = raw.replace(/_/g, ' ').trim();
    const key = norm.toLowerCase();
    if (norm && !seen.has(key)) {
      seen.add(key);
      out.push(norm);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();
  if (!opts.wiki) {
    console.error('Error: --wiki <slug> is required.\n');
    printHelp();
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY not set (server/.env)');
    process.exit(1);
  }

  let entities = [...opts.entities];
  if (opts.fromKb) {
    const kbPath = kbPaths.sceneKb(opts.fromKb);
    if (!fs.existsSync(kbPath)) {
      console.error(`Error: kb not found: ${kbPath}`);
      process.exit(1);
    }
    const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
    const ids = new Set();
    for (const s of kb.scenes || []) {
      for (const c of s.characters || []) if (c.id) ids.add(c.id);
    }
    entities.push(...ids);
    console.log(`Loaded ${ids.size} character ids from kb/${opts.fromKb}.json`);
  }
  entities = dedupeEntities(entities);
  if (entities.length === 0) {
    console.error('Error: no entities provided. Use --entities or --from-kb.');
    process.exit(1);
  }
  console.log(`Fetching ${entities.length} entities from ${opts.wiki}.fandom.com\n`);

  const serverDir = path.join(__dirname, '..');
  const cacheDir = path.join(serverDir, 'references', 'wiki-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const outPath = opts.output || path.join(serverDir, 'references', `wiki-${opts.wiki}.knowledge.json`);

  const allPoints = [];
  const missedEntities = [];
  let kidBase = 1;

  const OpenAI = require('openai');
  const client = new OpenAI();

  for (let i = 0; i < entities.length; i++) {
    const title = entities[i];
    const safeName = title.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80);
    const cachePath = path.join(cacheDir, `${opts.wiki}__${safeName}.wiki`);
    let wikitext = null;
    let resolvedTitle = title;

    if (!opts.force && fs.existsSync(cachePath)) {
      wikitext = fs.readFileSync(cachePath, 'utf8');
      process.stdout.write(`  [${i + 1}/${entities.length}] ${title}  (cached)  `);
    } else {
      process.stdout.write(`  [${i + 1}/${entities.length}] ${title}  `);
      try {
        const r = await fetchWikitext(opts.wiki, title);
        if (r.missing) {
          console.log(`✗ missing (${r.error || 'no page'})`);
          missedEntities.push(title);
          await sleep(FETCH_DELAY_MS);
          continue;
        }
        wikitext = r.wikitext;
        resolvedTitle = r.title;
        fs.writeFileSync(cachePath, wikitext);
        await sleep(FETCH_DELAY_MS);
      } catch (e) {
        console.log(`✗ ${e.message}`);
        missedEntities.push(title);
        await sleep(FETCH_DELAY_MS);
        continue;
      }
    }

    const cleaned = cleanWikitext(wikitext);
    if (cleaned.length < 80) {
      console.log(`skip (cleaned too short: ${cleaned.length} chars)`);
      continue;
    }

    try {
      const t0 = Date.now();
      const result = await extractLore(client, opts.model, resolvedTitle, cleaned, kidBase);
      const kps = result.knowledge_points || [];
      for (const kp of kps) {
        kp.source_entity = resolvedTitle;
        kp.source_wiki = opts.wiki;
        allPoints.push(kp);
      }
      kidBase += kps.length || 1;
      console.log(`+${kps.length} lore points  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

      // 增量落盘，防中途崩
      const payload = {
        source: {
          platform: 'fandom',
          wiki: opts.wiki,
          type: 'wiki_lore',
          processed_at: new Date().toISOString().slice(0, 10),
          model: opts.model,
          entities_requested: entities,
          entities_missed: missedEntities,
        },
        knowledge_points: allPoints,
      };
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    } catch (e) {
      console.log(`✗ extract failed: ${e.message}`);
    }
  }

  console.log(`\n✓ Done.`);
  console.log(`  entities:          ${entities.length}`);
  console.log(`  missed:            ${missedEntities.length} ${missedEntities.length ? `(${missedEntities.join(', ')})` : ''}`);
  console.log(`  knowledge points:  ${allPoints.length}`);
  console.log(`  output:            ${path.relative(process.cwd(), outPath)}`);
}

main().catch(err => {
  console.error(`\n✗ ERROR: ${err.message}`);
  if (err.status) console.error(`  HTTP ${err.status}`);
  process.exit(1);
});
