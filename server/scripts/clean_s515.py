"""
清 s515 (46:20):
  - 删 rhaenys_watchful symbol（Gemini 自爆"蕾妮丝本人不在画面中"——画面里实际是奥托）
  - 重置 plot/shot/tags/foreshadow 为中性内容（婚宴舞池侧景过渡帧）
  - 顺手清理 s238/s663 里指向 s515 的 foreshadow 链接（基于错误假设)
"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'

with open(PATH, encoding='utf-8') as f:
    kb = json.load(f)

# ── s515：清符号 + 重置 plot ─────────────────────────────
for s in kb['scenes']:
    if s['scene_id'] != 's515':
        continue
    s['symbols'] = [x for x in (s.get('symbols') or []) if x['symbol_id'] != 'rhaenys_watchful']
    s['plot'] = {
        'fact': "婚宴舞池侧景，奥托·海塔尔在画面左侧模糊背景中，宴会人群继续。",
        'reading': "过渡帧——舞池段落里的人物分布，无核心符号触发。",
        'deep_reading': "",
    }
    s['narrative'] = None
    s['shot'] = {
        'framing': "舞池侧景中近景",
        'intent': "段落内的过渡",
        'emotion': "中性",
    }
    s['tags'] = ["舞池过渡", "无符号"]
    s['foreshadow'] = {'is_setup_for': [], 'is_payoff_of': [], 'setup_hint': None}
    print(f'  s515: cleaned. symbols now: {[x["symbol_id"] for x in s.get("symbols") or []]}')
    break

# ── s238：删指向 s515 的 setup_for ─────────────────────────
for s in kb['scenes']:
    if s['scene_id'] != 's238':
        continue
    fs_obj = s.get('foreshadow') or {}
    setup_for = fs_obj.get('is_setup_for') or []
    new_setup = [x for x in setup_for if x.get('target_scene') != 's515']
    if len(new_setup) != len(setup_for):
        fs_obj['is_setup_for'] = new_setup
        s['foreshadow'] = fs_obj
        print(f'  s238: removed foreshadow → s515')
    break

# ── s663：删指向 s515 的 payoff_of ─────────────────────────
for s in kb['scenes']:
    if s['scene_id'] != 's663':
        continue
    fs_obj = s.get('foreshadow') or {}
    payoff = fs_obj.get('is_payoff_of') or []
    new_payoff = [x for x in payoff if x.get('source_scene') != 's515']
    if len(new_payoff) != len(payoff):
        fs_obj['is_payoff_of'] = new_payoff
        s['foreshadow'] = fs_obj
        print(f'  s663: removed foreshadow ← s515')
    break

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print('Saved.')
