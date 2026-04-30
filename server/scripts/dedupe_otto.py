"""
Dedupe otto_dismissal: keep only the last instance (s109 @ 08:27).
Remove from s101, s105, s106, s107.
"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'
DROP = {'s101', 's105', 's106', 's107'}
TARGET = 'otto_dismissal'

with open(PATH, encoding='utf-8') as f:
    kb = json.load(f)

removed = 0
for s in kb['scenes']:
    if s['scene_id'] not in DROP:
        continue
    syms = s.get('symbols') or []
    new = [x for x in syms if x['symbol_id'] != TARGET]
    n = len(syms) - len(new)
    if n:
        print(f"  {s['scene_id']}: removed {TARGET}")
        s['symbols'] = new
        removed += n

print(f'\nTotal removed: {removed}')

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print('Saved.')

print('\n=== otto_dismissal entries after dedupe ===')
for s in kb['scenes']:
    for sym in (s.get('symbols') or []):
        if sym['symbol_id'] == TARGET:
            t = s['start_time']
            m, sec = divmod(int(t), 60)
            print(f"  {s['scene_id']}  {m:02d}:{sec:02d}  conf={sym['confidence']}")
