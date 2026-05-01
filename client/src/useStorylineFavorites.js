import { useCallback, useEffect, useState } from 'react';

// 叙事节点收藏 —— 跟 useMemeFavorites 同套路（localStorage 直存，无后端），
// 但单独走一个 storage key，避免和文化梗收藏混淆。
//
// 数据形状：{ [node_key]: { addedAt: ms, payload: {...} } }
//   - node_key 用 `${videoId}::${nodeId}` 防跨视频同名碰撞
//   - payload 存渲染卡片所需的最小数据，避免 FavoritesView 还得回拉 storyline JSON
//
// 跨组件 / 跨 tab 同步：和 meme 一样靠 storage 事件 + 自定义事件。

const STORAGE_KEY = 'storylineFavorites';
const SYNC_EVENT = 'storyline-favorites-changed';

function readEntriesFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
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
    // 配额满 / 隐私模式 —— 静默失败
  }
}

function nodeKeyFor(videoId, nodeId) {
  return `${videoId}::${nodeId}`;
}

export default function useStorylineFavorites() {
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

  const isFav = useCallback(
    (videoId, nodeId) => Object.prototype.hasOwnProperty.call(entries, nodeKeyFor(videoId, nodeId)),
    [entries]
  );

  const toggle = useCallback((payload) => {
    if (!payload?.videoId || !payload?.nodeId) return;
    const key = nodeKeyFor(payload.videoId, payload.nodeId);
    setEntries(prev => {
      const next = { ...prev };
      if (Object.prototype.hasOwnProperty.call(next, key)) {
        delete next[key];
      } else {
        next[key] = { addedAt: Date.now(), payload };
      }
      writeEntriesToStorage(next);
      window.dispatchEvent(new Event(SYNC_EVENT));
      return next;
    });
  }, []);

  // 已收藏的列表，按收藏时间倒序（最新在前）
  const orderedList = useCallback(() => {
    return Object.entries(entries)
      .map(([key, v]) => ({ key, addedAt: v.addedAt, payload: v.payload }))
      .sort((a, b) => b.addedAt - a.addedAt);
  }, [entries]);

  return {
    entries,
    isFav,
    toggle,
    count: Object.keys(entries).length,
    orderedList,
  };
}
