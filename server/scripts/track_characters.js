#!/usr/bin/env node
/**
 * Character tracking CLI — Node 包装 scripts/track_characters.py
 *
 * 流程：preprocess.js（PySceneDetect）生成 KB skeleton → 这个脚本填充
 *   scenes[].characters[]（聚合）+ scenes[].characters_on_screen[]（带 bbox）
 *
 * Usage:
 *   node scripts/track_characters.js <video_path> [--id <video_id>] [--fps 1.5]
 *   npm run track-characters -- uploads/foo.mp4
 *
 * 前置：
 *   1. npm run preprocess -- <video_path>      # 先生成 KB skeleton
 *   2. python scripts/build_face_gallery.py    # face_gallery.json 必须已存在
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const kbPaths = require('../lib/kb-paths');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    videoPath: null,
    videoId: null,
    fps: null,
    threshold: null,
    scene: null,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--id' && args[i + 1]) { opts.videoId = args[++i]; continue; }
    if (a === '--fps' && args[i + 1]) { opts.fps = args[++i]; continue; }
    if (a === '--threshold' && args[i + 1]) { opts.threshold = args[++i]; continue; }
    if (a === '--scene' && args[i + 1]) { opts.scene = args[++i]; continue; }
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (!opts.videoPath && !a.startsWith('--')) opts.videoPath = a;
  }
  return opts;
}

function sanitizeId(s) {
  return s.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function printHelp() {
  console.log(`
Usage: node scripts/track_characters.js <video_path> [options]

Options:
  --id <video_id>      Override KB id (default: video filename stem)
  --fps <N>            Frames per second to sample within each scene (default 1.5)
  --threshold <N>      Face match cosine sim threshold (default 0.45)
  --scene <scene_id>   Only process one scene (debugging)
  -h, --help           Show this help

Example:
  node scripts/track_characters.js uploads/house_of_dragon_05.mp4
  node scripts/track_characters.js uploads/foo.mp4 --fps 2 --threshold 0.5
`);
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();

  if (!opts.videoPath) {
    console.error('Error: <video_path> is required.\n');
    printHelp();
    process.exit(1);
  }
  if (!fs.existsSync(opts.videoPath)) {
    console.error(`Error: video not found: ${opts.videoPath}`);
    process.exit(1);
  }

  const serverDir = path.join(__dirname, '..');
  const videoBasename = path.basename(opts.videoPath, path.extname(opts.videoPath));
  const videoId = sanitizeId(opts.videoId || videoBasename);
  const kbPath = kbPaths.sceneKb(videoId);

  if (!fs.existsSync(kbPath)) {
    console.error(`Error: KB not found at ${kbPath}`);
    console.error(`先跑：npm run preprocess -- ${opts.videoPath}`);
    process.exit(1);
  }

  const galleryPath = path.join(serverDir, 'kb', 'characters', 'face_gallery.json');
  if (!fs.existsSync(galleryPath)) {
    console.error(`Error: face_gallery.json not found at ${galleryPath}`);
    console.error(`先构建闭集人脸库：python scripts/build_face_gallery.py`);
    process.exit(1);
  }

  const pyArgs = ['scripts/track_characters.py', opts.videoPath, kbPath];
  if (opts.fps != null) pyArgs.push('--fps', String(opts.fps));
  if (opts.threshold != null) pyArgs.push('--threshold', String(opts.threshold));
  if (opts.scene) pyArgs.push('--scene', opts.scene);

  // PYTHON env var lets you point at a specific interpreter (e.g. an anaconda
  // env that has deepface installed). Defaults to the `python` on PATH.
  const pythonBin = process.env.PYTHON || 'python';
  const py = spawn(pythonBin, pyArgs, { stdio: 'inherit', cwd: serverDir });
  py.on('error', err => {
    console.error(`✗ failed to spawn python: ${err.message}`);
    process.exit(1);
  });
  py.on('close', code => process.exit(code || 0));
}

main();
