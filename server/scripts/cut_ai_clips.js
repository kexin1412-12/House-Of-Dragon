#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { buildSceneSlicingUserPrompt } = require('../lib/ai/prompts/sceneSlicing');
const { formatClipSrt, formatPromptSubtitles, parseSrt } = require('../lib/srt');

const SERVER_DIR = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = {
    videoPath: null,
    candidatesPath: null,
    srtPath: null,
    outputDir: null,
    ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
    audioLanguage: 'eng',
    audioStreamIndex: null,
    maxWidth: 1280,
    crf: 25,
    preset: 'medium',
    audioBitrate: '96k',
    copy: false,
    dryRun: false,
  };
  const valueOptions = {
    '--candidates': 'candidatesPath',
    '--srt': 'srtPath',
    '--output-dir': 'outputDir',
    '--ffmpeg': 'ffmpeg',
    '--ffprobe': 'ffprobe',
    '--audio-language': 'audioLanguage',
    '--audio-stream-index': 'audioStreamIndex',
    '--max-width': 'maxWidth',
    '--crf': 'crf',
    '--preset': 'preset',
    '--audio-bitrate': 'audioBitrate',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
    if (arg === '--copy') { opts.copy = true; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; continue; }

    if (arg.startsWith('--')) {
      const key = valueOptions[arg];
      if (!key) throw new Error(`Unknown option: ${arg}`);
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new Error(`Option ${arg} requires a value`);
      }
      opts[key] = argv[++i];
      continue;
    }

    if (!opts.videoPath) opts.videoPath = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  opts.maxWidth = Number(opts.maxWidth);
  opts.crf = Number(opts.crf);
  if (!Number.isInteger(opts.maxWidth) || opts.maxWidth < 2) throw new Error('--max-width must be an integer of at least 2');
  if (!Number.isInteger(opts.crf) || opts.crf < 0 || opts.crf > 51) throw new Error('--crf must be an integer from 0 to 51');
  if (!/^\d+(?:\.\d+)?[kKmM]?$/.test(String(opts.audioBitrate))) throw new Error('--audio-bitrate must look like 96k or 0.1M');
  if (opts.audioStreamIndex != null) {
    opts.audioStreamIndex = Number(opts.audioStreamIndex);
    if (!Number.isInteger(opts.audioStreamIndex) || opts.audioStreamIndex < 0) {
      throw new Error('--audio-stream-index must be a non-negative integer');
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
Usage: node scripts/cut_ai_clips.js <video_path> --candidates <json> [options]

Create Gemini-ready MP4/SRT clips plus a manifest from scene candidate packages.

Options:
  --candidates <path>          Candidate JSON from scene-candidates (required)
  --srt <path>                 Source SRT (default: candidate source_srt)
  --output-dir <path>          Output directory (default: uploads/ai-clips/<video_id>)
  --audio-language <code>      Preferred audio language (default: eng; use auto for first)
  --audio-stream-index <index> Select an absolute FFmpeg audio stream index
  --max-width <pixels>         Do not encode wider than this (default: 1280)
  --crf <0-51>                 H.264 quality value (default: 25)
  --preset <name>              libx264 preset (default: medium)
  --audio-bitrate <rate>       AAC bitrate (default: 96k)
  --ffmpeg <path>              FFmpeg executable (default: FFMPEG_PATH or ffmpeg)
  --ffprobe <path>             FFprobe executable (default: FFPROBE_PATH or ffprobe)
  --copy                       Stream-copy instead of accurate H.264/AAC encoding
  --dry-run                    Validate and print the plan without writing files
  -h, --help                   Show this help

Example:
  npm run cut-ai-clips -- uploads/episode.mkv --candidates kb/_drafts/episode.scene-candidates.json
`);
}

function resolveServerPath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(SERVER_DIR, value);
}

function displayPath(value) {
  const relative = path.relative(SERVER_DIR, value);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : value;
}

function isInsidePath(filePath, directoryPath) {
  const relative = path.relative(directoryPath, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function inferEpisode(videoId) {
  const match = videoId.match(/s(\d{1,2})e(\d{1,2})/i);
  return match ? `S${match[1].padStart(2, '0')}E${match[2].padStart(2, '0')}` : '';
}

function runProcess(command, args, { echoStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      stderr = `${stderr}${text}`.slice(-16000);
      if (echoStderr) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(-1500)}`));
    });
  });
}

