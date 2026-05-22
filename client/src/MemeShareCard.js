import React, { useCallback, useEffect, useRef, useState } from 'react';
import './MemeShareCard.css';

// 分享卡 —— 每条梗按内容固定一种最合适的模板，纯前端 Canvas 画，零依赖、@2x 高清：
//   quote    台词卡   —— 上图下文·杂志感：场景剧照(细金框) + 大 serif 台词 + 角色名 + 收藏数
//   moment   名场面卡 —— 情绪容器：场景帧(▶) + 一句话 + 情绪分布 + “Nk 在此暂停”

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

// 暗角：聚焦中部、压暗四角，给整张卡加景深
function quoteVignette(ctx) {
  const r = ctx.createRadialGradient(W / 2, H * 0.42, H * 0.24, W / 2, H * 0.5, H * 0.72);
  r.addColorStop(0, 'rgba(0,0,0,0)');
  r.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);
}

// 极淡胶片颗粒，去掉纯色平面的廉价感
function quoteGrain(ctx) {
  ctx.save();
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = `rgba(255,245,225,${Math.random() * 0.022})`;
    ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }
  ctx.restore();
}

// ── 台词卡 —— 上图下文·杂志感 ──
async function drawQuote(ctx, riff, card) {
  const a = riff.anchor || {};

  // —— 上半：场景剧照（16:9，细金框，底部压暗放时间戳） ——
  const ix = 16, iy = 16, iw = W - 32, ih = Math.round(iw * 9 / 16);
  const img = a.keyframe ? await loadImage(`/kb/${a.keyframe}`) : null;
  ctx.save();
  roundRect(ctx, ix, iy, iw, ih, 11);
  ctx.clip();
  if (img) {
    drawCover(ctx, img, ix, iy, iw, ih);
  } else {
    const pg = ctx.createLinearGradient(ix, iy, ix, iy + ih);
    pg.addColorStop(0, '#241c12'); pg.addColorStop(1, '#15100a');
    ctx.fillStyle = pg; ctx.fillRect(ix, iy, iw, ih);
    ctx.fillStyle = 'rgba(243,201,122,0.18)';
    ctx.font = `600 64px ${SERIF}`; ctx.textAlign = 'center';
    ctx.fillText('✦', W / 2, iy + ih / 2 + 22);
    ctx.textAlign = 'left';
  }
  const sg = ctx.createLinearGradient(0, iy + ih - 72, 0, iy + ih);
  sg.addColorStop(0, 'rgba(10,8,6,0)');
  sg.addColorStop(1, 'rgba(10,8,6,0.62)');
  ctx.fillStyle = sg; ctx.fillRect(ix, iy + ih - 72, iw, 72);
  ctx.restore();

  // 时间戳 pill
  const time = a.start_time != null ? formatMMSS(a.start_time) : '';
  if (time) {
    ctx.font = `600 13px ${SANS}`;
    const tw = ctx.measureText(time).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, ix + 12, iy + ih - 32, tw + 18, 22, 11); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.textAlign = 'left';
    ctx.fillText(time, ix + 21, iy + ih - 16);
  }

  // 细金框
  ctx.strokeStyle = 'rgba(243,201,122,0.45)';
  ctx.lineWidth = 1;
  roundRect(ctx, ix + 0.5, iy + 0.5, iw - 1, ih - 1, 11);
  ctx.stroke();

  // 暗角（文字之前画，保证台词不被压暗）
  quoteVignette(ctx);

  const imgBottom = iy + ih;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // —— 装饰引号 ——
  ctx.fillStyle = 'rgba(243,201,122,0.30)';
  ctx.font = `italic 700 92px ${SERIF}`;
  ctx.fillText('“', PAD - 4, imgBottom + 66);

  // —— 台词主体：大 serif 暖白，左对齐；行多则自动缩一档 ——
  const maxW = W - PAD * 2;
  let qsize = 31, qlh = 42;
  ctx.font = `italic 600 ${qsize}px ${SERIF}`;
  let lines = wrapText(ctx, a.subtitle_en || '', maxW);
  if (lines.length >= 5) {
    qsize = 27; qlh = 37;
    ctx.font = `italic 600 ${qsize}px ${SERIF}`;
    lines = wrapText(ctx, a.subtitle_en || '', maxW);
  }
  let y = imgBottom + 104;
  ctx.fillStyle = '#f4ead2';
  for (const ln of lines) { ctx.fillText(ln, PAD, y); y += qlh; }
  y = y - qlh + 30;

  // —— 短金线分隔 ——
  ctx.strokeStyle = 'rgba(243,201,122,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(PAD + 46, y); ctx.stroke();

  // —— 角色名（字距拉开，杂志署名感） ——
  y += 34;
  ctx.fillStyle = 'rgba(243,228,200,0.95)';
  ctx.font = `600 19px ${SANS}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
  ctx.fillText(card.speaker_zh || card.speaker_en || '', PAD, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

  // —— 剧名 · 集 ——
  y += 26;
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.font = `400 14px ${SANS}`;
  ctx.fillText(`《${SHOW_TITLE}》 · ${riff.episode || ''}`, PAD, y);

  // —— 页脚：收藏数（社交货币）+ 品牌 ——
  ctx.fillStyle = 'rgba(243,201,122,0.85)';
  ctx.font = `600 16px ${SANS}`;
  ctx.fillText(`♥ ${formatCount(card.collects || 0)}`, PAD, H - PAD);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(243,201,122,0.7)';
  ctx.font = `500 15px ${SANS}`;
  ctx.fillText(`✦ ${BRAND}`, W - PAD, H - PAD);
  ctx.textAlign = 'left';

  // —— 胶片颗粒（最后铺，极淡） ——
  quoteGrain(ctx);
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
  else await drawQuote(ctx, riff, card);

  // 内描金边框（最后画，框住整张）
  ctx.strokeStyle = 'rgba(243,201,122,0.28)';
  ctx.lineWidth = 1;
  roundRect(ctx, 16, 16, W - 32, H - 32, 14);
  ctx.stroke();
}

const CARD_LABEL = { quote: '台词卡', moment: '名场面卡' };

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
