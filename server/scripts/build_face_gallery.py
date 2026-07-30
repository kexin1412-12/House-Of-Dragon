#!/usr/bin/env python
"""
离线构建角色人脸 embedding 库（deepface + ArcFace + RetinaFace 对齐）。

参考图目录：
  server/kb/characters/face_refs/<character_id>/<actor_version>/*.jpg|png

输出：
  server/kb/characters/face_gallery.json

历史教训（为什么不能"每张图取最大脸"）：
  参考图来自 Fandom 角色页，混着合影剧照 / 人群远景 / 家徽道具图，最大的脸
  经常根本不是这个角色（viserys 文件夹里的观赛席剧照最大脸是 Otto）。直接
  全部入库会得到一个 same-char 相似度 ~0.26、跨角色 ~0.8 的退化 gallery。

现在的做法：每张图取出**所有**脸（过滤太小/低置信度的），在每个 version
目录内按余弦相似度聚类，只保留"确定是这个角色"的那一簇：
  1. 优先选包含单人官方肖像（文件名带 official/infobox/portrait 且图里只有
     一张脸）的簇；
  2. 否则选覆盖不同图片数最多的簇（并列时优先含 wp_ 演员肖像的、再看脸面积）。
同角色跨 version 出现同一 embedding（同一文件被复制进两个目录）时只保留
证据更强的那个 version。embedding_count 永远等于实际存储数。

依赖：
  conda run -n hotd-face python scripts/build_face_gallery.py
"""

import os
import sys
import json
import glob
import pathlib

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

THIS_DIR = pathlib.Path(__file__).resolve().parent
SERVER_DIR = THIS_DIR.parent
SHOW_FILE = SERVER_DIR / 'kb' / 'characters' / 'house-of-the-dragon.json'
REFS_DIR = SERVER_DIR / 'kb' / 'characters' / 'face_refs'
OUTPUT = SERVER_DIR / 'kb' / 'characters' / 'face_gallery.json'

IMG_EXTS = ('.jpg', '.jpeg', '.png', '.webp')
MODEL_NAME = 'ArcFace'           # 512-d embeddings
DETECTOR = 'retinaface'          # 检测 + 关键点对齐

MIN_FACE_PX = 44                 # 脸宽/高低于这个像素数视为人群远景，跳过
MIN_DET_CONF = 0.90              # RetinaFace 置信度下限
CLUSTER_SIM = 0.45               # 两个 embedding 余弦 >= 这个 → 同一人
DEDUP_SIM = 0.985                # 近重复 embedding（同图复制）去重阈值
CROSS_CHAR_WARN = 0.55           # 不同角色质心相似度超过这个就大声警告

PORTRAIT_PAT = ('official', 'infobox', 'portrait')


def slugify(s: str) -> str:
    return ''.join(c if c.isalnum() else '_' for c in s).strip('_')


