"""
Phase 1: collapse the remaining 5 dense clusters.

Decisions:
  - rhaenys_watchful s381/s385 → keep s385 (closing watchful gaze)
  - laenor_agreement s225/s227/s230/s231 → keep s231 (moment agreement is reached, last)
  - hightower_green s448-s454 → keep s454 (full reveal, last)
  - kingsguard_no_announcement s545/s550 → keep s550 (closing — "no announcement" is confirmed)
  - wedding_chaos s620-s680 → keep 3 anchors:
      * s620 (53:56)  — chaos starts
      * s663 (55:18) — Joffrey killed (peak)
      * s680 (56:07) — chaos resolution / wedding hastily concluded
"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'

PLAN = {
    'rhaenys_watchful':           {'drop': ['s381']},
    'laenor_agreement':           {'drop': ['s225', 's227', 's230']},
    'hightower_green':            {'drop': ['s448', 's449', 's451', 's453']},
    'kingsguard_no_announcement': {'drop': ['s545']},
    'wedding_chaos':              {'drop': ['s630', 's640', 's661', 's670']},
}

with open(PATH, encoding='utf-8') as f:
    kb = json.load(f)

removed = 0
for s in kb['scenes']:
    sid = s['scene_id']
    syms = s.get('symbols') or []
    new = []
    for sym in syms:
        plan = PLAN.get(sym['symbol_id'])
        if plan and sid in plan['drop']:
            print(f"  {sid}: removed {sym['symbol_id']}")
            removed += 1
            continue
        new.append(sym)
    if len(new) != len(syms):
        s['symbols'] = new

print(f'\nRemoved: {removed}')

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print('Saved.\n')

# Print full surviving hotspot list for next phase
print('=== Surviving hotspots (master list) ===')
print(f"{'scene_id':<8}  {'time':<6}  {'symbol_id':<27}  conf")
print('-' * 65)
total = 0
for s in kb['scenes']:
    syms = s.get('symbols') or []
    if not syms:
        continue
    t = s['start_time']
    m, sec = divmod(int(t), 60)
    ts = f'{m:02d}:{sec:02d}'
    for sym in syms:
        print(f"{s['scene_id']:<8}  {ts:<6}  {sym['symbol_id']:<27}  {sym['confidence']}")
        total += 1
print(f'\nTotal hotspots: {total}')
