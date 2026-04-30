#!/usr/bin/env python
"""
Offline character tracking — 对 KB 里每个 scene：
  1. 在 [start_time, end_time] 内按固定 fps 采帧
  2. RetinaFace 检测人脸 + ArcFace 提 embedding（复用 face_service 同款 deepface 栈）
  3. scene 内做 IoU + embedding 相似度的贪心追踪 → 形成 tracks
  4. 每个 track 的 mean embedding 与 face_gallery 闭集比对 → 匹配到 character_id
  5. 把结果写回 KB 的 scenes[].characters[] 和 scenes[].characters_on_screen[]

Usage:
  python scripts/track_characters.py <video_path> <kb_path>
  python scripts/track_characters.py uploads/foo.mp4 kb/foo.json --fps 1.5

设计约束：
- 不依赖 ByteTrack/DeepSORT 库 —— 短 scene 内（avg 2-15 帧）embedding 比 Kalman 更可靠
- 复用现有 face_service 的 ArcFace 模型缓存（首次跑会下载，之后秒级启动）
- 同一 character_id 在一个 scene 内合并 screen_time，避免多 track 重复计数
"""

import argparse
import json
import pathlib
import sys
import time

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

THIS_DIR = pathlib.Path(__file__).resolve().parent
SERVER_DIR = THIS_DIR.parent
GALLERY_FILE = SERVER_DIR / 'kb' / 'characters' / 'face_gallery.json'

ACCEPT_THRESHOLD = 0.45    # cosine sim >= 这个才接受为某 character_id 的匹配
ACCEPT_MARGIN = 0.05       # top-1 必须比 top-2 高这么多，否则视为模糊匹配，拒识
TRACK_EMB_THRESHOLD = 0.55 # 同 scene 内两次检测属于同一 track 的 embedding 阈值
TRACK_IOU_WEIGHT = 0.3     # IoU 在 track 关联得分里的权重（embedding 才是主信号）

DEFAULT_FPS = 1.5
MIN_FRAMES_PER_SCENE = 2
MAX_FRAMES_PER_SCENE = 12

MODEL_NAME = 'ArcFace'
DETECTOR = 'retinaface'


def normalize(v):
    import numpy as np
    return v / (np.linalg.norm(v) + 1e-8)


def iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    return inter / (area_a + area_b - inter + 1e-8)


def load_gallery():
    import numpy as np
    if not GALLERY_FILE.exists():
        return []
    data = json.loads(GALLERY_FILE.read_text(encoding='utf-8'))
    flat = []
    for cid, versions in data.get('characters', {}).items():
        for vkey, ventry in versions.items():
            for emb in ventry.get('embeddings', []):
                flat.append({
                    'character_id': cid,
                    'version_key': vkey,
                    'version': ventry.get('version'),
                    'actor': ventry.get('actor'),
                    'active_range': ventry.get('active_range'),
                    'emb': normalize(np.array(emb, dtype=np.float32)),
                })
    return flat


def match_character(emb, gallery, threshold, margin=ACCEPT_MARGIN):
    """闭集匹配 + 「不同 character_id」之间的 margin 检查。
    margin 是必要的：两位老男人（Otto/Lyonel）embeddings 接近时，光看 top-1 总是误判。
    """
    import numpy as np
    if not gallery:
        return None
    # 先按 character_id 折叠：同角色多个 embedding 取最高
    best_per_char = {}
    for g in gallery:
        sim = float(np.dot(emb, g['emb']))
        cur = best_per_char.get(g['character_id'])
        if cur is None or sim > cur['similarity']:
            best_per_char[g['character_id']] = {
                'character_id': g['character_id'],
                'version': g['version'],
                'version_key': g['version_key'],
                'similarity': sim,
            }
    ranked = sorted(best_per_char.values(), key=lambda x: -x['similarity'])
    if not ranked or ranked[0]['similarity'] < threshold:
        return None
    if len(ranked) >= 2 and ranked[0]['similarity'] - ranked[1]['similarity'] < margin:
        return None  # ambiguous
    return ranked[0]


def detect_faces(img, deepface_module):
    import numpy as np
    h, w = img.shape[:2]
    try:
        results = deepface_module.represent(
            img_path=img,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR,
            enforce_detection=False,
            align=True,
        )
    except Exception:
        return []
    out = []
    for r in results or []:
        fa = r.get('facial_area') or {}
        x, y, fw, fh = fa.get('x', 0), fa.get('y', 0), fa.get('w', 0), fa.get('h', 0)
        # facial_area 退化成整张图 → 没真检到，丢弃
        if fw == 0 or fh == 0 or (x == 0 and y == 0 and fw == w and fh == h):
            continue
        bbox = [
            max(0.0, x / w),
            max(0.0, y / h),
            min(1.0, (x + fw) / w),
            min(1.0, (y + fh) / h),
        ]
        emb = normalize(np.array(r['embedding'], dtype=np.float32))
        out.append({'bbox': bbox, 'embedding': emb})
    return out