async function probeMedia(ffprobe, videoPath) {
  const { stdout } = await runProcess(ffprobe, [
    '-v', 'error',
    '-show_entries',
    'format=duration:stream=index,codec_type,codec_name,width,height,color_transfer,color_primaries,color_space:stream_tags=language,title',
    '-of', 'json',
    videoPath,
  ]);
  const data = JSON.parse(stdout);
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`FFprobe returned an invalid duration for: ${videoPath}`);

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error(`No video stream found in: ${videoPath}`);
  return { duration: round(duration), streams, video };
}

function selectAudioStream(streams, opts) {
  const audioStreams = streams.filter(stream => stream.codec_type === 'audio');
  if (!audioStreams.length) return null;

  if (opts.audioStreamIndex != null) {
    const selected = audioStreams.find(stream => Number(stream.index) === opts.audioStreamIndex);
    if (!selected) throw new Error(`Audio stream index ${opts.audioStreamIndex} was not found`);
    return selected;
  }

  if (String(opts.audioLanguage).toLowerCase() === 'auto') return audioStreams[0];
  const language = String(opts.audioLanguage).toLowerCase();
  const selected = audioStreams.find(stream => String(stream.tags?.language || '').toLowerCase() === language);
  if (selected) return selected;

  console.warn(`Warning: audio language ${opts.audioLanguage} was not found; using stream ${audioStreams[0].index}.`);
  return audioStreams[0];
}

