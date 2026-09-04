// 角色内心的多声音配置 —— 角色对谈 / 内心独白 overlay 复用。
// 每个声音挂在 4 类（理性/情感/本能/直觉）之一，LLM 一次挑 2 个不同 cat 的声音，
// 让"两种颜色的色块同时说话"。
//   blue   理性 — 权衡 / 计算 / 史鉴
//   purple 情感 — 记忆 / 旧情 / 心结
//   red    本能 — 身体反应 / 恐惧 / 愤怒（克里斯顿打死乔弗里前的肾上腺素）
//   amber  直觉 — 说不清但隐约感知到的事（雷尼拉婚宴上"今晚会出事"）
const VOICE_CATEGORY = {
  blue:   { label: '理性', tagline: '权衡 · 计算 · 史鉴',  hint: '冷静、合乎逻辑、以家族 / 王朝利益为先' },
  purple: { label: '情感', tagline: '记忆 · 旧情 · 心结',  hint: '过去涌上来，带着柔软或带着怨' },
  red:    { label: '本能', tagline: '血脉 · 火 · 肉身',     hint: '身体反应、肾上腺素、直接到不顾后果' },
  amber:  { label: '直觉', tagline: '风声 · 不祥 · 隐约',  hint: '说不清的预感、风向、第六感的不安' },
};

// 每个角色 3 个具名声音，每个挂在 4 类中的一类。
// LLM 一次回答必须挑 2 个不同 cat 的声音，让"两种颜色的色块同时说话"。
const CHAR_VOICES = {
  rhaenyra_targaryen: [
    { name: '王座算计',     cat: 'blue',   hint: '继承人的计算、父王的教诲、铁王座的重量' },
    { name: '龙血',         cat: 'red',    hint: '坦格利安血脉里的火、对羞辱的本能反扑' },
    { name: '戴蒙留下的印', cat: 'purple', hint: '叔叔在她心里那一条没法说出口的线' },
  ],
  daemon_targaryen: [
    { name: '王座饥渴',  cat: 'blue',   hint: '哥哥与铁王座之间那道他从不肯承认的影子' },
    { name: '龙血',      cat: 'red',    hint: '挑衅、暴力、瓦雷利亚的火、不肯低头' },
    { name: '哥哥的脸',  cat: 'purple', hint: '韦赛里斯在他心里残留的那一点温情与怨' },
  ],
  alicent_hightower: [
    { name: '父亲的钉子',   cat: 'blue',   hint: '奥托·海塔尔从未停过的耳语，把利害敲进她脑子' },
    { name: '母兽',         cat: 'red',    hint: '为伊耿守住的那条血肉防线，被逼急时会咬人' },
    { name: '雷妮拉的旧脸', cat: 'purple', hint: '她们曾是朋友，那张脸还没从她记忆里走干净' },
  ],
  criston_cole: [
    { name: '誓言之锁',     cat: 'blue',   hint: '白斗篷与那句"无论将来如何"，铁卫的本分' },
    { name: '神木林之伤',   cat: 'purple', hint: '那一夜被拒的羞辱，她说他不过是工具' },
    { name: '白斗篷的重',   cat: 'red',    hint: '身体里压不下去的怒，迟早会找一个出口' },
  ],
  viserys_targaryen: [
    { name: '王者本分', cat: 'blue',   hint: '坦格利安第五任国王的责任，杰赫里斯的影子' },
    { name: '衰朽',     cat: 'red',    hint: '一年比一年坏的身体，伤口烂着不愈合' },
    { name: '父爱',     cat: 'purple', hint: '对雷尼拉真心的偏爱、对阿莉森特的歉疚' },
  ],
};

function voicesFor(characterId) {
  return CHAR_VOICES[characterId] || [
    { name: '权衡', cat: 'blue',   hint: '此刻的盘算' },
    { name: '旧账', cat: 'purple', hint: '过去涌上来的那部分' },
    { name: '不祥', cat: 'amber',  hint: '说不清的预感' },
  ];
}

// 立场调色板（player 跟问 / 起手问的 4 种角度）
const STANCE_PALETTE = ['王者', '血亲', '审慎', '火焰'];
const STANCE_HINT = {
  '王者': '强势 / 揭穿 / 戳到痛处',
  '血亲': '亲近 / 老朋友式 / 戳到柔软',
  '审慎': '冷静 / 政治算计 / 把话往结构上引',
  '火焰': '激起 / 挑衅 / 让 TA 失态',
};

module.exports = {
  VOICE_CATEGORY,
  CHAR_VOICES,
  voicesFor,
  STANCE_PALETTE,
  STANCE_HINT,
};
