import json

kb = json.load(open(r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json', encoding='utf-8'))

# Find scenes with Otto/Jasper misidentification
print('=== Scenes mentioning 奥托 or 杰斯珀 in symbol evidence ===')
for s in kb['scenes']:
    syms = s.get('symbols') or []
    for sym in syms:
        ev = sym.get('evidence_in_frame', '') or ''
        intent = sym.get('intent_long', '') or ''
        if '奥托' in ev or '杰斯珀' in ev or '雷德温' in ev or '奥托' in intent or '杰斯珀' in intent:
            t = s['start_time']
            m, sec = divmod(int(t), 60)
            print(f"  {s['scene_id']} ({m:02d}:{sec:02d}) [{sym['symbol_id']}]")
            print(f"    evidence: {ev[:200]}")

# Show s10 cold-open final hotspot content
print()
print('=== Cold-open remaining hotspots (s04, s09, s10) ===')
for sid in ['s04', 's09', 's10']:
    for s in kb['scenes']:
        if s['scene_id'] == sid:
            t = s['start_time']
            m, sec = divmod(int(t), 60)
            print(f'\n--- {sid} ({m:02d}:{sec:02d}) ---')
            for sym in (s.get('symbols') or []):
                print(f"  symbol: {sym['symbol_id']} (conf={sym['confidence']})")
                print(f"  evidence_in_frame: {sym.get('evidence_in_frame','')[:250]}")
            break