def sample_timestamps(start, end, fps):
    duration = max(0.0, end - start)
    target = max(MIN_FRAMES_PER_SCENE, min(MAX_FRAMES_PER_SCENE, int(round(duration * fps))))
    if target <= 1:
        return [start + duration / 2]
    step = duration / (target - 1)
    return [start + i * step for i in range(target)]


def cluster_into_tracks(per_frame_detections):
    """
    per_frame_detections: [(t, [{bbox, embedding}, ...]), ...]
    返回 tracks: [{appearances, emb_avg, emb_count}, ...]

    贪心匹配：每帧的每个检测 → 找最匹配的现有 track（embedding 相似度为主，IoU 当 tiebreaker）
    """
    import numpy as np
    tracks = []

    for t, dets in per_frame_detections:
        used = [False] * len(tracks)
        # 同一帧内多张脸：按"最佳得分"逐个分配，避免两张脸抢同一个 track
        scored = []  # (score, det_idx, track_idx)
        for di, det in enumerate(dets):
            for ti, tr in enumerate(tracks):
                appear = float(np.dot(det['embedding'], tr['emb_avg']))
                if appear < TRACK_EMB_THRESHOLD:
                    continue
                spatial = iou(det['bbox'], tr['bbox_last'])
                scored.append((appear + TRACK_IOU_WEIGHT * spatial, di, ti))
        scored.sort(reverse=True)
        det_assigned = [False] * len(dets)
        for score, di, ti in scored:
            if det_assigned[di] or used[ti]:
                continue
            tr = tracks[ti]
            n = tr['emb_count']
            tr['emb_avg'] = normalize((tr['emb_avg'] * n + dets[di]['embedding']) / (n + 1))
            tr['emb_count'] = n + 1
            tr['bbox_last'] = dets[di]['bbox']
            tr['appearances'].append({'t': t, 'bbox': dets[di]['bbox']})
            det_assigned[di] = True
            used[ti] = True

        # 没分配到的检测 → 开新 track
        for di, det in enumerate(dets):
            if det_assigned[di]:
                continue
            tracks.append({
                'bbox_last': det['bbox'],
                'emb_avg': det['embedding'].copy(),
                'emb_count': 1,
                'appearances': [{'t': t, 'bbox': det['bbox']}],
            })
    return tracks


