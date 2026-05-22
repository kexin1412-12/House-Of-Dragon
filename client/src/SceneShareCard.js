import React, { useCallback, useEffect, useRef, useState } from 'react';
import './MemeShareCard.css';
import './SceneShareCard.css';

// 片段卡 —— 分享「这段剧情」：场景截图 + 几句台词叠起来（影视截图配字格式）。
// 截图优先抓视频当前像素帧（用一个一次性 crossOrigin 克隆 video，绝不碰主播放器，
// 避免 CORS 拖垮播放）；抓不到（CDN 无 CORS）就回退到同源场景关键帧——永远能导出。
// 台词复用现有数据：对白梗用两句对白，其余用该句台词的英文 + 中文。

const SHOW_TITLE = '龙之家族';
const BRAND = '共谋者';
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, 'Microsoft YaHei', sans-serif";

const W = 540;
const H = 820;
const PAD = 40;
const SCALE = 2;
const IMG_H = Math.round((W - 32) * 9 / 16); // 16:9

function formatMMSS(seconds) {
  const s = Math.floor(seconds || 0);
  const mm = Math.floor(s / 60).toString().padStart(2, '0');
  const ss = (s % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
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

function roundRectTop(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth) {
  const tokens = (text || '').match(/[A-Za-z0-9'’.,!?;:()"-]+|\s+|[^\sA-Za-z0-9]/g) || [];
  const lines = [];
  let line = '';
  for (const tk of tokens) {
    if (/^\s+$/.test(tk)) {
      if (ctx.measureText(line + ' ').width <= maxWidth) line += ' ';
      continue;
    }
    if (!line || ctx.measureText(line + tk).width <= maxWidth) line += tk;
    else { lines.push(line); line = tk; }
  }
  if (line) lines.push(line);
  return lines;
}

function loadImage(src) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });
}

function drawCover(ctx, src, x, y, w, h) {
  const iw = src.videoWidth || src.width;
  const ih = src.videoHeight || src.height;
  if (!iw || !ih) return;
  const ir = iw / ih, rr = w / h;
  let sw, sh, sx, sy;
  if (ir > rr) { sh = ih; sw = sh * rr; sx = (iw - sw) / 2; sy = 0; }
  else { sw = iw; sh = sw / rr; sx = 0; sy = (ih - sh) / 2; }
  ctx.drawImage(src, sx, sy, sw, sh, x, y, w, h);
}

// 抓当前像素帧：一次性 crossOrigin 克隆 video，成功返回 canvas，失败返回 null。主播放器不受影响。
function captureFrame(videoUrl, time) {
  return new Promise(resolve => {
    if (!videoUrl) return resolve(null);
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; try { v.removeAttribute('src'); v.load(); } catch (e) {} resolve(r); } };
    v.addEventListener('error', () => done(null));
    v.addEventListener('loadeddata', () => { try { v.currentTime = Math.max(0, time || 0); } catch (e) { done(null); } });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth || 1280;
        c.height = v.videoHeight || 720;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toDataURL('image/png'); // 触发污染检测：被污染会抛
        done(c);
      } catch (e) { done(null); }
    });
    v.src = videoUrl;
    setTimeout(() => done(null), 7000);
  });
}

// 复用现有台词：对白梗→两句对白；其余→该句英文+中文
function linesOf(riff) {
  const card = riff.card;
  if (card && card.type === 'dialogue' && Array.isArray(card.lines)) {
    return card.lines.map(l => ({ speaker: l.speaker, en: l.text, zh: '' }));
  }
  const a = riff.anchor || {};
  return [{ speaker: '', en: a.subtitle_en || '', zh: a.subtitle_zh || '' }];
}

