import json
kb = json.load(open(r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json', encoding='utf-8'))
# Find any populated symbol instance
for s in kb['scenes']:
    for sym in (s.get('symbols') or []):
        print(f"scene {s['scene_id']} fields:")
        for k, v in sym.items():
            v_short = str(v)[:80]
            print(f"  {k}: {v_short}")
        raise SystemExit
