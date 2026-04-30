#!/usr/bin/env python
"""
Face Recognition Service — 长跑 Flask 服务，加载 deepface ArcFace + face_gallery.json。

Node 后端 POST 当前帧给它，返回检测到的脸 + 闭集匹配结果。

启动：
  python scripts/face_service.py            # 默认 5001 端口
  python scripts/face_service.py --port 5002

接口：
  POST http://localhost:5001/recognize
  body: { "image": "data:image/jpeg;base64,..." }
  resp: {
    "faces": [
      {
        "bbox": [x1, y1, x2, y2],     # 0..1 相对坐标
        "match": {
          "character_id": "rhaenyra_targaryen",
          "version": "young",
          "actor": "Milly Alcock",
          "similarity": 0.62           # cosine sim, 0..1
        } | null,
        "candidates": [...]
      }
    ]
  }

匹配阈值（可在命令行 --threshold 调）：
  ACCEPT_THRESHOLD = 0.45    # cosine sim >= 这个 → 命中
"""

import os
import sys
import json
import base64
import argparse
import pathlib

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

THIS_DIR = pathlib.Path(__file__).resolve().parent
SERVER_DIR = THIS_DIR.parent
GALLERY_FILE = SERVER_DIR / 'kb' / 'characters' / 'face_gallery.json'

DEFAULT_THRESHOLD = 0.45
DEFAULT_MARGIN = 0.05  # top1 - top2 必须 >= 这个值；否则视为模糊匹配，拒识
CANDIDATE_TOP_K = 3
MODEL_NAME = 'ArcFace'
DETECTOR = 'retinaface'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5001)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--threshold', type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument('--margin', type=float, default=DEFAULT_MARGIN,
                        help='top-1 must beat top-2 by this margin or match is rejected as ambiguous')
    args = parser.parse_args()

    try:
        import cv2
        import numpy as np
        from deepface import DeepFace
        from flask import Flask, request, jsonify
        from flask_cors import CORS
    except ImportError as e:
        print(f"✗ 缺依赖: {e}")
        print("  pip install deepface tf-keras opencv-python numpy flask flask-cors")
        sys.exit(1)

    if not GALLERY_FILE.exists():
        print(f"✗ 找不到 face_gallery.json: {GALLERY_FILE}")
        print("  先跑 python scripts/build_face_gallery.py 构建库")
        sys.exit(1)

    print(f"[init] loading face_gallery.json ...")
    gallery = json.loads(GALLERY_FILE.read_text(encoding='utf-8'))

    # 摊平：[(char_id, version_key, actor, version, active_range, normalized_emb)]
    flat = []
    for cid, versions in gallery.get('characters', {}).items():
        for vkey, ventry in versions.items():
            for emb in ventry.get('embeddings', []):
                v = np.array(emb, dtype=np.float32)
                v = v / (np.linalg.norm(v) + 1e-8)
                flat.append({
                    'character_id': cid,
                    'version_key': vkey,
                    'actor': ventry.get('actor'),
                    'version': ventry.get('version'),
                    'active_range': ventry.get('active_range'),
                    'emb': v,
                })
    print(f"[init] {len(flat)} embeddings across {len(gallery.get('characters', {}))} characters")

    print(f"[init] preloading deepface ({MODEL_NAME} + {DETECTOR}) ...")
    DeepFace.build_model(MODEL_NAME)

    app = Flask(__name__)
    CORS(app)

    @app.get('/health')
    def health():
        return jsonify({
            'ok': True,
            'gallery_size': len(flat),
            'characters': list(gallery.get('characters', {}).keys()),
            'threshold': args.threshold,
        })

    @app.post('/recognize')
    def recognize():
        body = request.get_json(silent=True) or {}
        data_url = body.get('image', '')
        if not isinstance(data_url, str) or not data_url.startswith('data:image/'):
            return jsonify({'error': 'image data URL required', 'faces': []}), 400

        try:
            _, b64 = data_url.split(',', 1)
            raw = base64.b64decode(b64)
            arr = np.frombuffer(raw, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                return jsonify({'error': 'cannot decode image', 'faces': []}), 400
        except Exception as e:
            return jsonify({'error': f'decode: {e}', 'faces': []}), 400

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
            return jsonify({'error': f'represent: {e}', 'faces': []}), 500

        out_faces = []
        for r in results or []:
            fa = r.get('facial_area') or {}
            x = fa.get('x', 0)
            y = fa.get('y', 0)
            fw = fa.get('w', 0)
            fh = fa.get('h', 0)
            # facial_area 偶尔退化为 (0,0,W,H) 表示"没真检测到"
            if fw == 0 or fh == 0 or (x == 0 and y == 0 and fw == w and fh == h):
                continue
            bbox_norm = [
                max(0.0, x / w),
                max(0.0, y / h),
                min(1.0, (x + fw) / w),
                min(1.0, (y + fh) / h),
            ]

            q = np.array(r['embedding'], dtype=np.float32)
            q = q / (np.linalg.norm(q) + 1e-8)

            best_per_group = {}
            for g in flat:
                sim = float(np.dot(q, g['emb']))
                key = (g['character_id'], g['version_key'])
                cur = best_per_group.get(key)
                if cur is None or sim > cur['similarity']:
                    best_per_group[key] = {
                        'character_id': g['character_id'],
                        'version': g['version'],
                        'actor': g['actor'],
                        'active_range': g['active_range'],
                        'similarity': sim,
                    }

            ranked = sorted(best_per_group.values(), key=lambda x: -x['similarity'])
            top = ranked[:CANDIDATE_TOP_K]
            match = None
            status = 'no_face'
            if top:
                top1_sim = top[0]['similarity']
                top2_sim = top[1]['similarity'] if len(top) >= 2 else -1.0
                margin = top1_sim - top2_sim
                if top1_sim < args.threshold:
                    status = 'below_threshold'
                elif margin < args.margin:
                    # top-1 和 top-2 太接近 → 模糊匹配，拒识。常见于"两个老男人"、"两个红发女子"
                    status = 'ambiguous'
                else:
                    status = 'matched'
                    match = top[0]

            out_faces.append({
                'bbox': bbox_norm,
                'match': match,
                'status': status,
                'candidates': top,
            })

        return jsonify({'faces': out_faces})

    print(f"\n✓ Face service listening on http://{args.host}:{args.port}  "
          f"(threshold={args.threshold}, margin={args.margin})")
    print(f"  health:    GET  /health")
    print(f"  recognize: POST /recognize  body={{ image: 'data:image/jpeg;base64,...' }}")
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == '__main__':
    main()
