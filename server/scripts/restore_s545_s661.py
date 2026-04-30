"""
外科补入 s545 (kingsguard_no_announcement) 和 s661 (wedding_chaos)。
保留两个场景的现有 plot.deep_reading + directing.intent_long 等手写富化内容。
"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'

with open(PATH, encoding='utf-8') as f:
    kb = json.load(f)

PATCHES = {
    's545': {
        'symbol_id': 'kingsguard_no_announcement',
        'evidence_in_frame': "婚宴主桌段落,某宾客落座/移动时御林铁卫静默立岗未做礼制宣告——和'extra_chair_added'同帧叠出'承认你在场不承认你身份'的二元礼制信号。",
        'confidence': 'high',
        'bbox': None,
    },
    's661': {
        'symbol_id': 'wedding_chaos',
        'evidence_in_frame': "克里斯顿·科尔失控当众击打乔弗里·朗茅斯,人群从狂欢转为震惊围观,音乐与喧嚣残留——婚宴秩序在仪式中心被碾过,wedding_chaos 序列峰值。",
        'confidence': 'high',
        'bbox': None,
    },
}

for s in kb['scenes']:
    sid = s['scene_id']
    if sid not in PATCHES:
        continue
    syms = s.get('symbols') or []
    target_id = PATCHES[sid]['symbol_id']
    if any(x['symbol_id'] == target_id for x in syms):
        print(f"  {sid}: {target_id} already present, skipping")
        continue
    syms.append(PATCHES[sid])
    s['symbols'] = syms
    print(f"  {sid}: appended {target_id}")

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print('Saved.')

# Verify
print()
for sid in PATCHES:
    for s in kb['scenes']:
        if s['scene_id'] == sid:
            syms = s.get('symbols') or []
            print(f'  {sid} now has: {[x["symbol_id"] for x in syms]}')
            break
