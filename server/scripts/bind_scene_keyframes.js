#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    videoId: null,
    videoPath: null,
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    overwrite: false,
    quality: 4,
    width: 1280,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--video' && argv[i + 1]) { opts.videoPath = argv[++i]; continue; }
    if (arg === '--ffmpeg' && argv[i + 1]) { opts.ffmpeg = argv[++i]; continue; }
    if (arg === '--quality' && argv[i + 1]) { opts.quality = Number(argv[++i]); continue; }
    if (arg === '--width' && argv[i + 1]) { opts.width = Number(argv[++i]); continue; }
    if (arg === '--overwrite') { opts.overwrite = true; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
    if (!opts.videoId && !arg.startsWith('--')) opts.videoId = arg;
  }

  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/bind_scene_keyframes.js <video_id> [options]

Options:
  --video <path>     Video path. Defaults to uploads/<video_id>.mp4, then .mkv.
  --ffmpeg <path>    FFmpeg executable path. Defaults to FFMPEG_PATH or ffmpeg.
  --width <px>       Scale output width, preserving aspect ratio. Default: 1280.
  --quality <n>      FFmpeg q:v value. Lower is better. Default: 4.
  --overwrite        Re-extract frames even if files already exist.
  --dry-run          Print planned frame times without writing.

Example:
  node scripts/bind_scene_keyframes.js house_of_dragon_s03e01 --overwrite
`);
}

function resolveFromServer(input) {
  if (!input) return null;
  return path.isAbsolute(input) ? input : path.join(SERVER_DIR, input);
}

function defaultVideoPath(videoId) {
  for (const ext of ['mp4', 'mkv', 'mov', 'webm', 'm4v']) {
    const candidate = path.join(SERVER_DIR, 'uploads', `${videoId}.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function sceneNumber(scene, index) {
  const match = String(scene.scene_id || '').match(/(\d+)$/);
  const n = match ? Number(match[1]) : index + 1;
  return String(n).padStart(3, '0');
}

function pickFrameTime(scene) {
  const start = Number(scene.start_time);
  const end = Number(scene.end_time);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const duration = end - start;
  if (duration <= 8) return start + duration / 2;
  return start + Math.min(Math.max(duration * 0.35, 3), 18);
}

function extractFrame({ ffmpeg, videoPath, outputPath, time, width, quality }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const args = [
      '-y',
      '-ss', time.toFixed(3),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', `scale=${width}:-1`,
      '-q:v', String(quality),
      '-loglevel', 'error',
      outputPath,
    ];
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(0, 800)}`));
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();
  if (!opts.videoId) throw new Error('Usage: node scripts/bind_scene_keyframes.js <video_id> [options]');

  const kbPath = path.join(SERVER_DIR, 'kb', `${opts.videoId}.json`);
  if (!fs.existsSync(kbPath)) throw new Error(`KB not found: ${kbPath}`);

  const videoPath = resolveFromServer(opts.videoPath) || defaultVideoPath(opts.videoId);
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`Video not found. Pass --video <path> or place uploads/${opts.videoId}.mp4`);
  }

  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const scenes = Array.isArray(kb.scenes) ? kb.scenes : [];
  const frameDir = path.join(SERVER_DIR, 'kb', 'frames', opts.videoId);
  let extracted = 0;
  let reused = 0;
  let skipped = 0;

  console.log(`Binding keyframes for ${opts.videoId}`);
  console.log(`  scenes: ${scenes.length}`);
  console.log(`  video:  ${path.relative(process.cwd(), videoPath)}`);
  console.log(`  frames: ${path.relative(process.cwd(), frameDir)}`);

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const num = sceneNumber(scene, i);
    const rel = `frames/${opts.videoId}/scene-${num}.jpg`;
    const outputPath = path.join(SERVER_DIR, 'kb', rel);
    const time = pickFrameTime(scene);

    if (time == null) {
      skipped++;
      continue;
    }

    scene.keyframe = rel;
    if (!opts.overwrite && fs.existsSync(outputPath)) {
      reused++;
      continue;
    }

    if (opts.dryRun) {
      console.log(`${scene.scene_id || num}: ${time.toFixed(3)}s -> ${rel}`);
      continue;
    }

    await extractFrame({
      ffmpeg: opts.ffmpeg,
      videoPath,
      outputPath,
      time,
      width: opts.width,
      quality: opts.quality,
    });
    extracted++;
    if (extracted % 10 === 0) console.log(`  extracted ${extracted}/${scenes.length}`);
  }

  kb.keyframes_bound_at = new Date().toISOString();
  kb.keyframes_source_video = path.relative(SERVER_DIR, videoPath).replace(/\\/g, '/');

  if (!opts.dryRun) {
    fs.writeFileSync(kbPath, `${JSON.stringify(kb, null, 2)}\n`, 'utf8');
  }

  console.log(`Done. extracted=${extracted}, reused=${reused}, skipped=${skipped}`);
  console.log(`KB: ${path.relative(process.cwd(), kbPath)}`);
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
