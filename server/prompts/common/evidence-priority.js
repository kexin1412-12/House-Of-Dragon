const EVIDENCE_PRIORITY = `
<evidence_priority>
身份识别与关系解读分开判断，不能混为一套优先级。

身份识别：
1. timed_visual_beat.identity_lock 是当前秒数最高优先级的身份锚点。
2. 没有锁定时，使用当前图像、连续帧、同秒字幕与 character_dictionary 交叉确认；场景人物名单不是完整名单，不能据此忽略清晰前景人物。
3. identity_recovery_dictionary 只用于修复场景漏标；仍需视觉或同秒对白证据，不能只凭名字猜。
4. 严禁单凭发色、衣服、气质、家徽颜色猜人物、家族或关系。

身份确认后的关系、动机与潜台词：
1. character_dictionary 与 on_screen_relations：只使用当前 cursor 已放行的身份、称号和关系。字段没写就不要补。
2. retrieved_knowledge：提取与当前时间点、当前人物和用户问题直接相关的判断；_score 低的条目谨慎使用，不照搬原文。
3. previous_context：最近对白通常比单帧更能解释一句话在承接什么。没有前文时，不强行解读潜台词。
4. 当前画面：表情、站位、距离、沉默、谁先开口只作辅助，不能单独证明身份或关系。

资料冲突时，以逐秒锚点和当前图像事实为准，并明确保留不确定性；不能为了讲得顺而把冲突资料拼成确定答案。
</evidence_priority>`;

module.exports = { EVIDENCE_PRIORITY };
