import json

kb = json.load(open(r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json', encoding='utf-8'))
sym_dict = json.load(open(r'C:\Users\Admin\Desktop\intern\video\server\kb\symbols\house-of-the-dragon.json', encoding='utf-8'))

# Find scene around 09:51 = 591s
target = 591
print('=== Scenes around 09:51 (588-598s) ===')
for s in kb['scenes']:
    if 585 <= s['start_time'] <= 600:
        t = s['start_time']
        m, sec = divmod(int(t), 60)
        end_t = s.get('end_time', s['start_time'])
        em, esec = divmod(int(end_t), 60)
        desc = s.get('description', '') or ''
        deep = s.get('deep_reading', '') or ''
        print(f"\n  {s['scene_id']}  {m:02d}:{sec:02d}-{em:02d}:{esec:02d}")
        print(f"    description: {desc[:200]}")
        if deep:
            print(f"    deep_reading: {deep[:200]}")
        for sym in (s.get('symbols') or []):
            print(f"    symbol: {sym['symbol_id']}")

# Check symbol dict for weirwood-related entries
print('\n=== Weirwood / heart tree symbols in dictionary ===')
syms = sym_dict if isinstance(sym_dict, list) else sym_dict.get('symbols', [])
for sym in syms:
    name = sym.get('name', '') or sym.get('symbol_id', '') or ''
    desc = sym.get('description', '') or ''
    visual = sym.get('visual_cue', '') or ''
    blob = (name + ' ' + desc + ' ' + visual).lower()
    if any(k in blob for k in ['weirwood', '鱼梁木', 'heart tree', '心树', '魚梁木', '红叶', 'red leaves', '泪']):
        print(f"  - id: {sym.get('symbol_id', sym.get('id'))}")
        print(f"    name: {name}")
        print(f"    visual_cue: {visual[:200]}")
