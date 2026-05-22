import { useCallback, useEffect, useState } from 'react';

// 文化梗社交层状态 —— 纯内存（每次刷新页面清零），跟 useMemeFavorites 同一套模式。
//
// 本产品没有社交后端：种子反应数 / 种子网友补充都来自 KB，下面这些只是
// 「本次观影」里用户自己的动作叠加层：
//   - reactions[riffId]   = 'til' | 'knew'        用户对某条梗选了哪一侧
//   - upvotes[noteId]     = true                  用户点赞过哪些补充
//   - userNotes[riffId]   = [{ note_id, author, time, upvotes, text, mine }]
//
// 同 tab 内多组件同步：自定义事件 meme-social-changed。
// 跨 tab 不同步（内存独立，刷新即清，跨 tab 一致没意义）。

const SYNC_EVENT = 'meme-social-changed';

let _reactions = {};   // riffId -> 'til' | 'knew'
let _upvotes = {};     // noteId -> true
let _userNotes = {};   // riffId -> note[]
let _seq = 0;          // 给本地新增 note 生成稳定 id

function snapshot() {
  return { reactions: { ..._reactions }, upvotes: { ..._upvotes }, userNotes: { ..._userNotes } };
}

function emit() {
  window.dispatchEvent(new Event(SYNC_EVENT));
}

export default function useMemeSocial() {
  const [state, setState] = useState(() => snapshot());

  useEffect(() => {
    const handler = () => setState(snapshot());
    window.addEventListener(SYNC_EVENT, handler);
    return () => window.removeEventListener(SYNC_EVENT, handler);
  }, []);

  // ── 反应键：涨知识了 / 早就知道（互斥，再点同一侧取消）──
  const reactionOf = useCallback((riffId) => state.reactions[riffId] || null, [state]);

  const setReaction = useCallback((riffId, side) => {
    if (_reactions[riffId] === side) delete _reactions[riffId];
    else _reactions[riffId] = side;
    _reactions = { ..._reactions };
    emit();
  }, []);

  // ── 网友补充点赞（本地 toggle）──
  const isUpvoted = useCallback((noteId) => !!state.upvotes[noteId], [state]);

  const toggleUpvote = useCallback((noteId) => {
    if (_upvotes[noteId]) delete _upvotes[noteId];
    else _upvotes[noteId] = true;
    _upvotes = { ..._upvotes };
    emit();
  }, []);

  // ── add your note（本地追加，置于列表底部）──
  const userNotesFor = useCallback((riffId) => state.userNotes[riffId] || [], [state]);

  const addNote = useCallback((riffId, text) => {
    const body = (text || '').trim();
    if (!body) return;
    const note = {
      note_id: `local_${riffId}_${++_seq}`,
      author: '你',
      time: '刚刚',
      upvotes: 0,
      text: body,
      mine: true,
    };
    _userNotes = { ..._userNotes, [riffId]: [...(_userNotes[riffId] || []), note] };
    emit();
  }, []);

  return { reactionOf, setReaction, isUpvoted, toggleUpvote, userNotesFor, addNote };
}
