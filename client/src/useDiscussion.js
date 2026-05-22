import { useCallback, useEffect, useState } from 'react';

// 整集讨论区状态 —— 纯内存（刷新页面清零），与 useMemeSocial 同一套模式。
// 没有后端：种子评论来自 discussionSeed，这里只存「本次观影」里用户自己的动作：
//   - upvotes[commentId]   = true                点赞过哪些评论
//   - userComments[videoId] = [{ comment_id, author, time, upvotes, text, mine }]

const SYNC_EVENT = 'discussion-changed';

let _upvotes = {};
let _userComments = {};
let _seq = 0;

function snapshot() {
  return { upvotes: { ..._upvotes }, userComments: { ..._userComments } };
}

function emit() {
  window.dispatchEvent(new Event(SYNC_EVENT));
}

export default function useDiscussion() {
  const [state, setState] = useState(() => snapshot());

  useEffect(() => {
    const handler = () => setState(snapshot());
    window.addEventListener(SYNC_EVENT, handler);
    return () => window.removeEventListener(SYNC_EVENT, handler);
  }, []);

  const isUpvoted = useCallback((id) => !!state.upvotes[id], [state]);

  const toggleUpvote = useCallback((id) => {
    if (_upvotes[id]) delete _upvotes[id];
    else _upvotes[id] = true;
    _upvotes = { ..._upvotes };
    emit();
  }, []);

  const userCommentsFor = useCallback(
    (videoId) => state.userComments[videoId] || [],
    [state]
  );

  const addComment = useCallback((videoId, text) => {
    const body = (text || '').trim();
    if (!body) return;
    const comment = {
      comment_id: `local_${videoId}_${++_seq}`,
      author: '你',
      time: '刚刚',
      upvotes: 0,
      text: body,
      mine: true,
    };
    _userComments = {
      ..._userComments,
      [videoId]: [...(_userComments[videoId] || []), comment],
    };
    emit();
  }, []);

  return { isUpvoted, toggleUpvote, userCommentsFor, addComment };
}
