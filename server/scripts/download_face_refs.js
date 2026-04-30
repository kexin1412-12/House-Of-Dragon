#!/usr/bin/env node
/**
 * 自动从 Wikipedia (演员肖像) + Game of Thrones Fandom (角色剧照) 下载参考图
 * 到 server/kb/characters/face_refs/<char_id>/<version>/
 *
 * 跑一次：node scripts/download_face_refs.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const REFS_ROOT = path.join(__dirname, '..', 'kb', 'characters', 'face_refs');
const UA = 'hotd-face-refs/0.1 (educational/demo; one-shot)';

// (character_id, actor_version) → wiki/fandom 抓取目标
const TARGETS = [
  {
    char_id: 'viserys_targaryen',
    versions: [
      { version: 'default', actor: 'Paddy Considine', wikipedia: 'Paddy Considine', fandom_page: 'Viserys_I_Targaryen' },
    ],
  },
  {
    char_id: 'rhaenyra_targaryen',
    versions: [
      { version: 'young', actor: 'Milly Alcock', wikipedia: 'Milly Alcock', fandom_page: null },
      { version: 'adult', actor: "Emma D'Arcy", wikipedia: "Emma D'Arcy", fandom_page: 'Rhaenyra_Targaryen' },
    ],
  },
  {
    char_id: 'daemon_targaryen',
    versions: [
      { version: 'default', actor: 'Matt Smith', wikipedia: 'Matt Smith (actor)', fandom_page: 'Daemon_Targaryen' },
    ],
  },
  {
    char_id: 'alicent_hightower',
    versions: [
      { version: 'young', actor: 'Emily Carey', wikipedia: 'Emily Carey', fandom_page: null },
      { version: 'adult', actor: 'Olivia Cooke', wikipedia: 'Olivia Cooke', fandom_page: 'Alicent_Hightower' },
    ],
  },
  {
    char_id: 'otto_hightower',
    versions: [
      { version: 'default', actor: 'Rhys Ifans', wikipedia: 'Rhys Ifans', fandom_page: 'Otto_Hightower' },
    ],
  },
  {
    char_id: 'corlys_velaryon',
    versions: [
      { version: 'default', actor: 'Steve Toussaint', wikipedia: 'Steve Toussaint', fandom_page: 'Corlys_Velaryon' },
    ],
  },
  {
    char_id: 'rhaenys_targaryen',
    versions: [
      { version: 'default', actor: 'Eve Best', wikipedia: 'Eve Best', fandom_page: 'Rhaenys_Targaryen' },
    ],
  },
  {
    char_id: 'criston_cole',
    versions: [
      { version: 'default', actor: 'Fabien Frankel', wikipedia: 'Fabien Frankel', fandom_page: 'Criston_Cole' },
    ],
  },
  {
    char_id: 'harwin_strong',
    versions: [
      { version: 'default', actor: 'Ryan Corr', wikipedia: 'Ryan Corr', fandom_page: 'Harwin_Strong' },
    ],
  },
  {
    char_id: 'larys_strong',
    versions: [
      { version: 'default', actor: 'Matthew Needham', wikipedia: 'Matthew Needham', fandom_page: 'Larys_Strong' },
    ],
  },
  {
    char_id: 'lyonel_strong',
    versions: [
      { version: 'default', actor: 'Gavin Spokes', wikipedia: 'Gavin Spokes', fandom_page: 'Lyonel_Strong' },
    ],
  },
  {
    char_id: 'mysaria',
    versions: [
      { version: 'default', actor: 'Sonoya Mizuno', wikipedia: 'Sonoya Mizuno', fandom_page: 'Mysaria' },
    ],
  },
  {
    char_id: 'aegon_targaryen_ii',
    versions: [
      { version: 'adult', actor: 'Tom Glynn-Carney', wikipedia: 'Tom Glynn-Carney', fandom_page: 'Aegon_II_Targaryen' },
    ],
  },
  {
    char_id: 'aemond_targaryen',
    versions: [
      { version: 'adult', actor: 'Ewan Mitchell', wikipedia: 'Ewan Mitchell (actor)', fandom_page: 'Aemond_Targaryen' },
    ],
  },
  {
    char_id: 'helaena_targaryen',
    versions: [
      { version: 'adult', actor: 'Phia Saban', wikipedia: 'Phia Saban', fandom_page: 'Helaena_Targaryen' },
    ],
  },
  // ── added so the family tree's Velaryon / Royce / Lonmouth nodes get
  //    portraits instead of bare initial fallbacks ────────────────────
  {
    char_id: 'laenor_velaryon',
    versions: [
      { version: 'default', actor: 'John Macmillan', wikipedia: 'John Macmillan (actor)', fandom_page: 'Laenor_Velaryon' },
    ],
  },
  {
    char_id: 'rhea_royce',
    versions: [
      { version: 'default', actor: 'Rachel Redford', wikipedia: 'Rachel Redford', fandom_page: 'Rhea_Royce' },
    ],
  },
  {
    char_id: 'joffrey_lonmouth',
    versions: [
      { version: 'default', actor: 'Solly McLeod', wikipedia: 'Solly McLeod', fandom_page: 'Joffrey_Lonmouth' },
    ],
  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    function go(u, hops = 0) {
      if (hops > 5) return reject(new Error('too many redirects'));
      https.get(u, { headers: { 'User-Agent': UA } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, u).href;
          res.resume();
          return go(next, hops + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    }
    go(url);
  });
}

async function fetchWikipediaPortrait(pageTitle) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=pageimages&piprop=original&format=json&formatversion=2`;
  const j = await httpGetJson(url);
  const page = j.query?.pages?.[0];
  return page?.original?.source || null;
}

async function fetchFandomCharImages(pageTitle, take = 4) {
  // 1) 取页面里前几个 image 文件名
  const u1 = `https://gameofthrones.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=images&format=json&formatversion=2`;
  const j1 = await httpGetJson(u1);
  let files = j1.parse?.images || [];
  // 过滤掉 svg / 家徽 / 标志类
  files = files.filter(f => !/\.svg$/i.test(f) && !/sigil|banner|coat|emblem|logo/i.test(f));
  files = files.slice(0, take);

  // 2) 解析每个 File:xxx 的真实 URL
  const urls = [];
  for (const f of files) {
    const u2 = `https://gameofthrones.fandom.com/api.php?action=query&titles=${encodeURIComponent('File:' + f)}&prop=imageinfo&iiprop=url&format=json&formatversion=2`;
    try {
      const j2 = await httpGetJson(u2);
      const page = j2.query?.pages?.[0];
      const url = page?.imageinfo?.[0]?.url;
      if (url) urls.push({ filename: f, url });
    } catch (e) {
      console.warn(`    ✗ resolve ${f}: ${e.message}`);
    }
    await sleep(120);
  }
  return urls;
}

function safeName(s) {
  return s.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 80);
}

async function processVersion(charId, ver) {
  const outDir = path.join(REFS_ROOT, charId, ver.version);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`\n[${charId} / ${ver.version}]  actor=${ver.actor}`);

  let saved = 0;

  // 1) 演员维基头像
  if (ver.wikipedia) {
    try {
      const portrait = await fetchWikipediaPortrait(ver.wikipedia);
      if (portrait) {
        const buf = await httpGetBuffer(portrait);
        const ext = (portrait.match(/\.(jpg|jpeg|png|webp)/i) || ['', 'jpg'])[1].toLowerCase();
        const fname = `wp_${safeName(ver.actor)}.${ext === 'webp' ? 'jpg' : ext}`;
        const fp = path.join(outDir, fname);
        fs.writeFileSync(fp, buf);
        saved++;
        console.log(`  ✓ wikipedia portrait → ${fname} (${(buf.length/1024).toFixed(0)} KB)`);
      } else {
        console.log(`  ✗ wikipedia: 无 pageimage`);
      }
    } catch (e) {
      console.log(`  ✗ wikipedia: ${e.message}`);
    }
    await sleep(300);
  }

  // 2) Fandom 角色页前几张图
  if (ver.fandom_page) {
    try {
      const urls = await fetchFandomCharImages(ver.fandom_page, 4);
      let i = 0;
      for (const { filename, url } of urls) {
        try {
          const buf = await httpGetBuffer(url);
          if (buf.length < 5000) { console.log(`    skip tiny ${filename}`); continue; }
          const ext = (filename.match(/\.(jpg|jpeg|png|webp)/i) || ['', 'jpg'])[1].toLowerCase();
          const fname = `fd_${String(++i).padStart(2, '0')}_${safeName(filename).slice(0, 30)}.${ext === 'webp' ? 'jpg' : ext}`;
          fs.writeFileSync(path.join(outDir, fname), buf);
          saved++;
          console.log(`  ✓ fandom → ${fname} (${(buf.length/1024).toFixed(0)} KB)`);
        } catch (e) {
          console.log(`  ✗ download ${filename}: ${e.message}`);
        }
        await sleep(200);
      }
    } catch (e) {
      console.log(`  ✗ fandom list: ${e.message}`);
    }
  }

  console.log(`  → 共保存 ${saved} 张到 ${path.relative(process.cwd(), outDir)}`);
  return saved;
}

// Optional filter: `node ... --only laenor_velaryon,rhea_royce` to re-fetch
// just specific characters (avoids touching existing files for the others
// and steers clear of unnecessary HTTPS hits).
function parseOnly(argv) {
  const i = argv.indexOf('--only');
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v) return null;
  return new Set(v.split(',').map(s => s.trim()).filter(Boolean));
}

async function main() {
  fs.mkdirSync(REFS_ROOT, { recursive: true });
  console.log(`输出根目录: ${REFS_ROOT}\n`);
  const only = parseOnly(process.argv);
  if (only) console.log(`(filtered) only: ${[...only].join(', ')}\n`);
  let total = 0;
  for (const t of TARGETS) {
    if (only && !only.has(t.char_id)) continue;
    for (const ver of t.versions) {
      total += await processVersion(t.char_id, ver);
    }
  }
  console.log(`\n✓ 完成。共保存 ${total} 张参考图。`);
  console.log(`下一步：cd server && python scripts/build_face_gallery.py`);
}

main().catch(err => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
