#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildSceneSlicingUserPrompt } = require('../lib/ai/prompts/sceneSlicing');
const { formatClockLabel, formatPromptSubtitles, parseSrt } = require('../lib/srt');
const kbPaths = require('../lib/kb-paths');

const SERVER_DIR = path.resolve(__dirname, '..');
const DEFAULTS = {
  softGap: 5,
  hardGap: 10,
  minDuration: 300,
  maxDuration: 480,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, videoId: null, noKb: false };
  const valueOptions = {
    '--episode': 'episode',
    '--srt': 'srtPath',
    '--kb': 'kbPath',
    '--video': 'videoPath',
    '--output': 'outputPath',
    '--duration': 'duration',
    '--ffprobe': 'ffprobe',
    '--soft-gap': 'softGap',
    '--hard-gap': 'hardGap',
    '--min-duration': 'minDuration',
    '--max-duration': 'maxDuration',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') { opts.help = true; continue; }
    if (arg === '--no-kb') { opts.noKb = true; continue; }

    if (arg.startsWith('--')) {
      const key = valueOptions[arg];
      if (!key) throw new Error(`Unknown option: ${arg}`);
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new Error(`Option ${arg} requires a value`);
      }
      opts[key] = argv[++i];
      continue;
    }

    if (!opts.videoId) opts.videoId = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  for (const key of ['softGap', 'hardGap', 'minDuration', 'maxDuration']) {
    const value = Number(opts[key]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${camelToKebab(key)} must be a positive number`);
    opts[key] = value;
  }
  if (opts.duration != null) {
    opts.duration = Number(opts.duration);
    if (!Number.isFinite(opts.duration) || opts.duration <= 0) throw new Error('--duration must be a positive number');
  }
  if (opts.hardGap < opts.softGap) throw new Error('--hard-gap must be greater than or equal to --soft-gap');
  if (opts.minDuration > opts.maxDuration) throw new Error('--min-duration must not exceed --max-duration');

  return opts;
}

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
}

function printHelp() {
  console.log(`
Usage: node scripts/build_scene_candidates.js <video_id> [options]

Build subtitle/KB boundary hints and Gemini-sized analysis packages.

Options:
  --episode <S03E01>       Episode label (inferred from video_id when possible)
  --srt <path>             Subtitle file (default: uploads/<video_id>.srt)
  --kb <path>              Optional KB skeleton (default: kb/<video_id>.json)
  --no-kb                  Ignore an existing KB skeleton
  --video <path>           Source video (default: auto-detect uploads/<video_id>.*)
  --output <path>          Output JSON (default: kb/_drafts/<video_id>.scene-candidates.json)
  --duration <seconds>     Override media duration when a video cannot be probed
  --ffprobe <path>         FFprobe executable (default: FFPROBE_PATH or ffprobe)
  --soft-gap <seconds>     Soft subtitle gap threshold (default: 5)
  --hard-gap <seconds>     Hard subtitle gap threshold (default: 10)
  --min-duration <seconds> Preferred minimum package duration (default: 300)
  --max-duration <seconds> Hard maximum package duration (default: 480)
  -h, --help               Show this help

Example:
  npm run scene-candidates -- house_of_dragon_s03e01 --episode S03E01
`);
}

function resolveServerPath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(SERVER_DIR, value);
}

function displayPath(value) {
  const relative = path.relative(SERVER_DIR, value);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : value;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function inferEpisode(videoId) {
  const match = videoId.match(/s(\d{1,2})e(\d{1,2})/i);
  return match ? `S${match[1].padStart(2, '0')}E${match[2].padStart(2, '0')}` : '';
}

function normalizeCueText(text) {
  return String(text || '').replace(/\s*\n\s*/g, ' / ').replace(/\s+/g, ' ').trim();
}

function isSoundOnlyCue(cue) {
  const text = normalizeCueText(cue.text).replace(/<[^>]+>/g, '').trim();
  return /^(?:\[[^\]]+\]\s*)+$/u.test(text) || /^[♪♫♬].*[♪♫♬]$/u.test(text);
}

function buildSubtitleBoundaries(cues, opts) {
  const boundaryCues = cues.filter(cue => !isSoundOnlyCue(cue));
  const timeline = boundaryCues.length ? boundaryCues : cues;
  const boundaries = [];
  const first = cues[0];
  const last = cues.at(-1);

  boundaries.push({
    time: round(first.start),
    reason: 'subtitle_start',
    confidence: 0.8,
    label: formatClockLabel(first.start),
  });

  let previous = timeline[0];
  let coveredUntil = previous.end;
  for (let i = 1; i < timeline.length; i++) {
    const current = timeline[i];
    const gap = current.start - coveredUntil;
    if (gap >= opts.softGap) {
      const hard = gap >= opts.hardGap;
      boundaries.push({
        time: round(current.start),
        reason: hard ? 'hard_subtitle_gap' : 'soft_subtitle_gap',
        confidence: hard ? 0.92 : 0.65,
        gap_sec: round(gap, 2),
        previous_text: normalizeCueText(previous.text),
        next_text: normalizeCueText(current.text),
        label: formatClockLabel(current.start),
      });
    }

    if (current.end > coveredUntil) {
      coveredUntil = current.end;
      previous = current;
    }
  }

  boundaries.push({
    time: round(last.end),
    reason: 'subtitle_end',
    confidence: 0.8,
    label: formatClockLabel(last.end),
  });

  return boundaries;
}

function buildVisualBoundaries(kb, subtitleBoundaries) {
  if (!kb || kb.generated_by !== 'preprocess.js' || !Array.isArray(kb.scenes)) return [];

  const scenes = kb.scenes
    .filter(scene => Number.isFinite(Number(scene.start_time)) && Number.isFinite(Number(scene.end_time)))
    .sort((a, b) => Number(a.start_time) - Number(b.start_time));
  const accepted = [];

  for (let i = 1; i < scenes.length; i++) {
    const previous = scenes[i - 1];
    const current = scenes[i];
    const previousDuration = Number(previous.end_time) - Number(previous.start_time);
    const currentDuration = Number(current.end_time) - Number(current.start_time);
    const time = round(Number(current.start_time));
    const corroborated = subtitleBoundaries
      .map(boundary => ({ boundary, distance: Math.abs(boundary.time - time) }))
      .filter(item => item.distance <= 1)
      .sort((a, b) => a.distance - b.distance)[0];

    if (corroborated) {
      const boundary = corroborated.boundary;
      boundary.confidence = round(Math.min(0.98, Number(boundary.confidence || 0) + 0.03), 2);
      boundary.signals = [
        ...(Array.isArray(boundary.signals) ? boundary.signals : []),
        { reason: 'visual_cut_from_kb', time, scene_id: current.scene_id || null },
      ];
      boundary.keyframe = boundary.keyframe || current.keyframe || null;
      boundary.visual_scene_id = current.scene_id || null;
      continue;
    }

    // Raw PySceneDetect output is shot-level and can contain hundreds of cuts.
    // Keep only sustained-shot transitions, then apply a 15-second NMS window.
    if (previousDuration < 8 || currentDuration < 8) continue;
    if (accepted.length && time - accepted.at(-1).time < 15) continue;

    accepted.push({
      time,
      reason: 'visual_cut_from_kb',
      confidence: 0.45,
      scene_id: current.scene_id || null,
      keyframe: current.keyframe || null,
      label: formatClockLabel(time),
    });
  }

  return accepted;
}

function uniqueBoundaries(boundaries) {
  const seen = new Set();
  return boundaries
    .filter(boundary => Number.isFinite(Number(boundary.time)) && Number(boundary.time) >= 0)
    .sort((a, b) => Number(a.time) - Number(b.time) || String(a.reason).localeCompare(String(b.reason)))
    .filter(boundary => {
      const key = `${round(boundary.time)}|${boundary.reason}|${boundary.scene_id || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function choosePackageEnd(boundaries, start, totalDuration, opts) {
  if (totalDuration - start <= opts.maxDuration) return { time: totalDuration, synthetic: false };

  const min = start + opts.minDuration;
  const max = Math.min(start + opts.maxDuration, totalDuration);
  const available = boundaries.filter(boundary => boundary.time >= min && boundary.time <= max && boundary.time < totalDuration);

  for (const reason of ['hard_subtitle_gap', 'soft_subtitle_gap', 'visual_cut_from_kb']) {
    const selected = available.filter(boundary => boundary.reason === reason).at(-1);
    if (selected) return { time: selected.time, synthetic: false };
  }

  const selected = available.at(-1);
  if (selected) return { time: selected.time, synthetic: false };

  return { time: round(max), synthetic: true };
}

function buildRanges(boundaries, totalDuration, opts) {
  const ranges = [];
  let start = 0;

  while (totalDuration - start > 0.001) {
    const selected = choosePackageEnd(boundaries, start, totalDuration, opts);
    const end = round(selected.time);
    if (end <= start) throw new Error(`Could not advance package boundary after ${start} seconds`);

    if (selected.synthetic) {
      boundaries.push({
        time: end,
        reason: 'max_duration_guardrail',
        confidence: 0.2,
        forced_split: true,
        note: 'Transport boundary only; a dramatic scene may continue across adjacent packages.',
        label: formatClockLabel(end),
      });
      boundaries.sort((a, b) => a.time - b.time || String(a.reason).localeCompare(String(b.reason)));
    }

    ranges.push({ start: round(start), end });
    start = end;
  }

  return ranges;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    fs.rmSync(filePath, { force: true });
    fs.renameSync(tempPath, filePath);
  }
}

function loadOptionalKb(kbPath, explicit) {
  if (!fs.existsSync(kbPath)) {
    if (explicit) throw new Error(`KB file not found: ${kbPath}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(kbPath, 'utf8').replace(/^\uFEFF/, ''));
}

function findVideo(videoId) {
  for (const extension of ['.mkv', '.mp4', '.mov', '.webm', '.m4v']) {
    const candidate = path.join(SERVER_DIR, 'uploads', `${videoId}${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function probeDuration(videoPath, ffprobe) {
  const result = spawnSync(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ], { encoding: 'utf8', windowsHide: true });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`ffprobe failed (${result.status}): ${(result.stderr || '').trim().slice(0, 500)}`);
  }
  const duration = Number(String(result.stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`ffprobe returned an invalid duration for: ${videoPath}`);
  return round(duration);
}

function buildCandidateDocument({
  videoId,
  episode,
  srtPath,
  kbPath,
  outputPath,
  videoPath = null,
  mediaDuration = null,
  durationSource = null,
  cues,
  kb,
  opts,
}) {
  const subtitleBoundaries = buildSubtitleBoundaries(cues, opts);
  const visualBoundaries = buildVisualBoundaries(kb, subtitleBoundaries);
  let boundaries = uniqueBoundaries([...subtitleBoundaries, ...visualBoundaries]);
  const subtitleEnd = cues.at(-1).end;
  const kbDuration = Number(kb?.duration);
  const sceneEnd = Array.isArray(kb?.scenes)
    ? Math.max(0, ...kb.scenes.map(scene => Number(scene.end_time)).filter(Number.isFinite))
    : 0;
  const fallbackDuration = Math.max(subtitleEnd, Number.isFinite(kbDuration) ? kbDuration : 0, sceneEnd);
  const totalDuration = round(Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : fallbackDuration);
  const warnings = [];
  if (subtitleEnd > totalDuration + 0.5) {
    warnings.push(`Subtitle timeline ends at ${round(subtitleEnd)}s, after media duration ${totalDuration}s; out-of-range cues and boundaries were clipped.`);
  }
  boundaries = boundaries.filter(boundary => boundary.time <= totalDuration + 0.001);
  const frameNotes = boundaries
    .filter(boundary => boundary.keyframe)
    .map(boundary => ({
      time: boundary.time,
      scene_id: boundary.scene_id || boundary.visual_scene_id || null,
      keyframe: boundary.keyframe,
    }));
  const ranges = buildRanges(boundaries, totalDuration, opts);

  const clipPackages = ranges.map((range, index) => {
    const packageBoundaries = boundaries.filter(boundary => boundary.time >= range.start && boundary.time <= range.end);
    const packageFrameNotes = frameNotes.filter(note => note.time >= range.start && note.time <= range.end);
    const subtitles = formatPromptSubtitles(cues, range.start, range.end);
    const clipIndex = index + 1;
    const continuesFromPreviousPackage = packageBoundaries.some(
      boundary => boundary.reason === 'max_duration_guardrail' && Math.abs(boundary.time - range.start) < 0.001,
    );
    const continuesToNextPackage = packageBoundaries.some(
      boundary => boundary.reason === 'max_duration_guardrail' && Math.abs(boundary.time - range.end) < 0.001,
    );
    const clipBoundaryContext = continuesFromPreviousPackage || continuesToNextPackage
      ? {
        continues_from_previous_package: continuesFromPreviousPackage,
        continues_to_next_package: continuesToNextPackage,
        instruction: 'Do not treat a forced package boundary as a dramatic-scene boundary without visual/story evidence.',
      }
      : null;

    return {
      clip_index: clipIndex,
      start_time: range.start,
      end_time: range.end,
      clip_start_time: range.start,
      clip_end_time: range.end,
      duration_sec: round(range.end - range.start),
      forced_split: Boolean(clipBoundaryContext),
      continues_from_previous_package: continuesFromPreviousPackage,
      continues_to_next_package: continuesToNextPackage,
      candidate_boundaries: packageBoundaries,
      frame_notes: packageFrameNotes,
      subtitles,
      gemini_user_prompt: buildSceneSlicingUserPrompt({
        videoId,
        episode,
        clipIndex,
        clipStartTime: range.start,
        clipEndTime: range.end,
        subtitles,
        candidateBoundaries: packageBoundaries,
        frameNotes: packageFrameNotes,
        clipBoundaryContext,
      }),
    };
  });

  return {
    schema_version: 1,
    video_id: videoId,
    episode,
    generated_by: path.basename(__filename),
    generated_at: new Date().toISOString(),
    source_video: videoPath ? displayPath(videoPath) : null,
    source_srt: displayPath(srtPath),
    source_kb: kb ? displayPath(kbPath) : null,
    output_file: displayPath(outputPath),
    duration_sec: totalDuration,
    media_duration_sec: totalDuration,
    duration_source: durationSource || (Number.isFinite(kbDuration) ? 'kb' : 'subtitles'),
    warnings,
    subtitle_count: cues.length,
    settings: {
      soft_subtitle_gap_sec: opts.softGap,
      hard_subtitle_gap_sec: opts.hardGap,
      min_package_duration_sec: opts.minDuration,
      max_package_duration_sec: opts.maxDuration,
    },
    candidate_boundaries: boundaries,
    clip_packages: clipPackages,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) return printHelp();
  if (!opts.videoId) throw new Error('<video_id> is required; use --help for usage');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(opts.videoId)) {
    throw new Error('video_id may contain only letters, numbers, underscores, and hyphens');
  }

  const videoId = opts.videoId;
  const episode = opts.episode || inferEpisode(videoId);
  const srtPath = resolveServerPath(opts.srtPath || path.join('uploads', `${videoId}.srt`));
  const kbPath = resolveServerPath(opts.kbPath || kbPaths.sceneKb(videoId));
  const outputPath = resolveServerPath(opts.outputPath || path.join('kb', '_drafts', `${videoId}.scene-candidates.json`));
  const videoPath = opts.videoPath ? resolveServerPath(opts.videoPath) : findVideo(videoId);

  if (!fs.existsSync(srtPath)) throw new Error(`Subtitle file not found: ${srtPath}`);
  if (opts.videoPath && !fs.existsSync(videoPath)) throw new Error(`Video file not found: ${videoPath}`);
  for (const inputPath of [srtPath, kbPath, videoPath].filter(Boolean)) {
    if (path.resolve(outputPath) === path.resolve(inputPath)) {
      throw new Error(`Output file must not overwrite an input file: ${outputPath}`);
    }
  }
  const cues = parseSrt(fs.readFileSync(srtPath, 'utf8'));
  if (!cues.length) throw new Error(`No valid SRT cues found in: ${srtPath}`);

  const kb = opts.noKb ? null : loadOptionalKb(kbPath, Boolean(opts.kbPath));
  let mediaDuration = opts.duration || null;
  let durationSource = opts.duration ? 'override' : null;
  if (!mediaDuration && videoPath) {
    try {
      mediaDuration = probeDuration(videoPath, opts.ffprobe || process.env.FFPROBE_PATH || 'ffprobe');
      durationSource = 'ffprobe';
    } catch (error) {
      if (opts.videoPath || opts.ffprobe) throw error;
      console.warn(`Warning: could not probe video duration (${error.message}); falling back to KB/subtitles.`);
    }
  }

  const document = buildCandidateDocument({
    videoId,
    episode,
    srtPath,
    kbPath,
    outputPath,
    videoPath,
    mediaDuration,
    durationSource,
    cues,
    kb,
    opts,
  });
  atomicWriteJson(outputPath, document);

  const hardCount = document.candidate_boundaries.filter(item => item.reason === 'hard_subtitle_gap').length;
  const softCount = document.candidate_boundaries.filter(item => item.reason === 'soft_subtitle_gap').length;
  const visualCount = document.candidate_boundaries.filter(item => item.reason === 'visual_cut_from_kb').length;
  console.log(`Scene candidates written: ${displayPath(outputPath)}`);
  console.log(`  subtitles: ${document.subtitle_count}`);
  console.log(`  duration: ${document.duration_sec}s (${document.duration_source})`);
  console.log(`  boundaries: ${document.candidate_boundaries.length} (${hardCount} hard, ${softCount} soft, ${visualCount} visual)`);
  console.log(`  clip packages: ${document.clip_packages.length}`);
  for (const warning of document.warnings) console.warn(`Warning: ${warning}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCandidateDocument,
  buildRanges,
  buildSubtitleBoundaries,
  parseArgs,
};
