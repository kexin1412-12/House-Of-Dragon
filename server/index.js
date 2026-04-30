require('dotenv').config({ override: true });
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const agent = require('./agent');

const app = express();
const PORT = 5000;
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

app.get('/api/videos', (req, res) => {
  const videoExts = /\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v)$/i;
  const files = fs.readdirSync(UPLOADS_DIR).filter(f => videoExts.test(f));
  const videos = files
    .map(f => {
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
    })
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  res.json(videos);
});

app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ts = parseInt(req.file.filename.split('-')[0]);
  res.json({
    id: req.file.filename,
    name: req.file.originalname.replace(/\.[^.]+$/, ''),
    filename: req.file.filename,
    url: `/uploads/${encodeURIComponent(req.file.filename)}`,
    size: req.file.size,
    uploadedAt: new Date(ts).toISOString(),
  });
});

app.delete('/api/videos/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
