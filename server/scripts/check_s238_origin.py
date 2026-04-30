"""检查几个'本应被 apply_upgrades.py 升级'的场景实际是否被覆盖了。"""
import json

kb = json.load(open(r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json', encoding='utf-8'))

# 我的手写 deep_reading 标志性短语 → 用来识别哪些场景成功被 apply
MARKERS = {
    's10':  '冷开场的论点收束句',
    's80':  '不到两秒的胸针特写',
    's109': "缺席的礼节",
    's121': "外交场合显形",
    's123': "海马家族用'不全礼'",
    's133': "构图羞辱直接把 s454",
    's146': "家庭止损",
    's192': "外交桌上'看不见的第三方'",
    's195': "记账员",
    's231': "We Light the Way",
    's238': "记账员",
    's349': "metaphor_made_literal",
    's385': "诊断书",
    's454': "诞生时刻",
    's509': "鼓掌入场",  # 已被 fix_daemon_whisper.py 重写
    's515': "记账员",   # 刚清掉
    's545': "ritual_omission_inverse",
    's550': "缺席的礼节",
    's620': "wedding_chaos 序列从这一帧起步",
    's661': "题眼之血",
    's663': "总账",
    's680': "We Light the Way",
    's685': "宇宙级收尾",
}

import io, sys
out_lines = []
written = 0
not_written = 0
for sid, marker in MARKERS.items():
    found = False
    for s in kb['scenes']:
        if s['scene_id'] == sid:
            dr = (s.get('plot') or {}).get('deep_reading') or ''
            ed = ((s.get('directing') or {}).get('intent_long') or '')
            blob = dr + ed + (s.get('narrative') or '')
            found = marker in blob
            break
    flag = 'OK' if found else 'MISSING'
    out_lines.append(f"  {sid}: {flag}  (looking for: {marker[:40]})")
    if found: written += 1
    else: not_written += 1

out_lines.append(f'\n手写富化生效: {written} / {written + not_written}')
out_lines.append('')
# 给一个被认为 MISSING 的 sample,把实际 deep_reading 抓出来看清楚
for s in kb['scenes']:
    if s['scene_id'] == 's10':
        out_lines.append('=== s10 实际 plot.deep_reading ===')
        out_lines.append((s.get('plot') or {}).get('deep_reading') or '(empty)')
        break

with open(r'C:\Users\Admin\Desktop\intern\video\server\scripts\audit.txt', 'w', encoding='utf-8') as f:
    f.write('\n'.join(out_lines))
print(f'wrote audit.txt — written={written} missing={not_written}')
