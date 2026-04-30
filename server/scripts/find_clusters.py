"""
Find dense duplicate clusters: same symbol_id appearing 2+ times within a 90-second window.
"""
import json
from collections import defaultdict

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'
WINDOW = 90  # seconds

with open(PATH, encoding='utf-8') as f:
    kb = json.load(f)

# Build: symbol_id -> [(start_time, scene_id, confidence), ...]
by_sym = defaultdict(list)
for s in kb['scenes']:
    for sym in (s.get('symbols') or []):
        by_sym[sym['symbol_id']].append((s['start_time'], s['scene_id'], sym['confidence']))

print(f'=== Dense clusters (same symbol within {WINDOW}s, 2+ occurrences) ===\n')
for sym_id, entries in by_sym.items():
    entries.sort()
    # Find runs where consecutive entries are within WINDOW
    cluster = [entries[0]]
    clusters_found = []
    for e in entries[1:]:
        if e[0] - cluster[-1][0] <= WINDOW:
            cluster.append(e)
        else:
            if len(cluster) >= 2:
                clusters_found.append(cluster)
            cluster = [e]
    if len(cluster) >= 2:
        clusters_found.append(cluster)

    for c in clusters_found:
        print(f'-- {sym_id} ({len(c)}x in {c[-1][0]-c[0][0]:.0f}s) --')
        for t, sid, conf in c:
            m, sec = divmod(int(t), 60)
            print(f"     {sid}  {m:02d}:{sec:02d}  conf={conf}")
        print()
