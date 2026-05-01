import React, { useEffect } from 'react';

const STORAGE_KEY = 'memeAnnotationsEnabled';

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
      title={enabled ? '点击关闭文化注释' : '点击开启文化注释'}
    >
      <span className="meme-toggle-spark">✦</span>
      <span className="meme-toggle-label">文化注释</span>
    </button>
  );
}
