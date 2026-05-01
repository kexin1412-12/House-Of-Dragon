require('dotenv').config({ override: true });
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const agent = require('./agent');

// ─── faststart helpers ─────────────────────────────────────────────
// HTML5 <video> 需要 mp4 的 moov 原子在文件开头才能流式播放。很多上传工具
// 把 moov 放在文件末尾，导致浏览器拿不到索引就报 NotSupportedError。
// 这里在上传完成后用 ffmpeg 跑一次 -movflags +faststart 重排（不重编码）。

// 读文件前 ~512KB 看 moov 是否在 mdat 之前；是的话已经 faststart，可跳过
function isAlreadyFaststart(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(524288);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const slice = buf.slice(0, bytes).toString('binary');
    const moov = slice.indexOf('moov');
    const mdat = slice.indexOf('mdat');
    // moov 在前 512KB 内能找到，且早于 mdat（或 mdat 不在前 512KB → 也算 faststart）
    return moov !== -1 && (mdat === -1 || moov < mdat);
  } catch { return false; }
}

// ffmpeg -i input -c copy -movflags +faststart output —— 流复制，不重编码
function ffmpegFaststart(filePath) {
  return new Promise((resolve, reject) => {
    const tmpPath = filePath + '.faststart.tmp';
    const args = [
      '-y', '-loglevel', 'error',
      '-i', filePath,
      '-c', 'copy',
      '-movflags', '+faststart',
      tmpPath,
    ];
    const p = spawn('ffmpeg', args);
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('error', err => reject(err));
    p.on('close', code => {
      if (code !== 0) {
        try { fs.unlinkSync(tmpPath); } catch {}
        return reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 500)}`));
      }
      try {
        fs.renameSync(tmpPath, filePath);
        resolve();
      } catch (err) { reject(err); }
    });
  });
}

const app = express();
const PORT = process.env.PORT || 5000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/kb/frames', express.static(path.join(__dirname, 'kb', 'frames')));
app.use('/kb/characters/face_refs', express.static(path.join(__dirname, 'kb', 'characters', 'face_refs')));
app.use('/kb/characters/dragon_refs', express.static(path.join(__dirname, 'kb', 'characters', 'dragon_refs')));

agent.register(app);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_一-龥]/g, '_');
    cb(null, Date.now() + '-' + safeName);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  },
});

// 视频清单：先扫本地 uploads/（开发模式）；本地为空时回落到 demo-videos.json
// （部署模式：视频已传到 Cloudflare R2，URL 由 client 用 REACT_APP_VIDEO_CDN 拼出）
app.get('/api/videos', (req, res) => {
  const videoExts = /\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v)$/i;
  let videos = [];
  if (fs.existsSync(UPLOADS_DIR)) {
    const files = fs.readdirSync(UPLOADS_DIR).filter(f => videoExts.test(f));
    videos = files.map(f => {
      const stat = fs.statSync(path.join(UPLOADS_DIR, f));
      const ts = parseInt(f.split('-')[0]);
      const originalName = f.replace(/^\d+-/, '').replace(/\.[^.]+$/, '');
      return {
        id: f,
        name: originalName,
        filename: f,
        url: `/uploads/${encodeURIComponent(f)}`,
        size: stat.size,
        uploadedAt: isNaN(ts) ? stat.mtime.toISOString() : new Date(ts).toISOString(),
      };
    });
  }
  if (videos.length === 0) {
    const manifestPath = path.join(__dirname, 'demo-videos.json');
    if (fs.existsSync(manifestPath)) {
      try { videos = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
    }
  }
  videos.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(videos);
});

app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const filePath = path.join(UPLOADS_DIR, req.file.filename);

  // mp4 自动 faststart：保证浏览器能 HTTP 流式播放
  // 仅对 .mp4 / .m4v 跑（其它容器格式 ffmpeg 不一定支持 +faststart）
  let faststart = 'skipped';
  let finalSize = req.file.size;
  if (/\.(mp4|m4v)$/i.test(req.file.filename)) {
    try {
      if (isAlreadyFaststart(filePath)) {
        faststart = 'already';
      } else {
        const t0 = Date.now();
        await ffmpegFaststart(filePath);
        finalSize = fs.statSync(filePath).size;
        faststart = `done in ${((Date.now() - t0) / 1000).toFixed(1)}s`;
      }
    } catch (err) {
      console.warn(`[upload] faststart failed for ${req.file.filename}:`, err.message);
      faststart = `failed: ${err.message}`;
    }
  }

  const ts = parseInt(req.file.filename.split('-')[0]);
  res.json({
    id: req.file.filename,
    name: req.file.originalname.replace(/\.[^.]+$/, ''),
    filename: req.file.filename,
    url: `/uploads/${encodeURIComponent(req.file.filename)}`,
    size: finalSize,
    uploadedAt: new Date(ts).toISOString(),
    faststart,
  });
});

app.delete('/api/videos/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});

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
  const all = loadRiffs();
  // 不传 videoId → 返回所有视频的 riffs，给"我的收藏"页面用
  const riffs = (videoId ? all.filter(r => r.video_id === videoId) : all)
    .sort((a, b) => (a.anchor?.start_time || 0) - (b.anchor?.start_time || 0));
  res.json({ video_id: videoId || null, count: riffs.length, riffs });
});

// 设定百科 / Lore Cards —— 静态 KB 直出。按 show 维度组织，整季共用，不带时间锚。
let _loreCache = null;
function loadLore() {
  if (_loreCache) return _loreCache;
  const dir = path.join(__dirname, 'kb', 'lore_cards');
  const all = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const showSlug = j.show || null;
        for (const c of (j.lore_cards || [])) {
          all.push({ ...c, show: c.show || showSlug });
        }
      } catch (e) {
        console.warn(`[lore] skip bad file ${f}:`, e.message);
      }
    }
  }
  _loreCache = all;
  return all;
}

const LORE_CATEGORY_ORDER = ['place', 'institution', 'dragon', 'house'];

app.get('/api/lore', (req, res) => {
  const show = req.query.show;
  const all = loadLore();
  const cards = show ? all.filter(c => c.show === show) : all;
  // 按 category 顺序分组：place / institution / dragon / house
  const groups = LORE_CATEGORY_ORDER
    .map(cat => {
      const inCat = cards.filter(c => c.category === cat);
      if (inCat.length === 0) return null;
      return {
        category: cat,
        label: inCat[0].category_label || cat,
        icon: inCat[0].category_icon || '',
        cards: inCat,
      };
    })
    .filter(Boolean);
  res.json({ show: show || null, count: cards.length, groups });
});

// （旧 /api/scene-hotspots 已下线 —— 那 10 条已迁移到 server/kb/symbols/<show>.json
//  里，由 SymbolHotspots + 新 CTA 系统统一渲染。迁移脚本和原 JSON 都删了。）

// 叙事 X 光 / Storyline —— 静态 KB 直出。每个 video_id 一个 JSON 文件。
let _storylineCache = null;
function loadStoryline() {
  if (_storylineCache) return _storylineCache;
  const dir = path.join(__dirname, 'kb', 'storyline');
  const byVideo = {};
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j.video_id) byVideo[j.video_id] = j;
      } catch (e) {
        console.warn(`[storyline] skip bad file ${f}:`, e.message);
      }
    }
  }
  _storylineCache = byVideo;
  return byVideo;
}

app.get('/api/storyline', (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  const byVideo = loadStoryline();
  const data = byVideo[videoId];
  if (!data) return res.status(404).json({ error: 'no storyline for video', video_id: videoId });
  res.json(data);
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
