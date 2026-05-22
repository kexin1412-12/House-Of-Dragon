import React, { useCallback, useEffect, useRef, useState } from 'react';
import './MemeShareCard.css';

// 分享卡 —— 每条梗按内容固定一种最合适的模板，纯前端 Canvas 画，零依赖、@2x 高清：
//   quote    台词卡   —— 纯排版力：大 serif 金字 + 角色名 + 剧名 + 收藏数（社交货币）
//   moment   名场面卡 —— 情绪容器：场景帧(▶) + 一句话 + 情绪分布 + “Nk 在此暂停”
//   dialogue 对白卡   —— 剧本感：左右分色气泡 + 不剧透的悬念钩子

const SHOW_TITLE = '龙之家族';
const BRAND = '共谋者';
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, 'Microsoft YaHei', sans-serif";

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

function formatCount(n) {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 10 ? Math.round(k) : Number(k.toFixed(1))) + 'k';
  }
  return String(n);
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

function loadImage(src) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });
}

function drawCover(ctx, img, x, y, w, h) {
  const ir = img.width / img.height;
  const rr = w / h;
  let sw, sh, sx, sy;
  if (ir > rr) { sh = img.height; sw = sh * rr; sx = (img.width - sw) / 2; sy = 0; }
  else { sw = img.width; sh = sw / rr; sx = 0; sy = (img.height - sh) / 2; }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function footerBrand(ctx) {
  ctx.textAlign = 'right';
  ctx.fillStyle = '#f3c97a';
  ctx.font = `500 15px ${SANS}`;
  ctx.fillText(`✦ ${BRAND}`, W - PAD, H - PAD);
  ctx.textAlign = 'left';
}

// ── 台词卡 ──
function drawQuote(ctx, riff, card) {
  const a = riff.anchor || {};
  const cx = W / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // 顶部小记号
  ctx.fillStyle = 'rgba(243,201,122,0.8)';
  ctx.font = `600 18px ${SANS}`;
  ctx.fillText('✦', cx, PAD + 36);

  // 台词主体：大 serif 金字，垂直居中，大量黑留白
  ctx.font = `italic 600 40px ${SERIF}`;
  const maxW = W - PAD * 2 - 16;
  const lines = wrapText(ctx, a.subtitle_en || '', maxW);
  const lh = 54;
  let y = H / 2 - (lines.length * lh) / 2 - 10;
  ctx.fillStyle = '#f3c97a';
  for (const ln of lines) { ctx.fillText(ln, cx, y); y += lh; }

  // 角色名
  y += 24;
  ctx.fillStyle = 'rgba(240,230,210,0.85)';
  ctx.font = `500 22px ${SANS}`;
  ctx.fillText(`— ${card.speaker_zh || card.speaker_en || ''}`, cx, y);

  // 剧名
  y += 30;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = `400 15px ${SANS}`;
  ctx.fillText(`《${SHOW_TITLE}》 · ${riff.episode || ''}`, cx, y);

  // 底部收藏数 —— 社交货币
  ctx.fillStyle = 'rgba(243,201,122,0.78)';
  ctx.font = `500 17px ${SANS}`;
  ctx.fillText(`♥ ${formatCount(card.collects || 0)}`, cx, H - PAD - 24);
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.font = `500 13px ${SANS}`;
  ctx.fillText(`✦ ${BRAND}`, cx, H - PAD);
  ctx.textAlign = 'left';
}

// ── 名场面卡 ──
async function drawMoment(ctx, riff, card) {
  const a = riff.anchor || {};
  const ix = 16, iy = 16, iw = W - 32, ih = 300;

  // 场景帧（cover-fit，圆角顶）
  const img = a.keyframe ? await loadImage(`/kb/${a.keyframe}`) : null;
  ctx.save();
  roundRectTop(ctx, ix, iy, iw, ih, 13);
  ctx.clip();
  if (img) drawCover(ctx, img, ix, iy, iw, ih);
  else { ctx.fillStyle = '#1a1510'; ctx.fillRect(ix, iy, iw, ih); }
  const gg = ctx.createLinearGradient(0, iy + ih - 130, 0, iy + ih);
  gg.addColorStop(0, 'rgba(10,8,6,0)');
  gg.addColorStop(1, 'rgba(10,8,6,0.9)');
  ctx.fillStyle = gg;
  ctx.fillRect(ix, iy + ih - 130, iw, 130);
  ctx.restore();

  // ▶ 播放暗示
  const pcx = W / 2, pcy = iy + ih / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.beginPath(); ctx.arc(pcx, pcy, 34, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.beginPath();
  ctx.moveTo(pcx - 9, pcy - 13); ctx.lineTo(pcx - 9, pcy + 13); ctx.lineTo(pcx + 15, pcy);
  ctx.closePath(); ctx.fill();

  // 时间戳 pill
  const time = a.start_time != null ? formatMMSS(a.start_time) : '';
  if (time) {
    ctx.font = `600 14px ${SANS}`;
    const tw = ctx.measureText(time).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(ctx, ix + 12, iy + ih - 36, tw + 20, 24, 12); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText(time, ix + 22, iy + ih - 19);
  }

  // 一句话描述
  let y = iy + ih + 38;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f0e6d2';
  ctx.font = `500 20px ${SANS}`;
  for (const ln of wrapText(ctx, card.caption || '', W - PAD * 2)) { ctx.fillText(ln, PAD, y); y += 30; }

  // 情绪分布 chips
  y += 16;
  ctx.font = `500 14px ${SANS}`;
  let x = PAD;
  for (const e of (card.emotions || [])) {
    const label = `${e.label} ${formatCount(e.count)}`;
    const w = ctx.measureText(label).width + 22;
    if (x + w > W - PAD) { x = PAD; y += 36; }
    ctx.fillStyle = 'rgba(243,201,122,0.1)';
    roundRect(ctx, x, y - 18, w, 27, 13); ctx.fill();
    ctx.fillStyle = 'rgba(243,201,122,0.92)';
    ctx.fillText(label, x + 11, y);
    x += w + 8;
  }

  // 钩子：Nk 在此暂停
  if (card.paused) {
    y += 48;
    ctx.fillStyle = '#f3c97a';
    ctx.font = `600 18px ${SANS}`;
    ctx.fillText(`◉ ${card.paused}`, PAD, y);
  }

  footerBrand(ctx);
}

// ── 对白卡 ──
function drawDialogue(ctx, riff, card) {
  ctx.textBaseline = 'alphabetic';

  // 眉标
  ctx.textAlign = 'left';
  ctx.fillStyle = '#f3c97a';
  ctx.font = `600 17px ${SANS}`;
  ctx.fillText('✦  对白', PAD, PAD + 28);

  let y = PAD + 70;
  const maxBubbleW = 366;

  for (const line of (card.lines || [])) {
    const left = line.who === 'a';
    ctx.font = `400 19px ${SANS}`;
    const txtLines = wrapText(ctx, line.text, maxBubbleW - 28);
    const lh = 27;
    const bh = txtLines.length * lh + 22;
    const bw = Math.min(maxBubbleW, Math.max(...txtLines.map(l => ctx.measureText(l).width)) + 28);
    const x = left ? PAD : W - PAD - bw;

    // 角色名
    ctx.textAlign = left ? 'left' : 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = `500 13px ${SANS}`;
    ctx.fillText(line.speaker || '', left ? PAD + 2 : W - PAD - 2, y);
    y += 20;

    // 气泡
    ctx.fillStyle = left ? 'rgba(124,107,212,0.20)' : 'rgba(243,201,122,0.16)';
    roundRect(ctx, x, y, bw, bh, 12); ctx.fill();

    // 文字
    ctx.textAlign = 'left';
    ctx.fillStyle = left ? '#d9d2f0' : '#f3e6c8';
    ctx.font = `400 19px ${SANS}`;
    let ty = y + 28;
    for (const ln of txtLines) { ctx.fillText(ln, x + 14, ty); ty += lh; }
    y += bh + 26;
  }

  // 悬念钩子
  if (card.teaser) {
    const cx = W / 2;
    let ty = Math.max(y + 24, H - 168);
    // 细分隔线
    ctx.strokeStyle = 'rgba(243,201,122,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx - 22, ty - 24); ctx.lineTo(cx + 22, ty - 24); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `italic 400 18px ${SERIF}`;
    for (const ln of wrapText(ctx, card.teaser, W - PAD * 2)) { ctx.fillText(ln, cx, ty); ty += 27; }
    ctx.textAlign = 'left';
  }

  // 页脚
  ctx.fillStyle = '#8a7f6b';
  ctx.font = `500 15px ${SANS}`;
  ctx.fillText(`《${SHOW_TITLE}》 · ${riff.episode || ''}`, PAD, H - PAD);
  footerBrand(ctx);
}

async function drawCard(canvas, riff) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
  try { await document.fonts.ready; } catch (e) { /* 系统字体兜底 */ }

  // 背景
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#16120b');
  g.addColorStop(1, '#0a0806');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const card = riff.card || { type: 'quote' };
  if (card.type === 'moment') await drawMoment(ctx, riff, card);
  else if (card.type === 'dialogue') drawDialogue(ctx, riff, card);
  else drawQuote(ctx, riff, card);

  // 内描金边框（最后画，框住整张）
  ctx.strokeStyle = 'rgba(243,201,122,0.28)';
  ctx.lineWidth = 1;
  roundRect(ctx, 16, 16, W - 32, H - 32, 14);
  ctx.stroke();
}

const CARD_LABEL = { quote: '台词卡', moment: '名场面卡', dialogue: '对白卡' };

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

  const label = CARD_LABEL[(riff.card && riff.card.type)] || '台词卡';

  return (
    <div className="msc-backdrop" onClick={onClose}>
      <div className="msc-dialog" onClick={e => e.stopPropagation()}>
        <button className="msc-close" onClick={onClose} aria-label="关闭">✕</button>
        <div className="msc-type">{label}</div>
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
