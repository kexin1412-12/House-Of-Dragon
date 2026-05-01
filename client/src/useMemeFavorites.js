import { useCallback, useEffect, useState } from 'react';

// 文化梗收藏 —— 纯 localStorage，无后端。
// 跨组件同步：通过 window 上的 storage 事件 + 自定义事件双保险
//   - storage 事件：浏览器内置，跨 tab 同步
//   - meme-favorites-changed：同 tab 内多个组件同步（storage 事件不在自身 tab 触发）

const STORAGE_KEY = 'memeFavorites';
const SYNC_EVENT = 'meme-favorites-changed';

function readFavoritesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function writeFavoritesToStorage(set) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // 配额满 / 隐私模式 —— 静默失败，UI 仍生效（内存状态不丢）
  }
}

export default function useMemeFavorites() {
  const [favorites, setFavorites] = useState(() => readFavoritesFromStorage());

  // 监听同 tab + 跨 tab 的变化，刷新本组件
  useEffect(() => {
    const handler = () => setFavorites(readFavoritesFromStorage());
    window.addEventListener('storage', handler);
    window.addEventListener(SYNC_EVENT, handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(SYNC_EVENT, handler);
    };
  }, []);

  const isFav = useCallback((riffId) => favorites.has(riffId), [favorites]);

  const toggle = useCallback((riffId) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(riffId)) next.delete(riffId);
      else next.add(riffId);
      writeFavoritesToStorage(next);
      // 通知本 tab 内其他组件
      window.dispatchEvent(new Event(SYNC_EVENT));
      return next;
    });
  }, []);

  return { favorites, isFav, toggle, count: favorites.size };
}
