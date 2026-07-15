# AI Scene Slicing Prompt

This project uses scene-level KB files such as `server/kb/house_of_dragon_05.json`.
For new episodes, use Gemini or another multimodal model to cut the episode into
dramatic scenes before generating the final KB.

The reusable prompt lives in:

```text
server/lib/ai/prompts/sceneSlicing.js
```

## Goal

Cut by story scene, not fixed duration and not every camera shot.

A scene means:

```text
same location / same core characters / same dramatic goal or conflict
```

Start a new scene when location, core characters, dramatic goal, conflict, or
narrative function changes.

## Recommended Pipeline

```text
video + subtitles
  -> candidate boundaries from subtitles / optional PySceneDetect KB / frame changes
  -> Gemini scene slicing prompt
  -> draft scenes JSON
  -> merge cross-clip scenes
  -> generate server/kb/<video_id>.json
```

For `house_of_dragon_s03e01`, the first runtime target should be:

```text
server/kb/_drafts/house_of_dragon_s03e01.scene-slices.json
```

Then convert the draft into:

```text
server/kb/house_of_dragon_s03e01.json
server/kb/storyline/house_of_dragon_s03e01.json
```

## Algorithm Layer

Do not ask Gemini to cut the episode from a blank slate. First run the local
candidate builder:

```powershell
cd server
npm run scene-candidates -- house_of_dragon_s03e01 --episode S03E01
```

If the subtitle file is not `server/uploads/house_of_dragon_s03e01.srt`, pass it
explicitly:

```powershell
npm run scene-candidates -- house_of_dragon_s03e01 `
  --episode S03E01 `
  --srt "uploads/house_of_dragon_s03e01.srt"
```

The script writes:

```text
server/kb/_drafts/house_of_dragon_s03e01.scene-candidates.json
```

Then physically cut the long video into Gemini-ready MP4 files:

```powershell
cd server
npm run cut-ai-clips -- "uploads/house_of_dragon_s03e01.mkv" `
  --candidates "kb/_drafts/house_of_dragon_s03e01.scene-candidates.json"
```

The default mode accurately re-encodes each clip as H.264/AAC MP4, caps the
width at 1280 pixels, tone-maps detected PQ/HLG HDR sources to SDR, and creates
a clip-local SRT. Outputs live under:

```text
server/uploads/ai-clips/house_of_dragon_s03e01/
  clip-001_000000-000550.mp4
  clip-001_000000-000550.srt
  ...
  manifest.json
```

The two filename timestamps are `HHMMSS` labels rounded to the nearest second,
so `000550` means about `00:05:50`. Use the exact decimal timestamps in
`manifest.json` for timeline mapping.

`manifest.json` keeps the absolute episode start/end time, candidate boundaries,
and Gemini prompt for every physical clip. This lets later AI results use the
original episode timeline even though Gemini only receives a short video.

Use `--dry-run` to validate ranges without encoding. Use `--copy` only when
speed matters more than exact boundaries; stream-copy cuts can move to a nearby
video keyframe.

This JSON includes:

```text
candidate_boundaries[]        # algorithmic boundary hints
clip_packages[]               # Gemini-ready analysis packages
clip_packages[].subtitles     # subtitle window for each package
clip_packages[].gemini_user_prompt
```

Current algorithm signals:

```text
subtitle_start / subtitle_end
hard_subtitle_gap             # long no-dialogue gap
soft_subtitle_gap             # shorter no-dialogue gap
visual_cut_from_kb            # optional PySceneDetect scene start from KB skeleton
max_duration_guardrail        # prevents overlong Gemini packages
```

This first pass deliberately creates analysis packages rather than claiming to
know the final dramatic scenes. Gemini receives one short MP4 plus its subtitle
window and boundary hints, then decides the scene-level cuts inside that clip.

If `server/kb/<video_id>.json` already exists from `scripts/preprocess.js`, the
candidate builder also uses its `scenes[].start_time` as visual-cut hints.

The model should treat these as hints, not final cuts. Gemini still decides
whether to merge, split, name, and explain final story scenes.

## Code Usage

```js
const {
  SCENE_SLICING_SYSTEM_PROMPT,
  SCENE_SLICING_SCHEMA,
  buildSceneSlicingUserPrompt,
} = require('../lib/ai/prompts/sceneSlicing');

const system = SCENE_SLICING_SYSTEM_PROMPT;
const user = buildSceneSlicingUserPrompt({
  videoId: 'house_of_dragon_s03e01',
  episode: 'S03E01',
  clipIndex: 1,
  clipStartTime: 0,
  clipEndTime: 420,
  subtitles: '00:04:10 跪下\\n00:04:15 ...',
  candidateBoundaries: [
    { time: 250, reason: 'subtitle_gap' },
    { time: 410, reason: 'hard_cut' },
  ],
  frameNotes: [
    { time: 250, note: 'dark interior, character kneels' },
  ],
});
```

When calling the AI facade, pass `SCENE_SLICING_SCHEMA` to
`ai.generateStructured(...)` once the Gemini integration script is added.

## Output Shape

The model should return:

```json
{
  "video_id": "house_of_dragon_s03e01",
  "episode": "S03E01",
  "clip_index": 1,
  "clip_start_time": 0,
  "clip_end_time": 420,
  "scenes": [
    {
      "scene_id": "tmp_s001",
      "start_time": 250,
      "end_time": 410,
      "type": "story",
      "title": "处决前的审问",
      "location": null,
      "core_characters": ["unknown"],
      "dramatic_goal": "审问并迫使对方交代下落",
      "conflict": "权力压迫与求生辩解",
      "plot_fact": "角色被命令跪下，并询问某人的下落。",
      "plot_reading": "开场用命令和跪姿建立权力关系。",
      "boundary_reason": "250 秒开始进入正式剧情冲突，410 秒后冲突转场。",
      "continues_from_previous": false,
      "continues_to_next": false,
      "key_dialogue": [],
      "visual_notes": [],
      "tags": ["权力", "审问"]
    }
  ],
  "coverage_check": {
    "covers_full_input_range": true,
    "has_time_gaps": false,
    "has_overlaps": false,
    "notes": []
  }
}
```

## Merge Notes

When analyzing short video chunks, keep absolute episode timestamps. Use:

```json
"continues_from_previous": true,
"continues_to_next": true
```

to mark scenes that should be merged across chunk boundaries.
