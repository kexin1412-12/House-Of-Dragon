#!/usr/bin/env node
/**
 * ASR step of L1 preprocessing:
 *   video → ffmpeg (extract audio) → OpenAI audio.transcriptions → .srt
 *
 * Only needed when the video doesn't already have a .srt / .vtt next to it.
 * Output goes to uploads/<video_id>.srt so annotate.js can auto-detect it.
 *
 * Usage:
 *   node scripts/transcribe.js <video_path> [--model gpt-4o-mini-transcribe] [--language zh]
 *   npm run transcribe -- uploads/foo.mp4
 *
 * Models: gpt-4o-mini-transcribe (default, ~$0.006/min), gpt-4o-transcribe (~$0.012/min).
 *
 * OpenAI audio endpoint enforces a 25MB file-size cap — we extract ~128kbps mono
 * mp3 which keeps ~30 min of audio under the cap. Longer clips need chunking
 * (not done here; slice with `ffmpeg -ss T1 -t T2 -c copy` first).
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const MAX_MB = 25;
// whisper-1 is the default because it natively emits `srt` with aligned
// timestamps — essential for per-scene subtitle windowing in annotate.js.
// gpt-4o-mini-transcribe / gpt-4o-transcribe only support `json` / `text`
// formats and currently don't expose word-level timestamps, so they can't
// directly produce a per-line SRT. Same price ($0.006/min) as whisper-1.
const DEFAULT_MODEL = 'whisper-1';
const SRT_CAPABLE_MODELS = new Set(['whisper-1']);

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { videoPath: null, model: DEFAULT_MODEL, language: null, bitrate: '64k', help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) { opts.model = args[++i]; continue; }
    if (args[i] === '--language' && args[i + 1]) { opts.language = args[++i]; continue; }
    if (args[i] === '--bitrate' && args[i + 1]) { opts.bitrate = args[++i]; continue; }
    if (args[i] === '-h' || args[i] === '--help') { opts.help = true; continue; }
    if (!opts.videoPath && !args[i].startsWith('--')) opts.videoPath = args[i];
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/transcribe.js <video_path> [options]

Options:
  --model <name>      OpenAI transcribe model (default: ${DEFAULT_MODEL})
                      Others: gpt-4o-transcribe, whisper-1
  --language <code>   Force language code, e.g. zh / en / ja. Default: auto-detect.
  -h, --help          Show this help.

Examples:
  node scripts/transcribe.js uploads/clip.mp4
  node scripts/transcribe.js uploads/clip.mp4 --language zh
`);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${stderr}`)));
  });
}

async function extractAudio(videoPath, outPath, bitrate = '64k') {
  // -vn: no video. -ac 1: mono (smaller). -ar 16000: 16kHz is plenty for speech.
  // -b:a 64k: ~30 min fits under 25MB. For 60min episodes use 32k (~14MB).
  await run('ffmpeg', [
    '-y', '-i', videoPath,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', bitrate,
    '-f', 'mp3', outPath,
  ]);
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
  if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY not set (see server/.env)');
    process.exit(1);
  }

  const serverDir = path.join(__dirname, '..');
  const videoId = path.basename(opts.videoPath, path.extname(opts.videoPath))
    .replace(/[^a-zA-Z0-9_\-]/g, '_');
  const srtOut = path.join(serverDir, 'uploads', `${videoId}.srt`);
  const tmpAudio = path.join(os.tmpdir(), `tx_${videoId}_${Date.now()}.mp3`);

  try {
    console.log(`\n[1/3] Extracting audio with ffmpeg @ ${opts.bitrate} mono → ${path.basename(tmpAudio)}`);
    await extractAudio(opts.videoPath, tmpAudio, opts.bitrate);

    const stat = fs.statSync(tmpAudio);
    const mb = (stat.size / 1024 / 1024).toFixed(2);
    console.log(`       audio: ${mb} MB`);
    if (stat.size > MAX_MB * 1024 * 1024) {
      console.error(
        `\n✗ audio exceeds OpenAI's ${MAX_MB}MB limit. Pre-clip the video first, e.g.:\n` +
        `  ffmpeg -ss 00:00 -t 00:30:00 -i ${opts.videoPath} -c copy uploads/clip.mp4`
      );
      process.exit(1);
    }

    if (!SRT_CAPABLE_MODELS.has(opts.model)) {
      console.error(
        `\n✗ Model '${opts.model}' does not support SRT output. Use whisper-1 (default)` +
        ` — it aligns timestamps, which annotate.js needs for per-scene subtitle windows.`
      );
      process.exit(1);
    }
    console.log(`\n[2/3] Transcribing via OpenAI (${opts.model})...`);
    const OpenAI = require('openai');
    const client = new OpenAI();
    const t0 = Date.now();
    const createParams = {
      file: fs.createReadStream(tmpAudio),
      model: opts.model,
      response_format: 'srt',
    };
    if (opts.language) createParams.language = opts.language;
    const srt = await client.audio.transcriptions.create(createParams);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const srtText = typeof srt === 'string' ? srt : (srt.text || '');
    const lineCount = srtText.split(/\r?\n\r?\n/).filter(b => b.includes('-->')).length;
    console.log(`       done in ${elapsed}s, ${lineCount} subtitle entries`);

    console.log(`\n[3/3] Writing SRT...`);
    fs.mkdirSync(path.dirname(srtOut), { recursive: true });
    fs.writeFileSync(srtOut, srtText);
    console.log(`       ${path.relative(process.cwd(), srtOut)}`);

    console.log(`\n✓ Done.`);
    console.log(`\nNext step: \`npm run annotate -- ${videoId}\` will auto-pick up this SRT.`);
  } finally {
    if (fs.existsSync(tmpAudio)) {
      try { fs.unlinkSync(tmpAudio); } catch { /* ignore */ }
    }
  }
}

main().catch(err => {
  console.error(`\n✗ ERROR: ${err.message}`);
  if (err.status) console.error(`  HTTP ${err.status}`);
  if (err.message && err.message.includes('ENOENT') && err.message.toLowerCase().includes('ffmpeg')) {
    console.error(`\nffmpeg not on PATH. Open a fresh terminal (winget updates PATH for new shells only),`);
    console.error(`or reinstall: winget install --id=Gyan.FFmpeg --source=winget`);
  }
  process.exit(1);
});
