"""
KB 写入安全包装：每次落盘前先把当前磁盘上的版本快照一份。

为什么要这玩意：
  scene KB 没有 git，多个脚本都会 load → mutate → save，一个脚本读到旧状态再
  覆盖回去就会悄悄抹掉别人的工作（这就是 24 个手写富化曾经一夜消失的原因）。
  每次写之前都备份，至少给"恢复到 5 分钟前"留了一条退路。

约定：
  - 备份目录: <kb_dir>/.backups/<filename_no_ext>/
  - 文件名:   <ts>.json     （ts = 当前 UTC YYYYMMDD-HHMMSS-<microseconds>）
  - 保留数:   默认 20，超出按时间最早的删
  - 写入是原子的：先写到 .tmp，rename 到目标

用法：
    from lib.kb_io import save_kb_safely
    save_kb_safely(kb, r'C:\\...\\house_of_dragon_05.json')
"""
import json
import os
import shutil
import datetime


def _ts():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S-%f')


def _backups_dir(target_path):
    target_path = os.path.abspath(target_path)
    base_dir = os.path.dirname(target_path)
    stem = os.path.splitext(os.path.basename(target_path))[0]
    return os.path.join(base_dir, '.backups', stem)


def snapshot(target_path):
    """把当前磁盘上的 target_path 复制一份到备份目录。返回备份路径或 None（文件不存在时）。"""
    target_path = os.path.abspath(target_path)
    if not os.path.exists(target_path):
        return None
    bdir = _backups_dir(target_path)
    os.makedirs(bdir, exist_ok=True)
    bpath = os.path.join(bdir, f'{_ts()}.json')
    shutil.copy2(target_path, bpath)
    return bpath


def prune_backups(target_path, max_keep=20):
    """只保留最新 max_keep 个备份；多的从最早删。"""
    bdir = _backups_dir(target_path)
    if not os.path.isdir(bdir):
        return
    files = sorted(
        (os.path.join(bdir, f) for f in os.listdir(bdir) if f.endswith('.json')),
        key=os.path.getmtime,
    )
    excess = len(files) - max_keep
    if excess > 0:
        for f in files[:excess]:
            try:
                os.remove(f)
            except OSError:
                pass


def save_kb_safely(kb, target_path, max_backups=20):
    """
    备份现有 → 写新内容（原子 rename）→ 修剪旧备份。
    返回 (backup_path_or_None, target_path)。
    """
    bpath = snapshot(target_path)
    target_path = os.path.abspath(target_path)
    tmp_path = target_path + '.tmp'
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(kb, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, target_path)  # 原子替换
    prune_backups(target_path, max_keep=max_backups)
    return bpath, target_path


def list_backups(target_path):
    """返回该 KB 的所有备份路径，按时间从新到旧。"""
    bdir = _backups_dir(target_path)
    if not os.path.isdir(bdir):
        return []
    files = sorted(
        (os.path.join(bdir, f) for f in os.listdir(bdir) if f.endswith('.json')),
        key=os.path.getmtime,
        reverse=True,
    )
    return files
