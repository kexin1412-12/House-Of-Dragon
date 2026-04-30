import json
kb = json.load(open(r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json', encoding='utf-8'))
for s in kb['scenes']:
    if s['scene_id'] == 's192':
        print('=== s192 fields ===')
        plot = s.get('plot') or {}
        print('plot.fact:', (plot.get('fact') or '')[:200])
        print()
        print('plot.reading:', (plot.get('reading') or '')[:200])
        print()
        print('plot.deep_reading:', (plot.get('deep_reading') or '')[:400])
        print()
        for sym in (s.get('symbols') or []):
            print(f"symbol: {sym['symbol_id']} ({sym['confidence']})")
            print(f"  evidence: {sym.get('evidence_in_frame','')[:200]}")
        break
