import json

kb = json.load(open(r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json', encoding='utf-8'))

print(f"{'scene_id':<8}  {'time':<6}  {'symbol_id':<22}  confidence")
print('-' * 60)

for s in kb['scenes']:
    syms = s.get('symbols') or []
    if not syms:
        continue
    t = s['start_time']
    m, sec = divmod(int(t), 60)
    ts = f'{m:02d}:{sec:02d}'
    for sym in syms:
        print(f"{s['scene_id']:<8}  {ts:<6}  {sym['symbol_id']:<22}  {sym['confidence']}")
