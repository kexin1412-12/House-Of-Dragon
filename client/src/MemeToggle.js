import React, { useEffect } from 'react';

// 共谋模式总开关：一关全关（文化注释 + 符号热点 + 场景热点 …）。
// 旧 storage key 是 memeAnnotationsEnabled，重命名后老用户回到默认值（开），
// 一次性影响可接受。
const STORAGE_KEY = 'conspiratorModeEnabled';

export default function MemeToggle({ enabled, onChange, hidden }) {
  // 只在挂载时从 localStorage 拉一次初值（父组件保管 enabled state）
  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === '0' && enabled !== false) onChange(false);
    if (raw === '1' && enabled !== true) onChange(true);
    // raw === null → 用父组件传进来的默认（true）
  }, []); // eslint-disable-line

  const toggle = () => {
    const next = !enabled;
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    onChange(next);
  };

  if (hidden) return null;

  return (
    <button
      className={`meme-toggle${enabled ? ' is-on' : ' is-off'}`}
      onClick={toggle}
      title={enabled ? '关闭共谋模式（隐藏所有文化注释与热点）' : '开启共谋模式（显示文化注释与热点）'}
    >
      <span className="meme-toggle-spark">✦</span>
      <span className="meme-toggle-label">共谋模式</span>
    </button>
  );
}
