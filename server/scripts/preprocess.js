#!/usr/bin/env node
/**
 * Video preprocessing pipeline (L1 of the architecture):
 *   video file → PySceneDetect → scene cuts + keyframes → KB skeleton JSON
 *
 * Usage:
 *   node scripts/preprocess.js <video_path> [--id <video_id>] [--threshold N]
 *
 * Or via npm:
 *   npm run preprocess -- <video_path>
 *
 * Output:
 *   server/kb/<video_id>.json         — KB skeleton with empty plot/narrative/shot
 *   server/kb/frames/<video_id>/*.jpg — one keyframe per detected scene
 *
 * Requires: Python 3.10+, PySceneDetect (`pip install "scenedetect[opencv]"`).
 * FFmpeg is NOT required for the detect-content + save-images pipeline; only
 * needed if you later add split-video or audio extraction steps.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const kbPaths = require('../lib/kb-paths');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { videoPath: null, videoId: null, threshold: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id' && args[i + 1]) { opts.videoId = args[++i]; continue; }
    if (args[i] === '--threshold' && args[i + 1]) { opts.threshold = args[++i]; continue; }
    if (args[i] === '-h' || args[i] === '--help') { opts.help = true; continue; }
    if (!opts.videoPath && !args[i].startsWith('--')) opts.videoPath = args[i];
  }
  return opts;
}

function sanitizeId(s) {
  return s.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
    p.stderr.on('data', d => process.stderr.write(d));
    p.on('error', reject);
    p.on('close', code => code === 0
      ? resolve(stdout)
      : reject(new Error(`${cmd} exited with code ${code}`)));
  });
}

// Parse the CSV that `list-scenes` emits.
// Header row starts with "Scene Number". Earlier rows are timecode metadata.
function parseScenesCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  const headerIdx = lines.findIndex(l => l.startsWith('Scene Number'));
  if (headerIdx < 0) throw new Error('Could not locate header row in scene CSV');

  const header = lines[headerIdx].split(',').map(h => h.trim());
  const sIdx = header.indexOf('Start Time (seconds)');
  const eIdx = header.indexOf('End Time (seconds)');
  if (sIdx < 0 || eIdx < 0) throw new Error('Missing Start/End Time columns');

  return lines.slice(headerIdx + 1).map(line => {
    const cols = line.split(',');
    return {
      start_time: Number(cols[sIdx]),
      end_time: Number(cols[eIdx]),
    };
  }).filter(s => Number.isFinite(s.start_time) && Number.isFinite(s.end_time));
}

function findKeyframeFor(frameDir, sceneIdx) {
  // scenedetect save-images with -f "scene-$SCENE_NUMBER" produces "scene-001-01.jpg"
  // (trailing -01 is image number when only 1 image requested).
  // We match any file with the zero-padded scene number.
  const num = String(sceneIdx + 1).padStart(3, '0');
  const entries = fs.readdirSync(frameDir)
    .filter(f => f.startsWith(`scene-${num}`) && /\.(jpg|jpeg|png)$/i.test(f));
  return entries[0] || null;
}

function printHelp() {
  console.log(`
Usage: node scripts/preprocess.js <video_path> [options]

Options:
  --id <video_id>     Override output KB id (default: video filename stem)
  --threshold <N>     PySceneDetect content threshold (default: 27, higher = fewer cuts)
  -h, --help          Show this help

Example:
  node scripts/preprocess.js uploads/1776-got.mp4
  node scripts/preprocess.js uploads/1776-got.mp4 --id got_s06e10 --threshold 30
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

  const videoBasename = path.basename(opts.videoPath, path.extname(opts.videoPath));
  const videoId = sanitizeId(opts.videoId || videoBasename);
  const serverDir = path.join(__dirname, '..');
  const frameDir = path.join(serverDir, 'kb', 'frames', videoId);
  fs.mkdirSync(frameDir, { recursive: true });

  console.log(`\n[1/3] Running PySceneDetect (detect-content + save-images)`);
  console.log(`       video:     ${opts.videoPath}`);
  console.log(`       video_id:  ${videoId}`);
  console.log(`       frames:    ${frameDir}`);

  const detectArgs = [
    '-m', 'scenedetect',
    '-i', opts.videoPath,
    '-o', frameDir,
    'detect-content',
  ];
  if (opts.threshold) detectArgs.push('--threshold', String(opts.threshold));
  detectArgs.push(
    'list-scenes', '-f', 'scenes.csv',
    'save-images', '-n', '1', '-f', 'scene-$SCENE_NUMBER',
  );

  await run('python', detectArgs);

  console.log(`\n[2/3] Parsing scene list...`);
  const csvPath = path.join(frameDir, 'scenes.csv');
  const rawScenes = parseScenesCsv(fs.readFileSync(csvPath, 'utf8'));
  console.log(`       ${rawScenes.length} scenes detected`);
  if (rawScenes.length === 0) {
    console.error('       No scenes returned; try a lower --threshold (default 27).');
    process.exit(1);
  }

  console.log(`\n[3/3] Writing KB skeleton...`);
  const scenes = rawScenes.map((s, i) => {
    const sceneId = `s${String(i + 1).padStart(2, '0')}`;
    const frameFile = findKeyframeFor(frameDir, i);
    return {
      scene_id: sceneId,
      start_time: Number(s.start_time.toFixed(3)),
      end_time: Number(s.end_time.toFixed(3)),
      keyframe: frameFile ? `frames/${videoId}/${frameFile}` : null,
      plot: null,
      narrative: null,
      shot: null,
      characters: [],
      foreshadow: null,
      tags: [],
      spoiler_level: 0,
    };
  });

  const kb = {
    video_id: videoId,
    title: videoBasename,
    duration: scenes.at(-1)?.end_time ?? 0,
    generated_by: 'preprocess.js',
    generated_at: new Date().toISOString(),
    scenes,
  };

  const kbPath = kbPaths.sceneKb(videoId);
  fs.mkdirSync(kbPaths.videoDir(videoId), { recursive: true });
  fs.writeFileSync(kbPath, JSON.stringify(kb, null, 2));

  console.log(`\n✓ Done.`);
  console.log(`  KB skeleton:  ${path.relative(process.cwd(), kbPath)}`);
  console.log(`  Keyframes:    ${path.relative(process.cwd(), frameDir)}`);
  console.log(`\nNext step: fill plot/narrative/shot/foreshadow for each scene —`);
  console.log(`either manually, or by piping each keyframe + its surrounding subtitle`);
  console.log(`window through GPT-4o (vision) with the scene-annotation prompt.`);
}

main().catch(err => {
  console.error(`\n✗ ERROR: ${err.message}`);
  if (err.message.includes('exited with code') || err.message.includes('ENOENT')) {
    console.error(`\nMake sure Python + PySceneDetect are installed:`);
    console.error(`  python -m pip install "scenedetect[opencv]"`);
  }
  process.exit(1);
});
