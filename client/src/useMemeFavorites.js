import { useCallback, useEffect, useState } from 'react';

// 文化梗收藏 —— 纯 localStorage，无后端。
// 数据形状：{ [riff_id]: addedAtMs }
//   - 用 map 而不是 Set 是为了能"按收藏时间排序"和显示"最近收藏"
//   - 老版本曾用 string[] 存储；进入时若检测到数组就自动迁移
//
// 跨组件 / 跨 tab 同步：
//   - storage 事件：浏览器内置，跨 tab
//   - meme-favorites-changed 自定义事件：同 tab 内多个组件

const STORAGE_KEY = 'memeFavorites';
const SYNC_EVENT = 'meme-favorites-changed';

function readEntriesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // 老格式：string[] → 迁移成 {id: now()}（时间不准但有，比丢更好）
    if (Array.isArray(parsed)) {
      const now = Date.now();
      const migrated = {};
      for (const id of parsed) if (typeof id === 'string') migrated[id] = now;
      writeEntriesToStorage(migrated);
      return migrated;
    }
    if (parsed && typeof parsed === 'object') {
      const out = {};
      for (const [id, ts] of Object.entries(parsed)) {
        if (typeof id === 'string' && typeof ts === 'number') out[id] = ts;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

function writeEntriesToStorage(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 配额满 / 隐私模式 —— 静默失败，UI 仍生效（内存状态不丢）
  }
}

export default function useMemeFavorites() {
  const [entries, setEntries] = useState(() => readEntriesFromStorage());

  useEffect(() => {
    const handler = () => setEntries(readEntriesFromStorage());
    window.addEventListener('storage', handler);
    window.addEventListener(SYNC_EVENT, handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(SYNC_EVENT, handler);
    };
  }, []);

  const isFav = useCallback((riffId) => Object.prototype.hasOwnProperty.call(entries, riffId), [entries]);

  const addedAt = useCallback((riffId) => entries[riffId] || null, [entries]);

  const toggle = useCallback((riffId) => {
    setEntries(prev => {
      const next = { ...prev };
      if (Object.prototype.hasOwnProperty.call(next, riffId)) delete next[riffId];
      else next[riffId] = Date.now();
      writeEntriesToStorage(next);
      window.dispatchEvent(new Event(SYNC_EVENT));
      return next;
    });
  }, []);

  // 已收藏的 riff_id 列表，按收藏时间倒序（最新在前）
  const orderedIds = useCallback(() => {
    return Object.entries(entries)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }, [entries]);

  return {
    entries,
    isFav,
    addedAt,
    toggle,
    count: Object.keys(entries).length,
    orderedIds,
  };
}
