"""
Add `weirwood_bleeding` symbol:
  1) append to symbol dictionary
  2) add hotspot instance at s130 (09:50)
"""
import json

DICT_PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\symbols\house-of-the-dragon.json'
KB_PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'

new_symbol = {
    "symbol_id": "weirwood_bleeding",
    "category": "prop",
    "visual_cue": "鱼梁木（weirwood）的人脸雕刻特写，眼/口流出深红色的血状汁液，背景是模糊的红叶树冠",
    "context_required": "镜头给到雕刻面部特写；通常作为段落开场或转场，与人物无直接互动；前后镜头是政治/暴力相关情节",
    "meaning_zh": "鱼梁木是旧神信仰的祭祀树，'流血泪'在《冰与火之歌》视觉系统里是旧神预见或回应即将发生的流血事件。HoTD 作为坦格利安王朝史，主要用这个意象做'神性见证'——红堡的旧神在替这片土地哭泣，预示这一集（乃至整个王朝）即将到来的内战与血腥。和片头序列'鲜血流入瓦雷利亚石板'是一组互文：旧神血泪 vs 新神/瓦雷利亚血脉，两套信仰体系都在为同一件事预警。",
    "viewer_takeaway": "连旧神都已经预见到这一切要见血了",
    "spoiler_safe": True,
    "earliest_appearance": "S01E05",
    "examples_e5": ["s130 t≈591s 君临红堡神木林（godswood）的鱼梁木流血泪特写，作为段落开场"]
}

# 1) Update dictionary
with open(DICT_PATH, encoding='utf-8') as f:
    sd = json.load(f)

# Avoid duplicate
existing_ids = {s['symbol_id'] for s in sd['symbols']}
if new_symbol['symbol_id'] in existing_ids:
    print(f"  symbol {new_symbol['symbol_id']} already exists, skipping dict update")
else:
    sd['symbols'].append(new_symbol)
    with open(DICT_PATH, 'w', encoding='utf-8') as f:
        json.dump(sd, f, ensure_ascii=False, indent=2)
    print(f"  added {new_symbol['symbol_id']} to dictionary")

# 2) Add instance to s130
with open(KB_PATH, encoding='utf-8') as f:
    kb = json.load(f)

for s in kb['scenes']:
    if s['scene_id'] == 's130':
        existing = s.get('symbols') or []
        if any(x['symbol_id'] == 'weirwood_bleeding' for x in existing):
            print('  s130 already has weirwood_bleeding, skipping')
            break
        instance = {
            "symbol_id": "weirwood_bleeding",
            "evidence_in_frame": "鱼梁木雕刻面部特写，眼睛与嘴角流出深红色血状汁液，背景虚化出红叶树冠；画面无人物、无台词，作为纯意象转场",
            "confidence": "high",
            "bbox": None
        }
        existing.append(instance)
        s['symbols'] = existing
        print('  added weirwood_bleeding instance to s130')
        break

with open(KB_PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print('Saved.')

# Verify
print('\n=== s130 symbols ===')
for s in kb['scenes']:
    if s['scene_id'] == 's130':
        for sym in (s.get('symbols') or []):
            print(f"  {sym['symbol_id']}  conf={sym['confidence']}")
