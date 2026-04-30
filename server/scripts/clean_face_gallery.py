#!/usr/bin/env python
"""
清洗 face_gallery.json：
  1. 去除完全重复的 embedding（intra-character cosine ≥ 0.999 的对，保留先到的）
  2. 标记并剔除"跨角色污染"embedding：当某 embedding 与**其它角色**的最佳 cosine
     超过 CROSS_THRESHOLD（默认 0.85）时，几乎肯定是 build 时把别人的脸标错了。

用法：
  python scripts/clean_face_gallery.py            # dry-run，仅打印诊断
  python scripts/clean_face_gallery.py --apply    # 写回 face_gallery.json，自动备份原文件
"""
import argparse, json, pathlib, sys, time, numpy as np

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

ROOT = pathlib.Path(__file__).resolve().parent.parent
GALLERY = ROOT / 'kb' / 'characters' / 'face_gallery.json'

DUP_THRESHOLD = 0.999     # intra-character: 视为同一 embedding
CROSS_THRESHOLD = 0.85    # cross-character: 视为污染（这么像别人，几乎肯定是别人）

def normalize(v):
    return v / (np.linalg.norm(v) + 1e-8)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--cross-threshold', type=float, default=CROSS_THRESHOLD)
    args = ap.parse_args()

    g = json.loads(GALLERY.read_text(encoding='utf8'))

    # 摊平：(cid, vkey, idx, normalized_emb)
    flat = []
    for cid, versions in g['characters'].items():
        for vkey, ventry in versions.items():
            for idx, raw in enumerate(ventry.get('embeddings', [])):
                flat.append({
                    'cid': cid, 'vkey': vkey, 'idx': idx,
                    'emb': normalize(np.array(raw, dtype=np.float32)),
                })
    print(f'[scan] {len(flat)} embeddings across '
          f'{len({(f["cid"], f["vkey"]) for f in flat})} (character, version) groups')

    # Step 1: intra-character 去重
    keep = [True] * len(flat)
    dup_pairs = []
    by_char_version = {}
    for i, f in enumerate(flat):
        by_char_version.setdefault((f['cid'], f['vkey']), []).append(i)
    for key, idxs in by_char_version.items():
        for a in range(len(idxs)):
            if not keep[idxs[a]]: continue
            for b in range(a+1, len(idxs)):
                if not keep[idxs[b]]: continue
                sim = float(np.dot(flat[idxs[a]]['emb'], flat[idxs[b]]['emb']))
                if sim >= DUP_THRESHOLD:
                    keep[idxs[b]] = False
                    dup_pairs.append((flat[idxs[a]], flat[idxs[b]], sim))
    print(f'[step1] removed {sum(1 for x in dup_pairs)} intra-character duplicates')
    for a, b, s in dup_pairs[:8]:
        print(f"  dup: {a['cid']}/{a['vkey']} e{a['idx']+1} == e{b['idx']+1}  (sim={s:.3f})")

    # Step 2: cross-character 污染剔除（仅在还活着的 embedding 中检查）
    contaminated = []
    alive_indices = [i for i, k in enumerate(keep) if k]
    for ai in alive_indices:
        a = flat[ai]
        worst_other_sim = -1.0
        worst_other = None
        for bi in alive_indices:
            if bi == ai: continue
            b = flat[bi]
            if b['cid'] == a['cid']: continue   # 同角色不算
            sim = float(np.dot(a['emb'], b['emb']))
            if sim > worst_other_sim:
                worst_other_sim = sim
                worst_other = b
        if worst_other_sim >= args.cross_threshold:
            keep[ai] = False
            contaminated.append((a, worst_other, worst_other_sim))
    print(f'[step2] removed {len(contaminated)} cross-character contaminations '
          f'(>= {args.cross_threshold} cosine to another character):')
    for a, b, s in contaminated:
        print(f"  ✗ {a['cid']}/{a['vkey']} e{a['idx']+1} matches "
              f"{b['cid']}/{b['vkey']} e{b['idx']+1} at sim={s:.3f}")

    if not args.apply:
        print('\n  (dry-run; pass --apply to write changes)')
        return

    # 应用：重建 character → versions → embeddings
    new_chars = {}
    for f, k in zip(flat, keep):
        if not k: continue
        cid = f['cid']; vkey = f['vkey']
        new_chars.setdefault(cid, {}).setdefault(vkey, [])
        new_chars[cid][vkey].append(f['emb'].tolist())

    # 套回原结构（保留 actor / version / active_range 等元数据）
    for cid, versions in g['characters'].items():
        for vkey, ventry in versions.items():
            new_embs = new_chars.get(cid, {}).get(vkey, [])
            ventry['embeddings'] = new_embs

    # 备份 + 写回
    backup = GALLERY.with_suffix(f'.backup-{int(time.time())}.json')
    backup.write_text(json.dumps(g, ensure_ascii=False, indent=2), encoding='utf8')  # 写之前先 copy
    # 实际备份是把当前磁盘内容存一份；这里先 read 原文件
    backup.write_text(GALLERY.read_text(encoding='utf8'), encoding='utf8')
    GALLERY.write_text(json.dumps(g, ensure_ascii=False, indent=2), encoding='utf8')
    print(f'\n✓ wrote cleaned gallery: {GALLERY}')
    print(f'  backup: {backup}')

    # 汇总每角色 embedding 数变化
    print('\nper-character embedding count after cleaning:')
    for cid, versions in g['characters'].items():
        for vkey, ventry in versions.items():
            print(f'  {cid}/{vkey}: {len(ventry["embeddings"])}')

if __name__ == '__main__':
    main()
