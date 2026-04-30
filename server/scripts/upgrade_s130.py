"""
Upgrade s130 (09:50 weirwood bleeding) from a bare hotspot
to the episode's thesis-statement scene.

Changes:
  - plot.fact / reading / deep_reading: rewrite as the episode's central omen
  - directing.intent_long: rewrite around the cold-open thesis function
  - tags: add 主题陈述/旧神预言/血龙狂舞远因
  - foreshadow.is_setup_for: link to the three predicted blood events
      * Daemon 杀妻 (cold open — already shown, so referenced as past-rhyme)
      * 婚宴 Criston 打死 Joffrey (s657-s663 criston_blood / wedding_chaos cluster)
  - foreshadow.setup_hint: tighten
  - characters_on_screen: clear the Helaena false-positive
    (weirwood carved face was matched as Helaena at 0.9857 — clearly wrong)
  - characters: clear the same Helaena entry
  - symbols[0].evidence_in_frame: keep, but tighten

Source of interpretation: user's directorial reading, paraphrased into KB voice.
"""
import json

KB_PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'

with open(KB_PATH, encoding='utf-8') as f:
    kb = json.load(f)

for s in kb['scenes']:
    if s['scene_id'] != 's130':
        continue

    # plot
    s['plot'] = {
        "fact": "镜头特写一座鱼梁木（weirwood）的人脸雕刻：眼眶与嘴角流出深红色血状汁液，缓慢淌过粗糙的石面。背景虚化，可见模糊的红色叶冠。画面无人物、无台词、无环境音之外的对白。",
        "reading": "石面流血的视觉直接对应'流泪'——旧神在为某件即将发生的事哭泣。空镜插入剧集开场段落，是导演给这一集设的'神性预警'。",
        "deep_reading": "这是 S01E05《We Light the Way》整集的主题陈述句，不是过场空镜。鱼梁木流血泪在《冰与火》视觉系统里只代表一件事——旧神预见到即将发生的流血，并且为之致哀。这一镜出现的位置（剧集开场）和内容（神性意象）共同把整集定调为'被神见证的悲剧'。三重预言同时启动：(1) 戴蒙即将在 Vale 谋杀妻子瑞亚·罗伊斯——Vale 是旧神信仰最深的南方据点之一，旧神的眼睛正看着戴蒙在它的领地上犯下杀妻之罪；(2) 这一集的婚礼名义上是'我们照亮道路'（Velaryon 族语），结果照亮的是克里斯顿·科尔当众打死乔弗里·朗茅斯的血——鱼梁木在为这场本该喜庆的婚礼提前致哀；(3) 更长的因果链：克里斯顿黑化→后来推动绿党弑君，雷妮拉婚姻从一开始就建立在谎言、政治算计与鲜血之上，这是血龙狂舞内战的远因之一。一个非常妙的细节——马丁宇宙里鱼梁木流泪通常只在北境或 Isle of Faces 这类古老之地出现，HoTD 主线发生在君临/龙石岛/潮头岛这些瓦雷利亚信仰区域，制作组特意把这镜头插进南方剧集，等于在说：这不是坦格利安的家务事，是维斯特洛大地本身在见证你们即将做下的事。这一刻之后再出现类似神谕意象（如 E10 临死前韦赛里斯的幻象），观众就该条件反射式紧张——马丁的世界里，神出场，必有死亡。"
    }

    # directing
    s['directing'] = {
        "editing_pattern": "thesis_omen_insert",
        "expected_but_missing": [],
        "intent_long": "导演把这一帧作为整集的'主题陈述句'插入：不是事件，是神谕。镜头去掉一切人物与台词，只留石脸与血泪——把观众的注意力从角色冲突短暂抽离，强行升到神性视角。这种'空镜+宗教意象'的开场陈述句在 HBO 史诗剧里通常预告整集的悲剧基调（参考 GoT 系列对北境神木的相似用法）。把这镜放在剧集开场而非结尾，是一种'预言式叙事'结构——观众带着'神已经哭过'的记忆去看后续婚礼、对峙、谋杀，每一个事件都不再是单纯的剧情推进，而是预言的逐条兑现。"
    }

    s['narrative'] = "整集主题陈述句：旧神在 S01E05 开场为即将到来的流血事件提前致哀。"

    s['shot'] = {
        "framing": "极近特写（雕刻面部）+ 浅景深虚化背景红叶",
        "intent": "把世俗事件升格为神谕——通过去人化的纯意象，把这一集即将发生的所有暴力都笼罩在'被见证'的语境里",
        "emotion": "肃穆 / 不祥 / 悲悯"
    }

    s['tags'] = [
        "主题陈述句",
        "旧神预言",
        "神性见证",
        "血龙狂舞远因",
        "鱼梁木流泪",
        "cold-open omen",
        "南方剧集中的北境意象",
    ]

    s['foreshadow'] = {
        "is_setup_for": [
            {"target_scene": "s657", "what": "克里斯顿·科尔在婚宴上当众打死乔弗里·朗茅斯——本镜预言的婚礼血光"},
            {"target_scene": "s663", "what": "婚礼混乱（wedding_chaos）峰值——血泊与混乱中草草完成婚事"},
        ],
        "is_payoff_of": [
            {"source_scene": "s10", "what": "片头序列鲜血流入瓦雷利亚石板——旧神血泪与新神/瓦雷利亚血脉构成一组互文"},
        ],
        "setup_hint": "石面血泪不是装饰：是这一集所有流血的预先签名。"
    }

    # Clear Helaena false-positive (the face detector matched the carved weirwood face as her).
    s['characters'] = []
    s['characters_on_screen'] = []

    # Tighten symbol evidence
    for sym in (s.get('symbols') or []):
        if sym['symbol_id'] == 'weirwood_bleeding':
            sym['evidence_in_frame'] = "鱼梁木雕刻面部极近特写——眼眶与嘴角同时流出深红色血状汁液，缓慢淌过粗糙石面；背景浅景深虚化出红色叶冠；画面去人化、无对白。"

    print('s130 upgraded.')
    break

with open(KB_PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print('Saved.')

# Verify
print('\n=== s130 after upgrade ===')
for s in kb['scenes']:
    if s['scene_id'] == 's130':
        print(f"narrative: {s['narrative']}")
        print(f"tags: {s['tags']}")
        print(f"shot.framing: {s['shot']['framing']}")
        print(f"plot.fact ({len(s['plot']['fact'])} chars)")
        print(f"plot.reading ({len(s['plot']['reading'])} chars)")
        print(f"plot.deep_reading ({len(s['plot']['deep_reading'])} chars)")
        print(f"directing.intent_long ({len(s['directing']['intent_long'])} chars)")
        print(f"foreshadow.is_setup_for: {len(s['foreshadow']['is_setup_for'])} entries")
        print(f"foreshadow.is_payoff_of: {len(s['foreshadow']['is_payoff_of'])} entries")
        print(f"characters_on_screen: {len(s['characters_on_screen'])} (cleared)")
        print(f"symbols: {[x['symbol_id'] for x in s['symbols']]}")
        break
