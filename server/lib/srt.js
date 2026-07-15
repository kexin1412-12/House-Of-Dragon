'use strict';

const TIMESTAMP_PATTERN = '(\\d{1,3}):(\\d{2}):(\\d{2})[,.](\\d{1,3})';
const TIMING_LINE_RE = new RegExp(`^\\s*${TIMESTAMP_PATTERN}\\s*-->\\s*${TIMESTAMP_PATTERN}(?:\\s+.*)?$`);

function parseSrtTimestamp(value) {
  const match = String(value).trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);

  const [, hours, minutes, seconds, fraction] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(fraction.padEnd(3, '0').slice(0, 3)) / 1000
  );
}

function parseSrt(text) {
  const normalized = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();

  if (!normalized) return [];

  const cues = [];
  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex(line => TIMING_LINE_RE.test(line));
    if (timingIndex < 0) continue;

    const match = lines[timingIndex].match(TIMING_LINE_RE);
    const start = parseSrtTimestamp(`${match[1]}:${match[2]}:${match[3]},${match[4]}`);
    const end = parseSrtTimestamp(`${match[5]}:${match[6]}:${match[7]},${match[8]}`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    cues.push({
      index: cues.length + 1,
      start,
      end,
      text: lines.slice(timingIndex + 1).join('\n').trim(),
    });
  }

  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}

function formatSrtTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
  const milliseconds = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(secs).padStart(2, '0'),
  ].join(':') + `,${String(milliseconds).padStart(3, '0')}`;
}

function formatClockLabel(seconds, rounding = 'round') {
  const round = rounding === 'floor' ? Math.floor : rounding === 'ceil' ? Math.ceil : Math.round;
  const totalSeconds = Math.max(0, round(Number(seconds)));
  const secs = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(totalMinutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function overlappingCues(cues, startTime, endTime) {
  return cues.filter(cue => cue.start < endTime && cue.end > startTime);
}

function formatClipSrt(cues, startTime, endTime) {
  const blocks = [];
  for (const cue of overlappingCues(cues, startTime, endTime)) {
    const localStart = Math.max(cue.start, startTime) - startTime;
    const localEnd = Math.min(cue.end, endTime) - startTime;
    if (localEnd - localStart < 0.001) continue;

    blocks.push([
      String(blocks.length + 1),
      `${formatSrtTimestamp(localStart)} --> ${formatSrtTimestamp(localEnd)}`,
      cue.text,
    ].join('\n'));
  }

  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

function formatPromptSubtitles(cues, startTime, endTime) {
  return overlappingCues(cues, startTime, endTime)
    .map(cue => {
      const text = cue.text.replace(/\s*\n\s*/g, ' / ').replace(/\s+/g, ' ').trim();
      const clippedStart = Math.max(cue.start, startTime);
      const clippedEnd = Math.min(cue.end, endTime);
      return `${formatClockLabel(clippedStart, 'floor')} - ${formatClockLabel(clippedEnd, 'floor')}  ${text}`;
    })
    .join('\n');
}

module.exports = {
  formatClipSrt,
  formatClockLabel,
  formatPromptSubtitles,
  formatSrtTimestamp,
  overlappingCues,
  parseSrt,
  parseSrtTimestamp,
};
