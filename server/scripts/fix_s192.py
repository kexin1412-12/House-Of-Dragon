"""
修 s192 (15:16):
  - 删 viserys_wound symbol（画面里没有病手/绷带,LLM 把别的场景套来了）
  - 把全部 dagger 描述清理掉,换成此刻真实发生的事(韦赛里斯向 Corlys 提莱诺婚事)
  - 删 setup_hint 里那句"瓦雷利亚钢匕首"的脑补
"""
import json

PATH = r'C:\Users\Admin\Desktop\intern\video\server\kb\house_of_dragon_05.json'

with open(PATH, encoding='utf-8') as f:
    kb = json.load(f)

for s in kb['scenes']:
    if s['scene_id'] != 's192':
        continue

    # 1) 删 symbol
    s['symbols'] = [x for x in (s.get('symbols') or []) if x['symbol_id'] != 'viserys_wound']

    # 2) 重置 plot 为真实内容
    s['plot'] = {
        'fact': "韦赛里斯坐于潮头岛厅内,正对科利斯·瓦列利安开口提议——为雷妮拉与莱诺·瓦列利安订立婚约。镜头给到韦赛里斯说话时的中近景。",
        'reading': "国王亲口提亲,这是把婚事正式化的政治动作——把一段在朝堂上酝酿已久的联姻意图变成桌面上的请求。",
        'deep_reading': "这一帧是 S01E05 婚事谈判的关键节点。韦赛里斯没有派使节、没有走中间人,而是亲口向科利斯·瓦列利安开口——意味着他清楚瓦列利安一侧此前对'潮头岛被忽略'的不满,必须以国王本人的位格压住才能让谈判桌坐住。台词'I wish to propose a marriage between your son, Ser Laenor...'是整集后段海滩协议(s231)的政治前置——韦赛里斯亲口提议的,落到雷妮拉与莱诺手里就变成'各自过各自生活'的工程式契约。",
    }

    # 3) 重置 shot
    s['shot'] = {
        'framing': "中近景,韦赛里斯说话时的脸部",
        'intent': "把'国王亲口提亲'的政治姿态记录下来",
        'emotion': "克制 / 政治",
    }

    # 4) tags / narrative / foreshadow 修正
    s['tags'] = ["婚事谈判", "潮头岛厅内", "国王亲口提亲", "Laenor婚约前置"]
    s['narrative'] = "婚事谈判节点:韦赛里斯亲口向科利斯提议雷妮拉与莱诺联姻——把朝堂酝酿落到桌面。"
    s['foreshadow'] = {
        'is_setup_for': [
            {'target_scene': 's231', 'what': "海滩协议——本帧亲口提议的婚事在那里被两位当事人写成'各自过各自生活'的协议"},
            {'target_scene': 's680', 'what': "婚礼草草完成——亲口提议的婚事最终被血涂改"},
        ],
        'is_payoff_of': [
            {'source_scene': 's123', 'what': "迎宾不全礼——本帧是国王压住瓦列利安一侧不满的政治补救"},
        ],
        'setup_hint': "国王亲口提亲=不能再让别人代谈。",
    }

    print(f'  s192: cleaned dagger hallucination')
    print(f'    symbols now: {[x["symbol_id"] for x in s.get("symbols") or []]}')
    break

with open(PATH, 'w', encoding='utf-8') as f:
    json.dump(kb, f, ensure_ascii=False, indent=2)
print('Saved.')
