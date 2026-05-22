import React, { useCallback, useEffect, useRef, useState } from 'react';
import './MemeShareCard.css';

// 分享卡 —— 把一条文化梗渲染成一张「精装书签」式的图片，纯前端 Canvas 画，
// 零依赖、@2x 高清。用户存图发朋友圈 / 小红书：传播的是"我发现了个有趣的知识"，
// 不是一条没人点的链接。

const SHOW_TITLE = '龙之家族';
const BRAND = '共谋者';

// 卡片逻辑尺寸（@2x 输出），3:4 偏竖，适配小红书 / 朋友圈
const W = 540;
const H = 760;
const PAD = 46;
const SCALE = 2;

function formatMMSS(seconds) {
  const s = Math.floor(seconds || 0);
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

// 一句话解释：取第一句、限长，别让书签变成说明书
function firstSentence(s, max = 48) {
  if (!s) return '';
  const cut = (s.split(/[。！？\n]/)[0] || s).trim();
  return cut.length > max ? cut.slice(0, max) + '…' : cut;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 混排换行：英文按词、中文按字断行
function wrapText(ctx, text, maxWidth) {
  const tokens = (text || '').match(/[A-Za-z0-9'’.,!?;:()"-]+|\s+|[^\sA-Za-z0-9]/g) || [];
  const lines = [];
  let line = '';
  for (const tk of tokens) {
    if (/^\s+$/.test(tk)) {
      if (ctx.measureText(line + ' ').width <= maxWidth) line += ' ';
      continue;
    }
    if (!line || ctx.measureText(line + tk).width <= maxWidth) {
      line += tk;
    } else {
      lines.push(line);
      line = tk;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function drawCard(canvas, riff) {
  if (!canvas) return;
  const a = riff.anchor || {};
  const ctx = canvas.getContext('2d');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  try { await document.fonts.ready; } catch (e) { /* 系统字体兜底 */ }

  // 背景：暗金渐变
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#16120b');
  g.addColorStop(1, '#0a0806');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 内描金边框
  ctx.strokeStyle = 'rgba(243,201,122,0.28)';
  ctx.lineWidth = 1;
  roundRect(ctx, 16, 16, W - 32, H - 32, 14);
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';
  const maxW = W - PAD * 2;
  let y = PAD + 20;

  // 眉标 + tags
  ctx.fillStyle = '#f3c97a';
  ctx.font = "600 17px -apple-system, 'Microsoft YaHei', sans-serif";
  ctx.fillText('✦  文化梗', PAD, y);
  if (Array.isArray(riff.tags) && riff.tags.length) {
    const tagStr = riff.tags.slice(0, 2).join('  ·  ');
    ctx.font = "500 14px 'Microsoft YaHei', sans-serif";
    ctx.fillStyle = 'rgba(243,201,122,0.6)';
    ctx.fillText(tagStr, W - PAD - ctx.measureText(tagStr).width, y);
  }
  y += 38;

  // 装饰引号
  ctx.fillStyle = 'rgba(243,201,122,0.16)';
  ctx.font = '700 110px Georgia, serif';
  ctx.fillText('“', PAD - 6, y + 62);
  y += 46;

  // 英文台词（主角）
  ctx.fillStyle = '#f4ead2';
  ctx.font = "italic 600 37px Georgia, 'Times New Roman', serif";
  for (const ln of wrapText(ctx, a.subtitle_en || '', maxW)) {
    ctx.fillText(ln, PAD, y);
    y += 50;
  }
  y += 10;

  // 中文翻译
  if (a.subtitle_zh) {
    ctx.fillStyle = '#bcb09a';
    ctx.font = "400 22px 'Microsoft YaHei', sans-serif";
    for (const ln of wrapText(ctx, a.subtitle_zh, maxW)) {
      ctx.fillText(ln, PAD, y);
      y += 34;
    }
  }
  y += 20;

  // 金色分隔线
  ctx.strokeStyle = 'rgba(243,201,122,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(PAD + 54, y);
  ctx.stroke();
  y += 32;

  // 一句话解释
  ctx.fillStyle = '#a99e8a';
  ctx.font = "400 19px 'Microsoft YaHei', sans-serif";
  for (const ln of wrapText(ctx, firstSentence(riff.tier2_punch), maxW)) {
    ctx.fillText(ln, PAD, y);
    y += 29;
  }

  // 页脚：剧名 · 集 · 时间戳 / 品牌
  const fy = H - PAD - 2;
  ctx.fillStyle = '#8a7f6b';
  ctx.font = "500 16px 'Microsoft YaHei', sans-serif";
  const ep = riff.episode ? `${riff.episode} · ` : '';
  const time = a.start_time != null ? formatMMSS(a.start_time) : '';
  ctx.fillText(`《${SHOW_TITLE}》 · ${ep}${time}`, PAD, fy);
  ctx.fillStyle = '#f3c97a';
  const brand = `✦ ${BRAND}`;
  ctx.fillText(brand, W - PAD - ctx.measureText(brand).width, fy);
}

export default function MemeShareCard({ riff, onClose }) {
  const canvasRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    let alive = true;
    setRendering(true);
    drawCard(canvasRef.current, riff).then(() => { if (alive) setRendering(false); });
    return () => { alive = false; };
  }, [riff]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const getBlob = useCallback(
    () => new Promise(res => {
      const c = canvasRef.current;
      if (!c) return res(null);
      c.toBlob(b => res(b), 'image/png');
    }),
    []
  );

  const handleDownload = async () => {
    const blob = await getBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `文化梗·${(riff.anchor && riff.anchor.highlight) || 'card'}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleCopy = async () => {
    try {
      const blob = await getBlob();
      if (blob && navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch (e) { /* 某些浏览器不支持图片剪贴板，静默忽略 */ }
  };

  return (
    <div className="msc-backdrop" onClick={onClose}>
      <div className="msc-dialog" onClick={e => e.stopPropagation()}>
        <button className="msc-close" onClick={onClose} aria-label="关闭">✕</button>
        <div className={`msc-canvas-wrap${rendering ? ' is-loading' : ''}`}>
          <canvas ref={canvasRef} className="msc-canvas" />
        </div>
        <div className="msc-hint">存图发朋友圈 / 小红书 —— 你发现的有趣知识</div>
        <div className="msc-actions">
          <button className="msc-btn msc-btn-primary" onClick={handleDownload}>下载图片</button>
          <button className="msc-btn" onClick={handleCopy}>{copied ? '已复制 ✓' : '复制图片'}</button>
        </div>
      </div>
    </div>
  );
}
