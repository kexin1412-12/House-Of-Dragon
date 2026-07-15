const SCENE_SLICING_SYSTEM_PROMPT = `
你是影视剧拉片分析师。你的任务是根据视频片段、字幕和时间戳，为剧集做"剧情场景切片"。

目标不是按固定时长切片，也不是按每个镜头切片，而是按"剧情场景"切片。

场景定义：
一个场景 = 同一地点 / 同一组核心人物 / 同一个戏剧目标或冲突持续成立。
当地点变化、核心人物变化、冲突目标变化、叙事功能变化时，应切成新场景。

切片规则：
1. 不要把每句台词都切成一个场景。
2. 不要把连续发生在同一地点、同一目标下的对话切太碎。
3. 如果一个长对话中出现明显话题转折、权力关系反转、人物目标改变，可以拆成多个场景。
4. 无台词段落也可能是重要场景，比如转场、沉默、仪式、战争、视觉伏笔。
5. 片头、片尾、前情提要、平台 logo、字幕组信息等非剧情内容要单独标记为 non_story。
6. 每个剧情场景通常在 30 秒到 5 分钟之间。极短转场可以并入前后场景，除非它有明确叙事意义。
7. 时间戳必须尽量准确，使用整集中的绝对秒数。
8. 不要剧透当前片段之后的内容。只根据已经看到的视频、截图和字幕判断。

边界判断：
- 如果两个连续段落只是镜头反打，但人物、地点、冲突都没变，应合并。
- 如果同一地点里从闲谈转为威胁、审判、告白、联盟形成或背叛，可以拆分。
- 如果字幕出现长空白，但画面仍在推进剧情，不要忽略。
- 如果画面切到新地点，并且核心人物变化，通常应新建场景。
- 如果只是建立镜头或过场，但有象征意义，type 用 transition，并写 visual_notes。

输出要求：
只输出 JSON，不要输出解释性散文，不要使用 Markdown 代码围栏。
`.trim();

function buildSceneSlicingUserPrompt({
  videoId = 'house_of_dragon_s03e01',
  episode = 'S03E01',
  clipIndex = null,
  clipStartTime = null,
  clipEndTime = null,
  subtitles = '',
  candidateBoundaries = [],
  frameNotes = [],
  clipBoundaryContext = null,
} = {}) {
  const clipLabel = clipIndex == null ? '全片或当前片段' : `片段 ${clipIndex}`;
  const range =
    clipStartTime == null || clipEndTime == null
      ? '未提供'
      : `${clipStartTime} - ${clipEndTime} 秒`;

  return `
请为下面的${clipLabel}做剧情场景切片。

基本信息：
- video_id: ${videoId}
- episode: ${episode}
- 当前片段在整集中的绝对时间范围: ${range}

候选切点：
${candidateBoundaries.length ? JSON.stringify(candidateBoundaries, null, 2) : '[]'}

关键帧/画面备注：
${frameNotes.length ? JSON.stringify(frameNotes, null, 2) : '[]'}

分包边界说明（仅描述传输分包，不代表剧情场景边界）：
${clipBoundaryContext ? JSON.stringify(clipBoundaryContext, null, 2) : '无'}

字幕：
${subtitles || '（未提供字幕）'}

请输出如下 JSON：
{
  "video_id": "${videoId}",
  "episode": "${episode}",
  "clip_index": ${clipIndex == null ? 'null' : JSON.stringify(clipIndex)},
  "clip_start_time": ${clipStartTime == null ? 'null' : Number(clipStartTime)},
  "clip_end_time": ${clipEndTime == null ? 'null' : Number(clipEndTime)},
  "scenes": [
    {
      "scene_id": "tmp_s001",
      "start_time": 0,
      "end_time": 96,
      "type": "non_story | story | transition | title_sequence",
      "title": "简短中文标题",
      "location": "地点，如不明确写 null",
      "core_characters": ["角色1", "角色2"],
      "dramatic_goal": "这个场景里人物想达成什么",
      "conflict": "这个场景的主要冲突或张力",
      "plot_fact": "客观发生了什么，不要解读过度",
      "plot_reading": "这一段在叙事上的意义，可以分析人物关系、权力变化、伏笔、主题",
      "boundary_reason": "为什么这里开始/结束是一个场景边界",
      "continues_from_previous": false,
      "continues_to_next": false,
      "key_dialogue": [
        {
          "time": 250,
          "speaker": "角色名或 unknown",
          "line": "关键台词"
        }
      ],
      "visual_notes": [
        "重要画面、道具、构图、颜色、沉默、动作"
      ],
      "tags": ["政治", "家庭", "战争", "伏笔"]
    }
  ],
  "coverage_check": {
    "covers_full_input_range": true,
    "has_time_gaps": false,
    "has_overlaps": false,
    "notes": []
  }
}

检查要求：
1. 覆盖当前输入片段的全部时间范围。
2. 场景之间不要时间重叠。
3. 明显过长的场景要拆分。
4. 明显过短且无叙事意义的场景要合并。
5. 如果当前片段的开头/结尾显然接着前后片段，设置 continues_from_previous / continues_to_next。
`.trim();
}

const SCENE_SLICING_SCHEMA = {
  type: 'object',
  required: ['video_id', 'episode', 'scenes', 'coverage_check'],
  properties: {
    video_id: { type: 'string' },
    episode: { type: 'string' },
    clip_index: { type: ['number', 'string', 'null'] },
    clip_start_time: { type: ['number', 'null'] },
    clip_end_time: { type: ['number', 'null'] },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'scene_id',
          'start_time',
          'end_time',
          'type',
          'title',
          'plot_fact',
          'plot_reading',
          'boundary_reason',
          'continues_from_previous',
          'continues_to_next',
        ],
        properties: {
          scene_id: { type: 'string' },
          start_time: { type: 'number' },
          end_time: { type: 'number' },
          type: { type: 'string', enum: ['non_story', 'story', 'transition', 'title_sequence'] },
          title: { type: 'string' },
          location: { type: ['string', 'null'] },
          core_characters: { type: 'array', items: { type: 'string' } },
          dramatic_goal: { type: ['string', 'null'] },
          conflict: { type: ['string', 'null'] },
          plot_fact: { type: 'string' },
          plot_reading: { type: 'string' },
          boundary_reason: { type: 'string' },
          continues_from_previous: { type: 'boolean' },
          continues_to_next: { type: 'boolean' },
          key_dialogue: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                time: { type: 'number' },
                speaker: { type: 'string' },
                line: { type: 'string' },
              },
            },
          },
          visual_notes: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    coverage_check: {
      type: 'object',
      properties: {
        covers_full_input_range: { type: 'boolean' },
        has_time_gaps: { type: 'boolean' },
        has_overlaps: { type: 'boolean' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

module.exports = {
  SCENE_SLICING_SYSTEM_PROMPT,
  SCENE_SLICING_SCHEMA,
  buildSceneSlicingUserPrompt,
};
