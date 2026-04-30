/**
 * KB 写入安全包装（Node 版）：每次落盘前先把当前磁盘上的版本快照一份。
 * 与 server/lib/kb_io.py 行为完全一致，备份目录共享。
 *
 * 用法：
 *   const { saveKbSafely } = require('./lib/kb_io');
 *   saveKbSafely(kb, '/abs/path/to/kb.json');
 */
const fs = require('fs');
const path = require('path');

function ts() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
         `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-` +
         `${pad(d.getUTCMilliseconds(), 3)}000`;  // 6 位仿 microseconds
}

function backupsDir(targetPath) {
  const abs = path.resolve(targetPath);
  const baseDir = path.dirname(abs);
  const stem = path.basename(abs, path.extname(abs));
  return path.join(baseDir, '.backups', stem);
}

function snapshot(targetPath) {
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) return null;
  const bdir = backupsDir(abs);
  fs.mkdirSync(bdir, { recursive: true });
  const bpath = path.join(bdir, `${ts()}.json`);
  fs.copyFileSync(abs, bpath);
  return bpath;
}

function pruneBackups(targetPath, maxKeep = 20) {
  const bdir = backupsDir(targetPath);
  if (!fs.existsSync(bdir)) return;
  const files = fs.readdirSync(bdir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ p: path.join(bdir, f), m: fs.statSync(path.join(bdir, f)).mtimeMs }))
    .sort((a, b) => a.m - b.m);
  const excess = files.length - maxKeep;
  if (excess > 0) {
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(files[i].p); } catch { /* swallow */ }
    }
  }
}

/**
 * 备份现有 → 写新内容（先 .tmp 再 rename）→ 修剪旧备份。
 * 返回 { backup, target }。
 */
function saveKbSafely(kb, targetPath, maxBackups = 20) {
  const abs = path.resolve(targetPath);
  const backup = snapshot(abs);
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(kb, null, 2), 'utf8');
  fs.renameSync(tmp, abs);
  pruneBackups(abs, maxBackups);
  return { backup, target: abs };
}

function listBackups(targetPath) {
  const bdir = backupsDir(targetPath);
  if (!fs.existsSync(bdir)) return [];
  return fs.readdirSync(bdir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ p: path.join(bdir, f), m: fs.statSync(path.join(bdir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map(o => o.p);
}

module.exports = { saveKbSafely, snapshot, pruneBackups, listBackups, backupsDir };
