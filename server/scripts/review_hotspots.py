"""列出所有热点 + evidence,供人工审查。"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'
kb = json.load(open(PATH, encoding='utf-8'))

total = sum(len(s.get('symbols') or []) for s in kb['scenes'])
scenes_with = sum(1 for s in kb['scenes'] if (s.get('symbols') or []))
print(f'热点总数 {total} (在 {scenes_with} 个场景)')
print('=' * 100)

i = 1
for s in kb['scenes']:
    syms = s.get('symbols') or []
    if not syms:
        continue
    t = s['start_time']
    m, sec = divmod(int(t), 60)
    sid = s['scene_id']
    for sym in syms:
        ev = (sym.get('evidence_in_frame') or '').strip()
        if len(ev) > 90:
            ev = ev[:90] + '…'
        print(f'#{i:02d}  {sid}  {m:02d}:{sec:02d}  [{sym["confidence"]:<6}] {sym["symbol_id"]}')
        print(f'     evidence: {ev}')
        print()
        i += 1
