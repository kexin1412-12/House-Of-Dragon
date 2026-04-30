"""
Clean up stale / over-dense hotspots in the opening of S01E05.

Removals:
  - s31, s50, s70: murder_montage_offscreen — misplaced (post-cold-open, in title sequence)
  - s03, s05, s06, s07, s08: murder_montage_offscreen duplicates — keep only s04, s09, s10 in the cold-open cluster

Rationale:
  - Cold-open murder montage is 00:14-00:42 (s03-s10). 8 instances of the same symbol in 28s is too dense.
  - Keep s04 (paired with moth_on_corpse), s09 (paired with valyrian_relief), s10 (final shot) as anchors.
  - Title-sequence shots (s31/s50/s70) are not the murder montage — wife is already dead, these are stylized credits.
"""
import json
import sys

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'

REMOVALS = {
    's03': ['murder_montage_offscreen'],
    's05': ['murder_montage_offscreen'],
    's06': ['murder_montage_offscreen'],
    's07': ['murder_montage_offscreen'],
    's08': ['murder_montage_offscreen'],
    's31': ['murder_montage_offscreen'],
    's50': ['murder_montage_offscreen'],
    's70': ['murder_montage_offscreen'],
}

with open(PATH, encoding='utf-8') as f:
    kb = json.load(f)

removed_count = 0
for s in kb['scenes']:
    sid = s['scene_id']
    if sid not in REMOVALS:
        continue
    targets = set(REMOVALS[sid])
    syms = s.get('symbols') or []
    new_syms = [sym for sym in syms if sym['symbol_id'] not in targets]
    n_removed = len(syms) - len(new_syms)
    if n_removed:
        print(f'  {sid}: removed {n_removed} symbol(s) ({", ".join(targets)})')
        s['symbols'] = new_syms
        removed_count += n_removed

print(f'\nTotal symbols removed: {removed_count}')

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)

print('Saved.')

# Verify
print('\n=== Verification: hotspots in first 6 minutes (after cleanup) ===')
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
