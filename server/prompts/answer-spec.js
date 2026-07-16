function buildAnswerSpec(depth) {
  const normalized = depth === 'oneline' || depth === 'deep' ? depth : 'brief';

  if (normalized === 'oneline') {
    return `

<output_contract mode="oneline">
- 只输出一句，最多 28 个中文字符。
- 不使用 [事实]、[解读]、[推测] 标签。
- 直接给结论，不用“是的”“这是”“画面中”开头。
</output_contract>`;
  }

  if (normalized === 'deep') {
    return `

<output_contract mode="deep">
按以下三层输出，每个标签只出现一次：

[事实] 100-160 字
- 先回答具体人物、物件和事件，再给可见证据。
- timed_visual_beat 已核验的信息优先，不得被单帧猜测覆盖。

[解读] 380-560 字
- 开头先给鲜明的核心论断，再展开历史背景、符号作用、当前剧情镜像与艺术语言。
- 至少建立一组具体反差，并用一至两个当前画面的意象贯穿全文。
- 结尾用一句克制、有余味的主题收束；每个判断都要落回画面细节，不堆砌理论。

[推测] 60-120 字
- 只写真实存在的争议或证据边界。
- 区分已核验事实、剧集视觉化、常见解读；不为满足格式编造可能性。
</output_contract>`;
  }

  return `

<output_contract mode="brief">
- 默认输出 [事实] 与 [解读] 两层，每个标签只出现一次。
- [事实] 最多 30 字，只写当前已发生内容；无必要可省略。
- [解读] 最多 45 字，直接说明意义。
- 用户没有询问可能性时，不输出 [推测]。
</output_contract>`;
}

module.exports = { buildAnswerSpec };
