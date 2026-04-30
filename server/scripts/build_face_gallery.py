#!/usr/bin/env python
"""
离线构建角色人脸 embedding 库（用 deepface + ArcFace 模型）。

参考图目录：
  server/kb/characters/face_refs/<character_id>/<actor_version>/*.jpg|png

输出：
  server/kb/characters/face_gallery.json

依赖：
  pip install deepface tf-keras   (deepface 依赖 tensorflow + keras，第一次装 ~1GB)

第一次运行会自动下载 ArcFace 权重（~140MB），存到 ~/.deepface/。
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
DETECTOR = 'retinaface'          # 准确，慢一点


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


def main():
    try:
        from deepface import DeepFace
        import cv2  # noqa: F401
        import numpy as np  # noqa: F401
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

    print(f"\n[1/2] 加载 deepface ({MODEL_NAME} + {DETECTOR})...")
    print("       首次运行会下载 ArcFace 权重 ~140MB")
    # 触发 model 加载
    DeepFace.build_model(MODEL_NAME)

    gallery = {
        'show': show.get('show'),
        'model': f'deepface {MODEL_NAME} (detector={DETECTOR})',
        'embedding_dim': 512,
        'characters': {},
    }
    total_embeddings = 0
    total_images = 0
    no_face_imgs = []

    print(f"\n[2/2] 扫描参考图并提取 embedding...\n")
    for ch in show.get('characters', []):
        cid = ch['character_id']
        char_dir = REFS_DIR / cid
        if not char_dir.is_dir():
            print(f"  [skip] {cid} (no refs dir)")
            continue

        gallery['characters'][cid] = {}

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
            if not imgs:
                print(f"  [skip] {cid}/{ver} ({actor}) — no images")
                continue

            embeddings = []
            for img_path in imgs:
                total_images += 1
                img = read_image_unicode(img_path)
                if img is None:
                    no_face_imgs.append(f"{img_path}  (cv2 read failed)")
                    continue
                try:
                    results = DeepFace.represent(
                        img_path=img,                     # 传 numpy array，避开 unicode 路径
                        model_name=MODEL_NAME,
                        detector_backend=DETECTOR,
                        enforce_detection=True,
                        align=True,
                    )
                    if not results:
                        no_face_imgs.append(img_path)
                        continue
                    # 多张脸时挑 facial_area 最大的
                    biggest = max(results, key=lambda r: (r.get('facial_area', {}).get('w', 0)
                                                          * r.get('facial_area', {}).get('h', 0)))
                    embeddings.append([float(x) for x in biggest['embedding']])
                except Exception as e:
                    no_face_imgs.append(f"{img_path}  ({type(e).__name__}: {e})")

            if embeddings:
                key = f"{ver}_{slugify(actor)}"
                gallery['characters'][cid][key] = {
                    'actor': actor,
                    'version': ver,
                    'active_range': av.get('active_range'),
                    'face_group_id': av.get('face_group_id'),
                    'embedding_count': len(embeddings),
                    'embeddings': embeddings,
                }
                total_embeddings += len(embeddings)
                print(f"  ok  {cid}/{key}: {len(embeddings)} embeddings (从 {len(imgs)} 张图)")
            else:
                print(f"  -- {cid}/{ver} ({actor}): 0 embeddings (所有图都没识别出脸)")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(gallery, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f"\n done.")
    print(f"  角色:      {len(gallery['characters'])}")
    print(f"  embedding: {total_embeddings} 条 (from {total_images} 张图)")
    if no_face_imgs:
        print(f"  ⚠ {len(no_face_imgs)} 张图未检测到脸 / 失败:")
        for p in no_face_imgs[:6]:
            print(f"    - {p}")
        if len(no_face_imgs) > 6:
            print(f"    ... 还有 {len(no_face_imgs) - 6} 张")
    print(f"  output:    {OUTPUT.relative_to(SERVER_DIR)}")


if __name__ == '__main__':
    main()
