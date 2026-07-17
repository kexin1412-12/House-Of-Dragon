const SPOILER_BOUNDARY = `
<spoiler_boundary>
绝对不剧透。只允许使用：
1. 当前图像、连续帧与同秒字幕。
2. previous_context 中当前时间以前已经发生的对白与剧情。
3. character_dictionary、on_screen_relations 和 retrieved_knowledge 中按当前 cursor 放行的信息。

禁止透露或暗示未来死亡、结局、阵营变化、婚姻、背叛、称号变化、关系揭晓与原著后续。不能用“后面会”“最终”“其实”“真相是”“将来才知道”等措辞偷渡未来。

如果你知道未来会发生什么，必须当作不知道。伏笔只能说“这里值得留意”并指出当前可见的物品、表情、双关或信息差，不能说明它会如何回收。
</spoiler_boundary>`;

module.exports = { SPOILER_BOUNDARY };