function isHdrVideo(videoStream) {
  return ['smpte2084', 'arib-std-b67'].includes(String(videoStream.color_transfer || '').toLowerCase());
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function normalizePackages(candidateData, mediaDuration) {
  const rawPackages = candidateData.clip_packages || candidateData.clips;
  if (!Array.isArray(rawPackages) || !rawPackages.length) {
    throw new Error('Candidate JSON has no clip_packages array');
  }

  const packages = rawPackages.map((item, index) => ({
    raw: item,
    clipIndex: Number(item.clip_index) || index + 1,
    start: firstFinite(item.clip_start_time, item.start_time, item.absolute_start_time),
    end: firstFinite(item.clip_end_time, item.end_time, item.absolute_end_time),
  })).sort((a, b) => a.start - b.start);

  for (let i = 0; i < packages.length; i++) {
    const current = packages[i];
    if (!Number.isFinite(current.start) || !Number.isFinite(current.end) || current.end <= current.start) {
      throw new Error(`Invalid range in clip package ${current.clipIndex}`);
    }
    if (i === 0 && Math.abs(current.start) > 0.05) {
      throw new Error(`First clip package must start at 0, got ${current.start}`);
    }
    if (i > 0 && Math.abs(current.start - packages[i - 1].end) > 0.05) {
      throw new Error(`Clip packages are not continuous near ${packages[i - 1].end}/${current.start}`);
    }
    if (i < packages.length - 1 && current.end > mediaDuration + 0.05) {
      throw new Error(`Clip package ${current.clipIndex} ends after the media duration`);
    }
  }

  if (packages.at(-1).start >= mediaDuration) {
    throw new Error(`Last clip starts after the media ends (${packages.at(-1).start} >= ${mediaDuration})`);
  }

  const normalized = [];
  for (let index = 0; index < packages.length; index++) {
    const item = packages[index];
    const start = index === 0 ? 0 : normalized.at(-1).end;
    const end = index === packages.length - 1 ? mediaDuration : round(item.end);
    if (end <= start) throw new Error(`Clip package ${item.clipIndex} becomes empty after timeline normalization`);
    normalized.push({ ...item, start, end });
  }
  return normalized;
}

function uniqueBoundaries(boundaries, start, end) {
  const seen = new Set();
  return boundaries
    .filter(item => item && Number.isFinite(Number(item.time)))
    .filter(item => Number(item.time) >= start - 0.001 && Number(item.time) <= end + 0.001)
    .sort((a, b) => Number(a.time) - Number(b.time) || String(a.reason).localeCompare(String(b.reason)))
    .filter(item => {
      const key = [round(item.time), item.reason || '', item.scene_id || '', item.gap_sec ?? ''].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function formatFilenameTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds)));
  const secs = total % 60;
  const totalMinutes = Math.floor(total / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}${String(secs).padStart(2, '0')}`;
}

function buildVideoFilter(
  sourceHdr,
  maxWidth,
  sourceTransfer = 'smpte2084',
  sourcePrimaries = 'bt2020',
  sourceMatrix = 'bt2020nc',
) {
  const scale = `scale=w='trunc(min(${maxWidth},iw)/2)*2':h=-2:flags=lanczos`;
  if (!sourceHdr) return `${scale},format=yuv420p`;
  const transfer = sourceTransfer === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084';
  const primaries = ['bt709', 'bt2020'].includes(sourcePrimaries) ? sourcePrimaries : 'bt2020';
  const matrix = ['bt709', 'bt2020nc', 'bt2020c'].includes(sourceMatrix) ? sourceMatrix : 'bt2020nc';
  return [
    `zscale=primariesin=${primaries}:transferin=${transfer}:matrixin=${matrix}:transfer=linear:npl=100`,
    'format=gbrpf32le',
    'zscale=primaries=bt709',
    'tonemap=tonemap=hable:desat=0',
    'zscale=transfer=bt709:matrix=bt709:range=tv',
    scale,
    'format=yuv420p',
  ].join(',');
}

function makeFfmpegArgs({
  videoPath,
  outputPath,
  start,
  end,
  audioStream,
  sourceHdr,
  sourceTransfer,
  sourcePrimaries,
  sourceMatrix,
  opts,
}) {
  const duration = round(end - start);
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-loglevel', 'warning', '-stats',
    '-ss', String(round(start)),
    '-i', videoPath,
    '-t', String(duration),
    '-map', '0:v:0',
  ];
  if (audioStream) args.push('-map', `0:${audioStream.index}`);
  else args.push('-an');
  args.push('-map_metadata', '-1', '-map_chapters', '-1');

  if (opts.copy) {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  } else {
    args.push(
      '-vf', buildVideoFilter(sourceHdr, opts.maxWidth, sourceTransfer, sourcePrimaries, sourceMatrix),
      '-c:v', 'libx264',
      '-preset', opts.preset,
      '-crf', String(opts.crf),
      '-pix_fmt', 'yuv420p',
    );
    if (audioStream) {
      args.push('-c:a', 'aac', '-b:a', String(opts.audioBitrate), '-ac', '2');
      if (audioStream.tags?.language) args.push('-metadata:s:a:0', `language=${audioStream.tags.language}`);
    }
  }
  args.push('-movflags', '+faststart', outputPath);
  return args;
}

function replaceFile(tempPath, finalPath) {
  if (fs.existsSync(finalPath)) fs.rmSync(finalPath, { force: true });
  fs.renameSync(tempPath, finalPath);
}

function atomicWriteText(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, value, 'utf8');
  replaceFile(tempPath, filePath);
}

function commitOutputDirectory(stagingDir, outputDir) {
  const backupDir = `${outputDir}.backup-${process.pid}-${Date.now()}`;
  const hadPreviousOutput = fs.existsSync(outputDir);
  if (hadPreviousOutput) fs.renameSync(outputDir, backupDir);

  try {
    fs.renameSync(stagingDir, outputDir);
  } catch (error) {
    if (hadPreviousOutput && !fs.existsSync(outputDir) && fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, outputDir);
    }
    throw error;
  }

  if (hadPreviousOutput) {
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Warning: new output is active, but old backup could not be removed: ${backupDir} (${error.message})`);
    }
  }
}

