import json
kb = json.load(open(r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json', encoding='utf-8'))
for s in kb['scenes']:
    if s['scene_id'] == 's130':
        print(json.dumps(s, ensure_ascii=False, indent=2))
        break

# Also find a scene with rich plot/reading fields to see format
print('\n=== Sample scene with rich fields ===')
for s in kb['scenes']:
    if s.get('plot') or s.get('reading') or s.get('deep_reading'):
        if s['scene_id'] != 's130':
            print(f"scene {s['scene_id']} keys: {list(s.keys())}")
            for k in ('plot', 'reading', 'deep_reading', 'description'):
                v = s.get(k)
                if v:
                    print(f"  {k}: {str(v)[:300]}")
            break
