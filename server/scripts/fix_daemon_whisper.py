"""
修 daemon_whisper 错位:
  - s509 (45:59): 删 daemon_whisper symbol,把鼓掌帧的解读改成"到场+鼓掌"
  - s611 (53:02): 新加 daemon_whisper 高置信度热点,迁移富化 plot 内容
"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'

with open(PATH, encoding='utf-8') as f:
    kb = json.load(f)

# ── s509: 改成"鼓掌入场"主题 + 删 symbol ─────────────────────
S509_NEW_PLOT_FACT = "戴蒙坐于婚宴席间,面带玩味微笑,双手鼓掌——他在不被报名宣告的情况下已经入座,此刻随宴会人群的礼仪节拍鼓掌。"
S509_NEW_PLOT_READING = "鼓掌是仪式语言里最'被动同意'的动作——所有客人都该鼓,他鼓也无人能阻止。这是戴蒙'用最低成本占据在场'的姿态。"
S509_NEW_DEEP_READING = (
    "S01E05 婚宴上戴蒙的存在感不来自他被宣告(铁卫沉默,见 s550),也不来自他被邀请(座次靠仆从临时加椅,见 s545),"
    "而来自他做了所有客人都该做的动作——鼓掌、微笑、随节拍点头。这一帧把'未被认却已在场'的精确语法做到了极致:"
    "你不能说他失礼,但你也无法宣告他的身份。导演让镜头停留在他鼓掌的脸,是要观众看见'制度承认你的动作但不承认你的身份'这种细分管理的视觉证据。"
    "和真正的低语时刻(s611 戴蒙俯身雷妮拉耳语)是同一段戏的两端——前端是公开的'被动合规',后端才是私密的政治勒索。"
)
S509_NEW_TAGS = ["戴蒙婚宴在场", "被动合规", "鼓掌仪式语言", "未被认却已在场", "礼制空隙"]

for s in kb['scenes']:
    if s['scene_id'] == 's509':
        s['symbols'] = [x for x in (s.get('symbols') or []) if x['symbol_id'] != 'daemon_whisper']
        s['plot'] = {
            'fact': S509_NEW_PLOT_FACT,
            'reading': S509_NEW_PLOT_READING,
            'deep_reading': S509_NEW_DEEP_READING,
        }
        s['narrative'] = "戴蒙在婚宴席间鼓掌——'未被认却已在场'的精确语法。"
        s['shot'] = {
            'framing': "戴蒙脸部中近景 + 鼓掌动作",
            'intent': "把'被动合规'拍成姿态而非动作——他做的是所有人都该做的事",
            'emotion': "克制 / 暗流",
        }
        s['tags'] = S509_NEW_TAGS
        s['foreshadow'] = {
            'is_setup_for': [
                {'target_scene': 's611', 'what': "戴蒙俯身雷妮拉耳语——本帧公开合规的对位面"},
                {'target_scene': 's545', 'what': "仆从临时加椅——'承认在场不承认身份'的另一半"},
                {'target_scene': 's550', 'what': "戴蒙不被铁卫宣告——本帧鼓掌的礼制前提"},
            ],
            'is_payoff_of': [],
            'setup_hint': "他做的事所有人都在做——这就是他无法被驱逐的理由。",
        }
        print(f'  s509: cleaned daemon_whisper hallucination → reframed as 鼓掌入场')
        print(f'    symbols now: {[x["symbol_id"] for x in s.get("symbols") or []]}')
        break

# ── s611: 新加 daemon_whisper 高置信热点 ────────────────────
S611_WHISPER_EVIDENCE = "戴蒙俯身贴近雷妮拉耳边低语,周围是喧嚣的婚宴人群,雷妮拉神情复杂地看向前方未即刻回应——公开场合内的私密侵入,是戴蒙的政治签名动作。"
S611_NARRATIVE = "婚宴喧嚣中戴蒙俯身雷妮拉耳边低语——在最公开的场合制造最私密的接触,这是本集真正改变雷妮拉轨迹的那一刻。"
S611_PLOT = {
    'fact': "婚宴舞池/侧位,戴蒙俯身向雷妮拉耳边低语,周围喧嚣;雷妮拉表情可见反应(惊愕/沉默/微变色)但未即刻回话。",
    'reading': "在所有人能看到的地方说所有人都听不到的话——是戴蒙在向所有看着的人示威:'我和她之间有任何外人都进不去的私人频道。'",
    'deep_reading': (
        "daemon_whisper 是 S01E05 最尖锐的私密政治动作。婚宴是雷妮拉公开宣示与莱诺政治结盟的仪式场合,"
        "戴蒙在这个场合插入一句只有她能听到的私语,等于在公开仪式的内部撕一个私人裂口——既是对莱诺、瓦列利安家族、"
        "韦赛里斯的同时挑衅,也是对雷妮拉本人的政治勒索。语义上,马丁让这句话永远不被还原(观众至今不知道戴蒙到底说了什么),"
        "这是一个故意设计的'空缺':真正改变雷妮拉轨迹的不是戴蒙说的内容,而是戴蒙能在这个场合说这种话本身——"
        "她在那一刻接受了'戴蒙永远在场'。后续 s661 克里斯顿失控也有戴蒙的私语功劳——戴蒙的低语让在场观察者(克里斯顿)"
        "进一步丧失对雷妮拉的'独占'幻觉。"
    ),
}
S611_DIRECTING = {
    'editing_pattern': "public_chaos + private_whisper 双声场",
    'expected_but_missing': [],
    'intent_long': "公开喧嚣 vs 私密低语 = 两套声场叠加。导演把舞池声音保留得最满,让戴蒙的话被噪声完全吞掉,只留雷妮拉的脸部反应——观众和在场宾客一样'看见但听不见'。",
}
S611_SHOT = {
    'framing': "舞池中近景 + 戴蒙耳语侧脸 + 雷妮拉表情近景",
    'intent': "用反差让最危险的政治动作发生在最热闹的角落",
    'emotion': "暗流 / 危险 / 私密侵入",
}
S611_TAGS = ["daemon耳语", "公私反差", "婚宴危险时刻", "信息空缺设计", "雷妮拉轨迹转折"]
S611_FORESHADOW = {
    'is_setup_for': [
        {'target_scene': 's661', 'what': "克里斯顿失控——戴蒙在场进一步触发其'独占'幻觉破碎"},
    ],
    'is_payoff_of': [
        {'source_scene': 's509', 'what': "戴蒙鼓掌入场——本帧是公开合规之后的私密侵入"},
        {'source_scene': 's550', 'what': "戴蒙不被报名——本帧延续'不被认却已在场'的精确语法"},
    ],
    'setup_hint': "在最公开的舞池里说一句最私密的话——这就是戴蒙的政治签名。",
}

for s in kb['scenes']:
    if s['scene_id'] == 's611':
        existing = s.get('symbols') or []
        if not any(x['symbol_id'] == 'daemon_whisper' for x in existing):
            existing.append({
                'symbol_id': 'daemon_whisper',
                'evidence_in_frame': S611_WHISPER_EVIDENCE,
                'confidence': 'high',
                'bbox': None,
            })
            s['symbols'] = existing
        s['narrative'] = S611_NARRATIVE
        s['plot'] = S611_PLOT
        s['directing'] = S611_DIRECTING
        s['shot'] = S611_SHOT
        s['tags'] = S611_TAGS
        s['foreshadow'] = S611_FORESHADOW
        print(f'  s611: added daemon_whisper (high) + rich content')
        print(f'    symbols now: {[x["symbol_id"] for x in s.get("symbols") or []]}')
        break

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print('Saved.')
