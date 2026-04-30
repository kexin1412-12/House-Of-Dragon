"""
Phase 2 cleanup: collapse the entire cold-open / title-sequence murder narrative
to a single anchor hotspot at s10.

User direction: "整个杀妻的情节留最后的解说就好了"
  - viewers skip the opening, so density there is wasted
  - keep ONE final explanation, not a chain of duplicates

Removals:
  - s04: moth_on_corpse + murder_montage_offscreen
  - s09: valyrian_relief + murder_montage_offscreen
Kept:
  - s10: murder_montage_offscreen (the final/last shot of the opening sequence)
"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'

WIPE_SCENES = {'s04', 's09'}

with open(PATH, encoding='utf-8') as f:
    kb = json.load(f)

removed = 0
for s in kb['scenes']:
    if s['scene_id'] in WIPE_SCENES:
        n = len(s.get('symbols') or [])
        if n:
            print(f"  {s['scene_id']}: cleared {n} symbol(s)")
            s['symbols'] = []
            removed += n

print(f'\nTotal symbols removed: {removed}')

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print('Saved.')

# Verify cold-open / first 10 minutes
print('\n=== Hotspots in first 10 minutes (after phase 2) ===')
print(f"{'scene_id':<8}  {'time':<6}  {'symbol_id':<25}  conf")
print('-' * 65)
for s in kb['scenes']:
    if s['start_time'] >= 600:
        break
    syms = s.get('symbols') or []
    if not syms:
        continue
    t = s['start_time']
    m, sec = divmod(int(t), 60)
    ts = f'{m:02d}:{sec:02d}'
    for sym in syms:
        print(f"{s['scene_id']:<8}  {ts:<6}  {sym['symbol_id']:<25}  {sym['confidence']}")
