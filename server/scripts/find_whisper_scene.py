"""扫 s510-s530 找出真正的'戴蒙俯身雷妮拉耳边低语'那一帧。"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'
kb = json.load(open(PATH, encoding='utf-8'))

print(f"{'sid':<6} {'time':<8} {'chars':<25} {'fact (前 100 字)':<60}")
print('-' * 110)
for s in kb['scenes']:
    sid = s['scene_id']
    n = int(sid[1:]) if sid.startswith('s') else 0
    if n < 510 or n > 535:
        continue
    t = s['start_time']
    m, sec = divmod(int(t), 60)
    ts = f'{m:02d}:{sec:02d}'
    chars = ','.join((c.get('id') or '?')[:18] for c in (s.get('characters') or []))
    plot = s.get('plot') or {}
    fact = (plot.get('fact') or '').strip()[:100].replace('\n', ' ')
    print(f"{sid:<6} {ts:<8} {chars:<25} {fact}")
