"""把所有热点 + evidence 输出到 markdown 文件供审查。"""
import json

KB = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'
OUT = r'C:\Users\Admin\Desktop\intern\video\server\scripts\hotspots_review.md'

kb = json.load(open(KB, encoding='utf-8'))

total = sum(len(s.get('symbols') or []) for s in kb['scenes'])
scenes_with = sum(1 for s in kb['scenes'] if (s.get('symbols') or []))

lines = []
lines.append(f'# S01E05 热点审查清单')
lines.append('')
lines.append(f'**热点总数 {total} (在 {scenes_with} 个场景)**')
lines.append('')
lines.append('| # | 场景 | 时间 | 置信度 | symbol_id | evidence |')
lines.append('|---|------|------|--------|-----------|----------|')

i = 1
for s in kb['scenes']:
    syms = s.get('symbols') or []
    if not syms:
        continue
    t = s['start_time']
    m, sec = divmod(int(t), 60)
    sid = s['scene_id']
    for sym in syms:
        ev = (sym.get('evidence_in_frame') or '').strip().replace('\n', ' ').replace('|', '/')
        if len(ev) > 120:
            ev = ev[:120] + '…'
        conf = sym['confidence']
        # mark suspicious entries (medium/low) for visual scan
        marker = '⚠️ ' if conf in ('low', 'medium') else ''
        lines.append(f'| {i} | {sid} | {m:02d}:{sec:02d} | {marker}{conf} | `{sym["symbol_id"]}` | {ev} |')
        i += 1

with open(OUT, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))

print(f'wrote {OUT}')
print(f'total: {total} hotspots in {scenes_with} scenes')
