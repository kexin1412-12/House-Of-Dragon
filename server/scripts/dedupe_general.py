"""
General-purpose dedupe: for each (symbol_id) group in DEDUPE_PLAN,
remove all instances except the one in KEEP[symbol_id].
"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'

# symbol_id -> scene_id to keep (drop all other occurrences in DROP)
PLAN = {
    'viserys_wound': {'keep': 's121', 'drop': ['s109', 's116']},
    'rhaenys_watchful': {'keep': 's123', 'drop': ['s117', 's119']},
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

print(f'\nTotal removed: {removed}')

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print('Saved.')

# Verify each target
for sym_id in PLAN:
    print(f'\n=== {sym_id} entries after dedupe ===')
    for s in kb['scenes']:
        for sym in (s.get('symbols') or []):
            if sym['symbol_id'] == sym_id:
                t = s['start_time']
                m, sec = divmod(int(t), 60)
                print(f"  {s['scene_id']}  {m:02d}:{sec:02d}  conf={sym['confidence']}")
