/* 从 Game of Thrones Fandom Wiki 拉每条龙的 infobox 主图，存到
   kb/characters/dragon_refs/<dragon_id>.<ext>。
   注：fandom.com 对默认 UA 返回 403，所以走带 browser UA 的请求。 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36';

// dragon_id ↔ Fandom 页面标题
const DRAGONS = [
  { id: 'caraxes',   title: 'Caraxes' },
  { id: 'syrax',     title: 'Syrax' },
  { id: 'vhagar',    title: 'Vhagar' },
  { id: 'meleys',    title: 'Meleys' },
  { id: 'sunfyre',   title: 'Sunfyre' },
  { id: 'dreamfyre', title: 'Dreamfyre' },
  { id: 'seasmoke',  title: 'Seasmoke' },
];

const OUT_DIR = path.join(__dirname, '..', 'kb', 'characters', 'dragon_refs');
fs.mkdirSync(OUT_DIR, { recursive: true });

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      // follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchBuffer(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

async function main() {
  for (const d of DRAGONS) {
    try {
      const apiUrl = `https://gameofthrones.fandom.com/api.php?action=query&prop=pageimages&titles=${encodeURIComponent(d.title)}&piprop=original&format=json`;
      const data = await fetchJson(apiUrl);
      const pages = data?.query?.pages || {};
      const page = Object.values(pages)[0];
      const src = page?.original?.source;
      if (!src) {
        console.log(`✗ ${d.id}: no infobox image found on page "${d.title}"`);
        continue;
      }

      // 解扩展名（fandom 的 URL 末尾 ?revision=... 要剥掉）
      const cleanUrl = src.split('?')[0];
      const ext = (cleanUrl.match(/\.(jpg|jpeg|png|webp|gif)$/i) || [, 'png'])[1].toLowerCase();
      const outFile = path.join(OUT_DIR, `${d.id}.${ext}`);

      const buf = await fetchBuffer(src);
      fs.writeFileSync(outFile, buf);
      console.log(`✓ ${d.id} (${buf.length}B) → ${path.relative(process.cwd(), outFile)}`);
    } catch (err) {
      console.log(`✗ ${d.id}: ${err.message}`);
    }
  }
}

main();
