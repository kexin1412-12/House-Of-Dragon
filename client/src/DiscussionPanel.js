import React, { useEffect, useRef, useState } from 'react';
import './DiscussionPanel.css';
import useDiscussion from './useDiscussion';
import DISCUSSION_SEED from './discussionSeed';

// 整集讨论区 —— 右栏第三个 tab。沿用 viewer notes 的卡片语言：
// 头像 / 昵称 / 时间 / 正文（折叠展开）/ 点赞，按热度排序，可本地追加。
// 纯前端、无后端：种子来自 discussionSeed，用户动作走 useDiscussion 内存态。

function formatCount(n) {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 10 ? Math.round(k) : Number(k.toFixed(1))) + 'k';
  }
  return String(n);
}

function initialOf(author) {
  const c = (author || '?').trim().charAt(0) || '?';
  return /[a-z]/i.test(c) ? c.toUpperCase() : c;
}

const AVATAR_COLORS = ['#7c6bd4', '#3f9e7a', '#c78a3c', '#5a86c2', '#b06a8f'];
function avatarColor(author) {
  let h = 0;
  const s = author || '';
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// 正文默认 clamp 到约 3 行，溢出才出现展开/收起
function CommentText({ text }) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text]);

  return (
    <>
      <div ref={ref} className={`dp-text${expanded ? ' is-expanded' : ''}`}>{text}</div>
      {overflowing && (
        <button className="dp-more" onClick={() => setExpanded(e => !e)}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </>
  );
}

export default function DiscussionPanel({ videoId }) {
  const { isUpvoted, toggleUpvote, userCommentsFor, addComment } = useDiscussion();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');

  const seed = (videoId && DISCUSSION_SEED[videoId]) || [];

  // 投票排序取代时间排序——高赞自然浮顶（含本地点赞 +1 与我新增的）
  const comments = [...seed, ...userCommentsFor(videoId)]
    .map(c => ({ ...c, _up: (c.upvotes || 0) + (isUpvoted(c.comment_id) ? 1 : 0) }))
    .sort((a, b) => b._up - a._up);

  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    addComment(videoId, body);
    setDraft('');
    setComposing(false);
  };

  return (
    <div className="dp-root">
      <div className="dp-header">
        本集 · 讨论 <strong>{comments.length}</strong>
        <span className="dp-sort">按热度排序</span>
      </div>

      {comments.length === 0 ? (
        <div className="dp-empty">还没有讨论，来写第一条。</div>
      ) : (
        <div className="dp-list">
          {comments.map(c => (
            <div key={c.comment_id} className={`dp-item${c.mine ? ' is-mine' : ''}`}>
              <span
                className="dp-avatar"
                style={{ background: c.mine ? '#e0b160' : avatarColor(c.author) }}
              >
                {initialOf(c.author)}
              </span>
              <div className="dp-body">
                <div className="dp-meta">
                  <span className="dp-author">{c.author}</span>
                  <span className="dp-time">· {c.time}</span>
                </div>
                <CommentText text={c.text} />
                <button
                  className={`dp-up${isUpvoted(c.comment_id) ? ' is-on' : ''}`}
                  onClick={() => toggleUpvote(c.comment_id)}
                  title="赞同这条"
                >
                  <span className="dp-up-ic" aria-hidden="true">▲</span>
                  {formatCount(c._up)}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {composing ? (
        <div className="dp-compose">
          <textarea
            className="dp-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="聊聊这一集——剧情、理论、吐槽都行…"
            rows={3}
            autoFocus
          />
          <div className="dp-compose-actions">
            <button
              className="dp-cancel"
              onClick={() => { setComposing(false); setDraft(''); }}
            >取消</button>
            <button className="dp-submit" onClick={submit} disabled={!draft.trim()}>发布</button>
          </div>
        </div>
      ) : (
        <button className="dp-add" onClick={() => setComposing(true)}>
          <span aria-hidden="true">+</span> 写条讨论
        </button>
      )}
    </div>
  );
}