function buildClipPlans({ candidateData, packages, cues, videoId, episode }) {
  const globalBoundaries = Array.isArray(candidateData.candidate_boundaries) ? candidateData.candidate_boundaries : [];

  return packages.map((item, index) => {
    const start = item.start;
    const end = item.end;
    const packageBoundaries = Array.isArray(item.raw.candidate_boundaries) ? item.raw.candidate_boundaries : [];
    const candidateBoundaries = uniqueBoundaries([...globalBoundaries, ...packageBoundaries], start, end);
    const frameNotes = Array.isArray(item.raw.frame_notes)
      ? item.raw.frame_notes.filter(note => Number(note.time) >= start && Number(note.time) <= end)
      : [];
    const originalStart = firstFinite(item.raw.clip_start_time, item.raw.start_time, item.raw.absolute_start_time);
    const originalEnd = firstFinite(item.raw.clip_end_time, item.raw.end_time, item.raw.absolute_end_time);
    const subtitles = formatPromptSubtitles(cues, start, end);
    const rangeChanged = Math.abs(start - originalStart) > 0.01 || Math.abs(end - originalEnd) > 0.01;
    const continuesFromPreviousPackage = Boolean(item.raw.continues_from_previous_package) || candidateBoundaries.some(
      boundary => boundary.reason === 'max_duration_guardrail' && Math.abs(Number(boundary.time) - start) < 0.001,
    );
    const continuesToNextPackage = Boolean(item.raw.continues_to_next_package) || candidateBoundaries.some(
      boundary => boundary.reason === 'max_duration_guardrail' && Math.abs(Number(boundary.time) - end) < 0.001,
    );
    const clipBoundaryContext = continuesFromPreviousPackage || continuesToNextPackage
      ? {
        continues_from_previous_package: continuesFromPreviousPackage,
        continues_to_next_package: continuesToNextPackage,
        instruction: 'Do not treat a forced package boundary as a dramatic-scene boundary without visual/story evidence.',
      }
      : null;
    const geminiUserPrompt = !rangeChanged && item.raw.gemini_user_prompt
      ? item.raw.gemini_user_prompt
      : buildSceneSlicingUserPrompt({
        videoId,
        episode,
        clipIndex: index + 1,
        clipStartTime: start,
        clipEndTime: end,
        subtitles,
        candidateBoundaries,
        frameNotes,
        clipBoundaryContext,
      });
    const stem = `clip-${String(index + 1).padStart(3, '0')}_${formatFilenameTime(start)}-${formatFilenameTime(end)}`;

    return {
      clipIndex: index + 1,
      start,
      end,
      duration: round(end - start),
      videoFile: `${stem}.mp4`,
      subtitleFile: `${stem}.srt`,
      candidateBoundaries,
      geminiUserPrompt,
    };
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();
  if (!opts.videoPath) throw new Error('<video_path> is required; use --help for usage');
  if (!opts.candidatesPath) throw new Error('--candidates <json> is required');

  const videoPath = resolveServerPath(opts.videoPath);
  const candidatesPath = resolveServerPath(opts.candidatesPath);
  if (!fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  if (!fs.existsSync(candidatesPath)) throw new Error(`Candidate JSON not found: ${candidatesPath}`);

  const candidateData = JSON.parse(fs.readFileSync(candidatesPath, 'utf8').replace(/^\uFEFF/, ''));
  const videoId = candidateData.video_id || path.basename(videoPath, path.extname(videoPath));
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(videoId)) throw new Error(`Unsafe video_id in candidate JSON: ${videoId}`);
  const episode = candidateData.episode || inferEpisode(videoId);
  const srtPath = resolveServerPath(opts.srtPath || candidateData.source_srt || path.join('uploads', `${videoId}.srt`));
  if (!fs.existsSync(srtPath)) throw new Error(`Subtitle file not found: ${srtPath}`);
  const cues = parseSrt(fs.readFileSync(srtPath, 'utf8'));
  if (!cues.length) throw new Error(`No valid SRT cues found in: ${srtPath}`);

  const media = await probeMedia(opts.ffprobe, videoPath);
  const audioStream = selectAudioStream(media.streams, opts);
  const sourceHdr = isHdrVideo(media.video);
  const packages = normalizePackages(candidateData, media.duration);
  const plans = buildClipPlans({ candidateData, packages, cues, videoId, episode });
  const outputDir = resolveServerPath(opts.outputDir || path.join('uploads', 'ai-clips', videoId));
  for (const inputPath of [videoPath, candidatesPath, srtPath]) {
    if (isInsidePath(inputPath, outputDir)) {
      throw new Error(`Output directory must not contain an input file: ${outputDir}`);
    }
  }

  console.log(`${opts.dryRun ? '[dry-run] ' : ''}AI clip plan for ${videoId}`);
  console.log(`  media: ${displayPath(videoPath)} (${media.duration}s, ${media.video.width}x${media.video.height})`);
  console.log(`  audio: ${audioStream ? `stream ${audioStream.index} (${audioStream.tags?.language || 'unknown'})` : 'none'}`);
  console.log(`  HDR: ${sourceHdr ? `yes (${media.video.color_transfer})` : 'no'}`);
  console.log(`  output: ${displayPath(outputDir)}`);
  for (const plan of plans) {
    console.log(`  ${String(plan.clipIndex).padStart(2, '0')}: ${plan.start}s -> ${plan.end}s  ${plan.videoFile}`);
  }
  if (opts.dryRun) return;

  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  const stagingDir = path.join(
    path.dirname(outputDir),
    `.${path.basename(outputDir)}.staging-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(stagingDir);

  try {
    for (const plan of plans) {
      const finalVideoPath = path.join(stagingDir, plan.videoFile);
      const tempVideoPath = path.join(stagingDir, `${path.basename(plan.videoFile, '.mp4')}.part-${process.pid}.mp4`);
      const finalSrtPath = path.join(stagingDir, plan.subtitleFile);
      console.log(`\n[${plan.clipIndex}/${plans.length}] Encoding ${plan.videoFile}`);

      try {
        const args = makeFfmpegArgs({
          videoPath,
          outputPath: tempVideoPath,
          start: plan.start,
          end: plan.end,
          audioStream,
          sourceHdr,
          sourceTransfer: media.video.color_transfer,
          sourcePrimaries: media.video.color_primaries,
          sourceMatrix: media.video.color_space,
          opts,
        });
        await runProcess(opts.ffmpeg, args, { echoStderr: true });
        replaceFile(tempVideoPath, finalVideoPath);
        atomicWriteText(finalSrtPath, formatClipSrt(cues, plan.start, plan.end));
      } catch (error) {
        fs.rmSync(tempVideoPath, { force: true });
        throw error;
      }
    }

    const bitrateLabel = String(opts.audioBitrate).toLowerCase();
    const manifest = {
      video_id: videoId,
      episode,
      generated_by: path.basename(__filename),
      generated_at: new Date().toISOString(),
      source_video: displayPath(videoPath),
      source_srt: displayPath(srtPath),
      media_duration_sec: media.duration,
      audio_language: audioStream?.tags?.language || null,
      audio_stream_index: audioStream ? Number(audioStream.index) : null,
      source_hdr: sourceHdr,
      source_color_transfer: media.video.color_transfer || null,
      tone_mapped_to_sdr: sourceHdr && !opts.copy,
      accurate_boundaries: !opts.copy,
      boundary_accuracy: opts.copy ? 'keyframe-dependent' : 'exact',
      encoding: opts.copy
        ? 'stream_copy'
        : `h264_crf_${opts.crf}_${audioStream ? `aac_${bitrateLabel}` : 'no_audio'}`,
      clips: plans.map(plan => ({
        clip_index: plan.clipIndex,
        video_file: plan.videoFile,
        subtitle_file: plan.subtitleFile,
        absolute_start_time: plan.start,
        absolute_end_time: plan.end,
        duration_sec: plan.duration,
        accurate_boundaries: !opts.copy,
        candidate_boundaries: plan.candidateBoundaries,
        gemini_user_prompt: plan.geminiUserPrompt,
      })),
    };
    atomicWriteText(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    commitOutputDirectory(stagingDir, outputDir);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
  console.log(`\nDone: ${displayPath(path.join(outputDir, 'manifest.json'))}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`ERROR: ${error.message}`);
    if (error.code === 'ENOENT') console.error('Make sure FFmpeg and FFprobe are installed or pass --ffmpeg/--ffprobe.');
    process.exitCode = 1;
  });
}

module.exports = {
  buildClipPlans,
  buildVideoFilter,
  formatFilenameTime,
  makeFfmpegArgs,
  normalizePackages,
  parseArgs,
};
