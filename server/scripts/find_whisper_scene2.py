"""找 Daemon + Rhaenyra 同框的场景,以及 fact 提到耳/低语/凑近 的。"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'
kb = json.load(open(PATH, encoding='utf-8'))

OUT = r'C:\Users\Admin\Desktop\intern\video\server\scripts\whisper_candidates.txt'
out_lines = []

KEY = ['耳', '低语', '凑近', '俯身', '附耳', '靠近', '私语', '贴近']

out_lines.append('=== 戴蒙+雷妮拉同框场景 (s500-s620 范围) ===')
out_lines.append(f'{"sid":<6} {"time":<8} {"chars":<40} fact')
out_lines.append('-' * 110)
for s in kb['scenes']:
    sid = s['scene_id']
    n = int(sid[1:]) if sid.startswith('s') else 0
    if n < 500 or n > 620:
        continue
    char_ids = [(c.get('id') or '?') for c in (s.get('characters') or [])]
    has_daemon = any('daemon' in cid for cid in char_ids)
    has_rhaen = any('rhaenyra' in cid for cid in char_ids)
    if not (has_daemon and has_rhaen):
        continue
    t = s['start_time']; m, sec = divmod(int(t), 60)
    chars_str = ','.join(c.replace('_targaryen','').replace('_velaryon','') for c in char_ids)[:40]
    fact = ((s.get('plot') or {}).get('fact') or '').strip()[:80]
    out_lines.append(f'{sid:<6} {m:02d}:{sec:02d}     {chars_str:<40} {fact}')

out_lines.append('')
out_lines.append('=== 任意 fact 提到耳/低语/俯身/凑近的场景 ===')
for s in kb['scenes']:
    fact = ((s.get('plot') or {}).get('fact') or '')
    if any(k in fact for k in KEY):
        sid = s['scene_id']
        t = s['start_time']; m, sec = divmod(int(t), 60)
        out_lines.append(f'{sid:<6} {m:02d}:{sec:02d}  {fact[:120]}')

with open(OUT, 'w', encoding='utf-8') as f:
    f.write('\n'.join(out_lines))
print(f'wrote {OUT}')
