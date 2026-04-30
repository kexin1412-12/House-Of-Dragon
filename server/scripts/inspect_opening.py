import json

kb = json.load(open(r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json', encoding='utf-8'))

# List all hotspots in the first 6 minutes
print('=== Hotspots in first 6 minutes (0:00 - 6:00) ===')
print(f"{'scene_id':<8}  {'time':<6}  {'symbol_id':<25}  conf")
print('-' * 65)
for s in kb['scenes']:
    if s['start_time'] >= 360:
        break
    syms = s.get('symbols') or []
    if not syms:
        continue
    t = s['start_time']
    m, sec = divmod(int(t), 60)
    ts = f'{m:02d}:{sec:02d}'
    for sym in syms:
        print(f"{s['scene_id']:<8}  {ts:<6}  {sym['symbol_id']:<25}  {sym['confidence']}")

# Show scene content for s31 specifically
print()
print('=== Scene s31 content ===')
for s in kb['scenes']:
    if s['scene_id'] == 's31':
        print(f"start_time: {s['start_time']}")
        print(f"description: {s.get('description','')[:200]}")
        for sym in (s.get('symbols') or []):
            print(f"  symbol: {sym['symbol_id']}")
            print(f"  evidence_in_frame: {sym.get('evidence_in_frame','')[:150]}")
            print(f"  intent_long: {sym.get('intent_long','')[:200]}")
        break
