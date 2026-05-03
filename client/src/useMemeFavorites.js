import { useCallback, useEffect, useState } from 'react';

// 文化梗收藏 —— 纯内存状态（每次刷新页面清零）。
//
// 之前用 localStorage 持久化，但产品决定文化梗收藏只在"本次观影"
// 内有效，F5 即归零。所以退化成模块级变量。
//
// 数据形状：{ [riff_id]: addedAtMs }
//   - 用 map 而不是 Set 是为了能"按收藏时间排序"和显示"最近收藏"
//
// 同 tab 内多组件同步：自定义事件 meme-favorites-changed。
// 跨 tab 不再同步（不同 tab 内存独立，每页刷新即清，跨 tab 一致没意义）。

const SYNC_EVENT = 'meme-favorites-changed';

let _entries = {};

// 一次性清理旧版本遗留在 localStorage 里的文化梗收藏。新模型走纯内存。
try { localStorage.removeItem('memeFavorites'); } catch {}

function readEntries() {
  return { ..._entries };
}

function writeEntries(entries) {
  _entries = entries;
}

export default function useMemeFavorites() {
  const [entries, setEntries] = useState(() => readEntries());

  useEffect(() => {
    const handler = () => setEntries(readEntries());
    window.addEventListener(SYNC_EVENT, handler);
    return () => window.removeEventListener(SYNC_EVENT, handler);
  }, []);

  const isFav = useCallback((riffId) => Object.prototype.hasOwnProperty.call(entries, riffId), [entries]);

  const addedAt = useCallback((riffId) => entries[riffId] || null, [entries]);

  const toggle = useCallback((riffId) => {
    setEntries(prev => {
      const next = { ...prev };
      if (Object.prototype.hasOwnProperty.call(next, riffId)) delete next[riffId];
      else next[riffId] = Date.now();
      writeEntries(next);
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
