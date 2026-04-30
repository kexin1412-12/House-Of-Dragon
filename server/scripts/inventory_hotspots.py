import json
kb = json.load(open(r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json', encoding='utf-8'))
total = sum(len(s.get('symbols') or []) for s in kb['scenes'])
scenes_with = sum(1 for s in kb['scenes'] if (s.get('symbols') or []))
print(f'Current KB: {total} hotspots in {scenes_with} scenes\n')
print(f"{'scene':<8} {'time':<6} {'symbol_id':<28} conf")
print('-' * 60)
for s in kb['scenes']:
    syms = s.get('symbols') or []
    if not syms: continue
    t = s['start_time']; m, sec = divmod(int(t), 60)
    sid = s['scene_id']
    for sym in syms:
        print(f"{sid:<8} {m:02d}:{sec:02d}  {sym['symbol_id']:<28} {sym['confidence']}")
