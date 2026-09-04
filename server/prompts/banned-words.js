// 角色内心 / overlay LLM 输出的负面词库与后处理启发式。
// 命中即视为"又写成模板/古风/现代心理词"，需要重写。

// 后处理：检测是否命中现代心理词 / 散文味
const BANNED_MODERN_INNER = [
  '冲动', '焦虑', '压力', '创伤', '情绪化', '安全感', '边界感',
  '自我价值', '自尊', '抑郁', '心理', '内耗', '解离',
  '刻在骨血里', '灵魂深处', '心房', '心扉', '心跳', '涟漪', '余温',
  '上头', '翻车', '拿捏', '内卷', '摆烂', '破防',
  '应尽之义', '恩宠', // 这些"格言短语"也要拦
];
function hitsModernBanned(text) {
  if (!text) return [];
  const s = String(text);
  return BANNED_MODERN_INNER.filter(w => s.includes(w));
}
// 后处理：检测段落是不是被切碎成短句金句感（违反"句子长度"规则）
// 启发式：如果一段超过 60 字但 70% 以上的句子都很短（≤12 字），判定为"短句堆"
function feelsLikeShortChoppyMonologue(text) {
  if (!text) return false;
  const s = String(text).trim();
  if (s.length < 80) return false;
  const sents = s.split(/[。？！\n]+/).map(x => x.trim()).filter(Boolean);
  if (sents.length < 4) return false;
  const shortCount = sents.filter(x => x.length <= 12).length;
  return shortCount / sents.length >= 0.7;
}

// 角色对谈/平行视角等浮层 LLM 输出的负面词库 —— 命中即视为"又写成模板/古风/小说"。
// 我们要的是 HBO 译制风的冷峻政治语气，不是史书学士、不是仙侠、不是套话煽情。
const BANNED_HOTD_OVERLAY = [
  // 模板套话
  '此刻就在你面前', '就在你面前',
  '问问看', '问她一句', '问他一句', '问 TA 一句', '问问她', '问问他',
  '你后悔吗', '你到底想做什么', '你到底想要什么',
  '另一条路', '另一条路正在打开',
  '命运等待你的选择', '命运在你手中', '命运之门',
  '书页尚未落下', '书页', '篇章',
  // 古风书房意象
  '执笔', '卷宗', '另一卷', '史书', '史册', '羊皮纸', '鹅毛笔', '学士', '落墨',
  // 仙侠/玄幻
  '苍生', '天道', '轮回', '红尘', '众生',
  // 文言/古风副词
  '汝', '吾', '归途', '由是', '其一其二', '岂', '毋',
  // 大词/标题词
  '改写历史', '抉择',
  // perspective HUD 旧标签污染（眼前/盘算/隐忧）+ "此刻/命运/宿命" 这类宿命论修辞
  '眼前', '盘算', '隐忧', '此刻', '命运', '宿命',
  // 万金油对冲词 —— "TA 可能在影响 X 局势 / 可能影响 Y 稳定 / 仍然活跃"
  // 这种不写就丢饭碗的模板句式是典型违规。"可能"/"或许" 单独不拉黑（合
  // 法的"可能要求 X"/"或许会失去 Y"语义需要保留），但短语组合拉黑。
  '仍然活跃', '可能在影响', '或许会', '可能会被',
  '影响家族稳定', '影响王位继承', '影响 X', '影响家族',
  '暂未明朗', '尚未明朗', '尚不清楚', '不得而知',
];
function containsBannedOverlayPhrase(text) {
  if (!text) return false;
  const s = String(text);
  return BANNED_HOTD_OVERLAY.some(p => s.includes(p));
}

module.exports = {
  BANNED_MODERN_INNER,
  hitsModernBanned,
  feelsLikeShortChoppyMonologue,
  BANNED_HOTD_OVERLAY,
  containsBannedOverlayPhrase,
};