def read_image_unicode(img_path):
    """用 numpy + cv2.imdecode 读图，绕开 OpenCV 不能处理 Windows 中文路径的问题。"""
    import cv2
    import numpy as np
    try:
        with open(img_path, 'rb') as f:
            data = f.read()
        arr = np.frombuffer(data, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img
    except Exception:
        return None


def extract_faces(DeepFace, np, img, fname, log):
    """一张图里所有可用的脸 → [{emb, area, fname, n_faces_in_img}]"""
    h, w = img.shape[:2]
    try:
        results = DeepFace.represent(
            img_path=img,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR,
            enforce_detection=False,
            align=True,
        )
    except Exception as e:
        log.append(f"    ✗ {fname}: {type(e).__name__}: {e}")
        return []

    faces = []
    n_detected = 0
    for r in results or []:
        fa = r.get('facial_area') or {}
        x, y = fa.get('x', 0), fa.get('y', 0)
        fw, fh = fa.get('w', 0), fa.get('h', 0)
        conf = r.get('face_confidence', 0) or 0
        # 整图退化框 = 没真检测到
        if fw == 0 or fh == 0 or (x == 0 and y == 0 and fw == w and fh == h):
            continue
        n_detected += 1
        if fw < MIN_FACE_PX or fh < MIN_FACE_PX:
            log.append(f"    - {fname}: 跳过 {fw}x{fh} 小脸（人群远景）")
            continue
        if conf < MIN_DET_CONF:
            log.append(f"    - {fname}: 跳过低置信度脸 conf={conf:.2f}")
            continue
        v = np.array(r['embedding'], dtype=np.float32)
        v = v / (np.linalg.norm(v) + 1e-8)
        faces.append({'emb': v, 'area': fw * fh, 'fname': fname})
    for f in faces:
        f['n_faces_in_img'] = n_detected
    return faces


def cluster_faces(np, faces):
    """贪心 union-find：余弦 >= CLUSTER_SIM 连边。返回 list[list[face]]。"""
    n = len(faces)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        for j in range(i + 1, n):
            if float(np.dot(faces[i]['emb'], faces[j]['emb'])) >= CLUSTER_SIM:
                parent[find(i)] = find(j)

    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(faces[i])
    return list(groups.values())


def is_portrait_file(fname):
    low = fname.lower()
    return any(p in low for p in PORTRAIT_PAT)


def pick_identity_cluster(clusters, log):
    """选"确定是本角色"的簇。返回 (cluster, reason)。"""
    def stats(c):
        n_imgs = len({f['fname'] for f in c})
        has_portrait = any(is_portrait_file(f['fname']) and f['n_faces_in_img'] == 1 for f in c)
        has_wp = any(f['fname'].startswith('wp_') and f['n_faces_in_img'] == 1 for f in c)
        area = sum(f['area'] for f in c)
        return n_imgs, has_portrait, has_wp, area

    portrait_clusters = [c for c in clusters if stats(c)[1]]
    if portrait_clusters:
        best = max(portrait_clusters, key=lambda c: (stats(c)[0], stats(c)[3]))
        return best, 'anchored by single-face official/infobox portrait', True

    best = max(clusters, key=lambda c: (stats(c)[0], stats(c)[2], stats(c)[3]))
    n_imgs, _, has_wp, _ = stats(best)
    reason = f'largest cluster ({n_imgs} images{", incl. wp_ actor portrait" if has_wp else ""})'
    # wp_ 演员肖像也算可信锚点；纯"最大簇"无锚点时不可信，后面会做冒名过滤
    anchor_backed = bool(has_wp)
    if n_imgs < 2 and not has_wp:
        reason += '  ⚠ weak evidence'
    return best, reason, anchor_backed


def main():
    try:
        from deepface import DeepFace
        import cv2  # noqa: F401
        import numpy as np
    except ImportError as e:
        print(f"\n✗ 缺依赖: {e}")
        print("  pip install deepface tf-keras opencv-python numpy")
        sys.exit(1)

    if not SHOW_FILE.exists():
        print(f"✗ 找不到 character DB: {SHOW_FILE}")
        sys.exit(1)
    show = json.loads(SHOW_FILE.read_text(encoding='utf-8'))

    if not REFS_DIR.exists() or not any(REFS_DIR.iterdir()):
        print(f"\n✗ 参考图目录是空的: {REFS_DIR}")
        sys.exit(1)

    print(f"\n[1/3] 加载 deepface ({MODEL_NAME} + {DETECTOR})...")
    DeepFace.build_model(MODEL_NAME)

    gallery = {
        'show': show.get('show'),
        'model': f'deepface {MODEL_NAME} (detector={DETECTOR})',
        'embedding_dim': 512,
        'characters': {},
    }
    # 暂存：cid → vkey → {meta, faces:[face]}，跨 version 去重后再落库
    staged = {}
    total_images = 0

    print(f"\n[2/3] 扫描参考图、聚类、挑身份簇...\n")
    for ch in show.get('characters', []):
        cid = ch['character_id']
        char_dir = REFS_DIR / cid
        if not char_dir.is_dir():
            continue

        for av in ch.get('actor_versions', []):
            ver = av['version']
            actor = av['actor_name']
            ver_dir = char_dir / ver
            if not ver_dir.is_dir():
                print(f"  [skip] {cid}/{ver} ({actor}) — no dir")
                continue

            imgs = []
            for ext in IMG_EXTS:
                imgs += glob.glob(str(ver_dir / f'*{ext}'))
                imgs += glob.glob(str(ver_dir / f'*{ext.upper()}'))
            imgs = sorted(set(imgs))
            if not imgs:
                print(f"  [skip] {cid}/{ver} ({actor}) — no images")
                continue

            log = []
            faces = []
            for img_path in imgs:
                total_images += 1
                fname = os.path.basename(img_path)
                img = read_image_unicode(img_path)
                if img is None:
                    log.append(f"    ✗ {fname}: cv2 read failed")
                    continue
                faces += extract_faces(DeepFace, np, img, fname, log)

            print(f"  {cid}/{ver} ({actor}): {len(imgs)} 图 → {len(faces)} 张可用脸")
            for line in log:
                print(line)
            if not faces:
                print(f"    -- 0 embeddings")
                continue

            clusters = cluster_faces(np, faces)
            chosen, reason, anchor_backed = pick_identity_cluster(clusters, log)
            dropped = len(faces) - len(chosen)
            print(f"    → {len(clusters)} 簇, 选 {len(chosen)} 脸 ({reason})"
                  + (f", 丢弃 {dropped} 张他人/存疑脸" if dropped else ""))

            # 簇内近重复去重
            kept = []
            for f in chosen:
                if all(float(np.dot(f['emb'], k['emb'])) < DEDUP_SIM for k in kept):
                    kept.append(f)
            if len(kept) < len(chosen):
                print(f"    → 去重后 {len(kept)} 条（{len(chosen) - len(kept)} 条近重复）")

            key = f"{ver}_{slugify(actor)}"
            staged.setdefault(cid, {})[key] = {
                'meta': {
                    'actor': actor,
                    'version': ver,
                    'active_range': av.get('active_range'),
                    'face_group_id': av.get('face_group_id'),
                },
                'anchor_backed': anchor_backed,
                'faces': kept,
            }

    # 跨 version 安全网：同角色两个 version 里出现同一 embedding（同文件被复制
    # 进两个目录）→ 只留证据更强（不同图片数更多）的 version
    for cid, versions in staged.items():
        vkeys = list(versions.keys())
        for i in range(len(vkeys)):
            for j in range(i + 1, len(vkeys)):
                a, b = versions[vkeys[i]], versions[vkeys[j]]
                strong, weak, weak_key = (a, b, vkeys[j]) if len({f['fname'] for f in a['faces']}) >= len({f['fname'] for f in b['faces']}) else (b, a, vkeys[i])
                before = len(weak['faces'])
                weak['faces'] = [f for f in weak['faces']
                                 if all(float(np.dot(f['emb'], s['emb'])) < DEDUP_SIM for s in strong['faces'])]
                if len(weak['faces']) < before:
                    print(f"  ⚠ {cid}: {before - len(weak['faces'])} 条 embedding 同时出现在两个 version，"
                          f"从 {weak_key} 移除（疑似文件被复制错目录）")

    # 冒名过滤：无可信锚点的 version（纯"最大簇"猜出来的）如果某条 embedding 跟
    # 另一个**有锚点**角色的脸相似度 >= CLUSTER_SIM，说明这簇八成抓错了人（从群像
    # 剧照里挑到了配角）。删掉它，别让它变成新的坍缩 hub。这就是 mysaria 那条把
    # 暗光 Viserys 拉过去的脏 embedding 的来源。
    trusted = []  # (cid, emb) for anchor-backed characters
    for cid, versions in staged.items():
        if any(v['anchor_backed'] for v in versions.values()):
            for v in versions.values():
                if v['anchor_backed']:
                    trusted += [(cid, f['emb']) for f in v['faces']]
    for cid, versions in staged.items():
        for vkey, entry in versions.items():
            if entry['anchor_backed']:
                continue
            keep = []
            for f in entry['faces']:
                hit = next(((tc, float(np.dot(f['emb'], te))) for tc, te in trusted
                            if tc != cid and float(np.dot(f['emb'], te)) >= CLUSTER_SIM), None)
                if hit:
                    print(f"  ⚠ {cid}/{vkey}: 删 1 条无锚点 embedding — 与已确认角色 "
                          f"{hit[0]} 相似度 {hit[1]:.3f}，疑似抓错人")
                else:
                    keep.append(f)
            entry['faces'] = keep

    total_embeddings = 0
    for cid, versions in staged.items():
        out_versions = {}
        for vkey, entry in versions.items():
            if not entry['faces']:
                continue
            embs = [[float(x) for x in f['emb']] for f in entry['faces']]
            out_versions[vkey] = {
                **entry['meta'],
                'embedding_count': len(embs),
                'source_images': sorted({f['fname'] for f in entry['faces']}),
                'embeddings': embs,
            }
            total_embeddings += len(embs)
        if out_versions:
            gallery['characters'][cid] = out_versions

    # 全库交叉体检：不同角色的质心不该相似
    print(f"\n[3/3] 交叉体检（不同角色质心相似度 > {CROSS_CHAR_WARN} 会警告）...")
    cents = []
    for cid, versions in gallery['characters'].items():
        embs = [e for v in versions.values() for e in v['embeddings']]
        c = np.mean(np.array(embs, dtype=np.float32), axis=0)
        c = c / (np.linalg.norm(c) + 1e-8)
        cents.append((cid, c))
    warned = False
    for i in range(len(cents)):
        for j in range(i + 1, len(cents)):
            sim = float(np.dot(cents[i][1], cents[j][1]))
            if sim > CROSS_CHAR_WARN:
                print(f"  ⚠ {cents[i][0]} vs {cents[j][0]}: centroid sim={sim:.3f} — 参考图可能仍混了人")
                warned = True
    if not warned:
        print("  ✓ 无跨角色污染迹象")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(gallery, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f"\n done.")
    print(f"  角色:      {len(gallery['characters'])}")
    print(f"  embedding: {total_embeddings} 条 (扫描 {total_images} 张图)")
    print(f"  output:    {OUTPUT.relative_to(SERVER_DIR)}")


if __name__ == '__main__':
    main()