def process_scene(cap, scene, gallery, fps, threshold, deepface_module, cv2_module):
    timestamps = sample_timestamps(scene['start_time'], scene['end_time'], fps)
    per_frame = []
    for t in timestamps:
        cap.set(cv2_module.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        dets = detect_faces(frame, deepface_module)
        per_frame.append((t, dets))

    tracks = cluster_into_tracks(per_frame)
    return tracks, len(per_frame)

def build_track_records(tracks, scene, gallery, fps, threshold, margin=ACCEPT_MARGIN):
    out_tracks = []
    for ti, tr in enumerate(tracks):
        m = match_character(tr['emb_avg'], gallery, threshold, margin)
        track_id = f"{scene['scene_id']}_t{ti+1:02d}"
        if len(tr['appearances']) > 1:
            screen_time = tr['appearances'][-1]['t'] - tr['appearances'][0]['t']
        else:
            screen_time = 1.0 / max(fps, 1e-3)  # 单帧出现：保守按一个采样间隔算
        out_tracks.append({
            'track_id': track_id,
            'character_id': m['character_id'] if m else None,
            'similarity': round(m['similarity'], 4) if m else None,
            'frame_count': len(tr['appearances']),
            'screen_time_s': round(screen_time, 2),
            'appearances': [
                {'t': round(a['t'], 2), 'bbox': [round(x, 4) for x in a['bbox']]}
                for a in tr['appearances']
            ],
        })
    return out_tracks


def write_back(scene, tracks):
    # 按 character_id 聚合（同一角色多 track → 累加 screen_time）
    char_agg = {}
    on_screen_records = []
    for tr in tracks:
        cid = tr['character_id']
        # appearances 全部进 characters_on_screen（含未匹配的，character_id=None）
        for a in tr['appearances']:
            on_screen_records.append({
                'character_id': cid,
                'track_id': tr['track_id'],
                't': a['t'],
                'bbox': a['bbox'],
                'confidence': tr['similarity'],
            })
        if not cid:
            continue
        if cid in char_agg:
            char_agg[cid]['screen_time_s'] += tr['screen_time_s']
            char_agg[cid]['track_count'] += 1
        else:
            char_agg[cid] = {
                'id': cid,
                'screen_time_s': tr['screen_time_s'],
                'track_count': 1,
                'similarity': tr['similarity'],
            }

    scene['characters_on_screen'] = on_screen_records

    # 合并到 scenes[].characters[]：保留已有的 emotion / motivation_shift 字段
    existing = {c.get('id'): c for c in (scene.get('characters') or []) if c.get('id')}
    merged = []
    for cid, info in char_agg.items():
        prev = existing.get(cid, {})
        merged.append({
            'id': cid,
            'emotion': prev.get('emotion'),
            'motivation_shift': prev.get('motivation_shift'),
            'screen_time_s': round(info['screen_time_s'], 2),
            'track_count': info['track_count'],
            'face_similarity': round(info['similarity'], 4),
        })
    # 已有但本次没追到的角色：保留（可能是非脸部出现，比如背影/远景）
    for cid, c in existing.items():
        if cid not in char_agg:
            merged.append(c)
    scene['characters'] = merged


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('video_path')
    parser.add_argument('kb_path')
    parser.add_argument('--fps', type=float, default=DEFAULT_FPS,
                        help=f'frames per second to sample within each scene (default {DEFAULT_FPS})')
    parser.add_argument('--threshold', type=float, default=ACCEPT_THRESHOLD,
                        help=f'cosine sim threshold to accept a character match (default {ACCEPT_THRESHOLD})')
    parser.add_argument('--margin', type=float, default=ACCEPT_MARGIN,
                        help=f'top-1 must beat top-2 by this margin or match is rejected (default {ACCEPT_MARGIN})')
    parser.add_argument('--scene', help='only process this scene_id (for debugging)')
    args = parser.parse_args()

    video_path = pathlib.Path(args.video_path)
    kb_path = pathlib.Path(args.kb_path)
    if not video_path.exists():
        print(f"✗ video not found: {video_path}")
        sys.exit(1)
    if not kb_path.exists():
        print(f"✗ KB not found: {kb_path}  — 先跑 npm run preprocess 生成 KB skeleton")
        sys.exit(1)

    try:
        import cv2
        import numpy as np  # noqa: F401  (used inside helpers)
        from deepface import DeepFace
    except ImportError as e:
        print(f"✗ 缺依赖: {e}")
        print("  pip install deepface tf-keras opencv-python numpy")
        sys.exit(1)

    print(f"[init] loading KB: {kb_path}")
    kb = json.loads(kb_path.read_text(encoding='utf-8'))
    scenes = kb.get('scenes', [])
    if args.scene:
        scenes = [s for s in scenes if s.get('scene_id') == args.scene]
        print(f"[init] filtered to scene_id={args.scene}: {len(scenes)} match")
    print(f"[init] {len(scenes)} scenes to process")

    print(f"[init] loading face gallery: {GALLERY_FILE}")
    gallery = load_gallery()
    print(f"[init] {len(gallery)} embeddings across "
          f"{len({g['character_id'] for g in gallery})} characters")

    print(f"[init] preloading deepface ({MODEL_NAME} + {DETECTOR}) ...")
    DeepFace.build_model(MODEL_NAME)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"✗ cannot open video: {video_path}")
        sys.exit(1)

    print(f"\n[run] tracking at {args.fps} fps within each scene "
          f"(threshold={args.threshold}, margin={args.margin})")
    t0 = time.time()
    matched_total = 0
    for i, scene in enumerate(scenes):
        sid = scene.get('scene_id', f's{i+1:02d}')
        try:
            raw_tracks, frames_sampled = process_scene(
                cap, scene, gallery, args.fps, args.threshold, DeepFace, cv2,
            )
        except Exception as e:
            print(f"  [{i+1}/{len(scenes)}] {sid} ERROR: {e}")
            continue
        track_records = build_track_records(raw_tracks, scene, gallery, args.fps, args.threshold, args.margin)
        write_back(scene, track_records)
        matched = [t['character_id'] for t in track_records if t['character_id']]
        matched_total += len(matched)
        names = ', '.join(sorted(set(matched))) if matched else '(none)'
        print(f"  [{i+1}/{len(scenes)}] {sid} "
              f"({scene['start_time']:.1f}-{scene['end_time']:.1f}s) "
              f"frames_sampled={frames_sampled}  tracks={len(track_records)}  "
              f"matched={len(matched)}  → {names}")

    cap.release()

    kb['character_tracking'] = {
        'updated_at': time.time(),
        'sample_fps': args.fps,
        'threshold': args.threshold,
        'margin': args.margin,
        'gallery_size': len(gallery),
    }
    kb_path.write_text(json.dumps(kb, ensure_ascii=False, indent=2), encoding='utf-8')

    elapsed = time.time() - t0
    print(f"\n✓ Done in {elapsed:.1f}s. Matched {matched_total} character appearances across {len(scenes)} scenes.")
    print(f"  KB written: {kb_path}")


if __name__ == '__main__':
    main()
