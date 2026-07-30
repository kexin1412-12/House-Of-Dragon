"""
Apply rich upgrades from upgrades_data.json to the KB.

Also drops s230 rhaenyra_red_black per prior user request.
Skips s130 (already upgraded earlier).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.abspath(os.path.join(HERE, '..'))
sys.path.insert(0, SERVER)
from lib.kb_io import save_kb_safely  # noqa: E402

KB_PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'
DATA_PATH = os.path.join(HERE, 'upgrades_data.json')

with open(DATA_PATH, encoding='utf-8') as f:
    UPGRADES = json.load(f)

with open(KB_PATH, encoding='utf-8') as f:
    kb = json.load(f)

# Drop rhaenyra_red_black from s230 (deemphasize per prior instruction)
for s in kb['scenes']:
    if s['scene_id'] == 's230':
        syms = s.get('symbols') or []
        new = [x for x in syms if x['symbol_id'] != 'rhaenyra_red_black']
        if len(new) != len(syms):
            s['symbols'] = new
            print(f"  s230: removed rhaenyra_red_black")
        break

applied = 0
for s in kb['scenes']:
    sid = s['scene_id']
    up = UPGRADES.get(sid)
    if not up:
        continue

    s['narrative'] = up['narrative']
    s['plot'] = {
        'fact':         up['plot_fact'],
        'reading':      up['plot_reading'],
        'deep_reading': up['plot_deep_reading'],
    }
    s['directing'] = {
        'editing_pattern':      up['directing_pattern'],
        'expected_but_missing': [],
        'intent_long':          up['directing_intent'],
    }
    s['shot'] = {
        'framing': up['shot_framing'],
        'intent':  up['shot_intent'],
        'emotion': up['shot_emotion'],
    }
    s['tags'] = up['tags']
    s['foreshadow'] = {
        'is_setup_for':  up['foreshadow_setup_for'],
        'is_payoff_of':  up['foreshadow_payoff_of'],
        'setup_hint':    up['foreshadow_setup_hint'],
    }

    overrides = up.get('symbol_evidence', {})
    for sym in (s.get('symbols') or []):
        if sym['symbol_id'] in overrides:
            sym['evidence_in_frame'] = overrides[sym['symbol_id']]

    applied += 1
    print(f'  {sid}: upgraded')

print(f'\nTotal upgraded: {applied}')

backup, _ = save_kb_safely(kb, KB_PATH)
print(f'Saved. (backup: {backup})')

# Verify final inventory
print('\n=== Final hotspot inventory ===')
print(f"{'scene_id':<8}  {'time':<6}  {'symbol_id':<27}  {'conf':<8}  {'deep_chars':<10}")
print('-' * 75)
for s in kb['scenes']:
    syms = s.get('symbols') or []
    if not syms:
        continue
    t = s['start_time']
    m, sec = divmod(int(t), 60)
    ts = f'{m:02d}:{sec:02d}'
    deep_len = len(s.get('plot', {}).get('deep_reading', '') or '')
    for sym in syms:
        print(f"{s['scene_id']:<8}  {ts:<6}  {sym['symbol_id']:<27}  {sym['confidence']:<8}  {deep_len}")