async function drawCard(canvas, riff, videoUrl, time, live) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  try { await document.fonts.ready; } catch (e) {}

  // 背景
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#16120b');
  g.addColorStop(1, '#0a0806');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 截图：先抓当前帧，失败回退场景关键帧
  let src = null;
  if (live) src = await captureFrame(videoUrl, time);
  if (!src && riff.anchor && riff.anchor.keyframe) src = await loadImage(`/kb/${riff.anchor.keyframe}`);

  const ix = 16, iy = 16, iw = W - 32, ih = IMG_H;
  ctx.save();
  roundRectTop(ctx, ix, iy, iw, ih, 12);
  ctx.clip();
  if (src) drawCover(ctx, src, ix, iy, iw, ih);
  else { ctx.fillStyle = '#1a1510'; ctx.fillRect(ix, iy, iw, ih); }
  const gg = ctx.createLinearGradient(0, iy + ih - 90, 0, iy + ih);
  gg.addColorStop(0, 'rgba(10,8,6,0)');
  gg.addColorStop(1, 'rgba(10,8,6,0.55)');
  ctx.fillStyle = gg;
  ctx.fillRect(ix, iy + ih - 90, iw, 90);
  ctx.restore();

  // 时间戳 pill
  const tlabel = formatMMSS(time);
  ctx.font = `600 14px ${SANS}`;
  const tw = ctx.measureText(tlabel).width;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  roundRect(ctx, ix + 12, iy + ih - 34, tw + 20, 24, 12); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
  ctx.fillText(tlabel, ix + 22, iy + ih - 17);

  // 台词叠放
  let y = iy + ih + 42;
  ctx.textAlign = 'left';
  const maxW = W - PAD * 2;
  for (const ln of linesOf(riff)) {
    if (ln.speaker) {
      ctx.fillStyle = 'rgba(243,201,122,0.7)';
      ctx.font = `600 13px ${SANS}`;
      ctx.fillText(ln.speaker, PAD, y);
      y += 24;
    }
    if (ln.en) {
      ctx.fillStyle = '#f4ead2';
      ctx.font = `italic 500 24px ${SERIF}`;
      for (const t of wrapText(ctx, ln.en, maxW)) { ctx.fillText(t, PAD, y); y += 33; }
    }
    if (ln.zh) {
      y += 2;
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      ctx.font = `400 17px ${SANS}`;
      for (const t of wrapText(ctx, ln.zh, maxW)) { ctx.fillText(t, PAD, y); y += 26; }
    }
    y += 20;
  }

  // 页脚
  ctx.fillStyle = '#8a7f6b';
  ctx.font = `500 15px ${SANS}`;
  ctx.fillText(`《${SHOW_TITLE}》 · ${riff.episode || ''} · ${tlabel}`, PAD, H - PAD);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#f3c97a';
  ctx.fillText(`✦ ${BRAND}`, W - PAD, H - PAD);
  ctx.textAlign = 'left';
}

export default function SceneShareCard({ riff, videoUrl, videoRef, onClose }) {
  const canvasRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [rendering, setRendering] = useState(true);
  // 打开瞬间锁定时间点
  const timeRef = useRef(
    (videoRef && videoRef.current && videoRef.current.currentTime) ||
    (riff.anchor && riff.anchor.start_time) || 0
  );

  useEffect(() => {
    let alive = true;
    setRendering(true);
    drawCard(canvasRef.current, riff, videoUrl, timeRef.current, true)
      .then(() => { if (alive) setRendering(false); });
    return () => { alive = false; };
  }, [riff, videoUrl]);

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
    a.download = `片段·${formatMMSS(timeRef.current)}.png`;
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
    } catch (e) {}
  };

  return (
    <div className="msc-backdrop" onClick={onClose}>
      <div className="msc-dialog ssc-dialog" onClick={e => e.stopPropagation()}>
        <button className="msc-close" onClick={onClose} aria-label="关闭">✕</button>
        <div className="msc-type">片段卡</div>
        <div className={`msc-canvas-wrap${rendering ? ' is-loading' : ''}`}>
          <canvas ref={canvasRef} className="msc-canvas ssc-canvas" />
        </div>
        <div className="msc-hint">截图 + 台词，发朋友圈 / 微博安利这段剧情</div>
        <div className="msc-actions">
          <button className="msc-btn msc-btn-primary" onClick={handleDownload}>下载图片</button>
          <button className="msc-btn" onClick={handleCopy}>{copied ? '已复制 ✓' : '复制图片'}</button>
        </div>
      </div>
    </div>
  );
}
