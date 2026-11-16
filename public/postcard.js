/* ============================================================
 * 旅行明信片模块 v3
 * 参考版式：上半原片满幅 + 手撕纸边 + 打字机标题 + 蓝色邮戳
 *          + 丝网印（riso）插画 + 底部「地点 • PLACE / 日期 • DATE」
 * 原则：原片程序绘制不重绘；AI 只出插画；文字/邮戳/排版全由 canvas 完成
 * ============================================================ */
(() => {
  'use strict';

  /* ---------------- 版式常量 ---------------- */
  const W = 1536;
  const H = 2048;

  const PHOTO_H = 940;              // 上半原片区
  const TEAR = 940;                 // 撕纸边位置
  const TITLE_X = 210;
  const TITLE_Y = 1054;
  const IW = 1130;                  // 插画宽（3:2）
  const IH = 753;
  const IX = (W - IW) / 2;
  const IY = 1130;
  const BOTTOM_Y = 1952;
  const PM_CX = 1268;
  const PM_CY = 1030;
  const PM_R = 118;

  const PAPER = '#F2EBD6';
  const PAPER_HI = '#FBF7E9';
  const INK = '#3A342C';
  const MUTED = '#6E6455';
  const PMBLUE = '#40558A';

  /* ---------------- 风格 ---------------- */
  const STYLES = [
    {
      id: 'riso',
      name: '复古丝印',
      desc: '网上案例同款',
      paper: '#F2EBD6',
      prompt: `Convert this photograph into a vintage risograph screen-print travel illustration: flat posterised colour blocks, limited three-ink palette of dusty slate blue, warm cream and terracotta red with a deep ink accent, visible ink grain, tiny speckles and slight misregistration, rough printed edges, simplified bold shapes, no soft gradients, editorial poster feel. Keep exactly the same scene: the same main subject, the same landmark (bridge, church, building, mountain), the same boats, trees and city skyline, the same spatial arrangement and perspective, so anyone who knows this place recognises it instantly. Composition: wide landscape, main subject centred with a little headroom, horizon roughly in the middle. Strictly NO text, NO letters, NO numbers, NO logo, NO watermark, NO signature, NO border, NO frame, NO stamp, NO postmark, NO paper mock-up, NO mock-up shadow - pure printed illustration only.`
    },
    {
      id: 'watercolor',
      name: '日系水彩',
      desc: '温柔治愈',
      paper: '#F5EFDF',
      prompt: `Convert this photograph into a hand-painted Japanese travel postcard illustration: soft transparent watercolour on textured cotton paper, gentle ink accents, clear pigment with visible brush edges. Keep exactly the same scene: the same main subject, the same people with identical faces, pose and clothing, the same landmark buildings, coastline, boats and trees, the same spatial arrangement, instantly recognisable. Muted palette of 3 to 4 colours: cream white, misty blue, sage green, warm sand. Keep the photograph's own colour mood and lighting: a warm sunset must stay warm and luminous, never faded or desaturated. Wide landscape composition matching the original framing. Strictly NO text, NO letters, NO numbers, NO logo, NO watermark, NO signature, NO border, NO frame, NO stamp, NO postmark, NO paper mock-up - illustration only.`
    },
    {
      id: 'minimal',
      name: '极简线稿',
      desc: '留白干净',
      paper: '#FAF6EA',
      prompt: `Convert this photograph into a minimal hand-drawn travel illustration: fine ink line work with flat light colour washes, generous clean space, modern independent travel magazine feel. Keep exactly the same scene: the same main subject, the same landmark buildings and landscape elements, the same spatial arrangement, instantly recognisable. Restrained palette of 2 to 3 colours: off-white, warm grey, one soft accent such as slate blue, but keep readable contrast and a clear focal point. Wide landscape composition matching the original framing. Strictly NO text, NO letters, NO numbers, NO logo, NO watermark, NO signature, NO border, NO frame, NO stamp, NO paper mock-up - illustration only.`
    }
  ];

  const state = {
    file: null,
    photo: null,
    illo: null,
    styleId: 'riso',
    busy: false,
    fullCanvas: null,
    cardCanvas: null
  };

  const $ = (id) => document.getElementById(id);

  /* ---------------- 工具 ---------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function spaced(ctx, text, x, y, sp) {
    let cx = x;
    for (const ch of text) {
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + sp;
    }
  }

  function typeFont(size, weight) {
    return `${weight || 400} ${size}px "American Typewriter", "Courier New", "Noto Serif", Georgia, monospace`;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('load failed'));
      im.src = src;
    });
  }

  function err(msg) {
    const el = $('pcError');
    if (msg) { el.textContent = msg; el.style.display = 'block'; }
    else { el.style.display = 'none'; }
  }
  function status(msg) { $('pcStatus').textContent = msg || ''; }

  /* ---------------- 撕纸边轮廓（固定随机，保证两次导出一致） ---------------- */
  function tearPoints() {
    const rnd = mulberry32(20260311);
    const N = 190;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const x = (W / N) * i;
      const y = TEAR
        + Math.sin(i * 1.31) * 5.5
        + Math.sin(i * 0.29 + 1.2) * 12
        + Math.sin(i * 3.7 + 0.4) * 2.2
        + (rnd() - 0.5) * 5;
      pts.push([x, y]);
    }
    return pts;
  }

  /* ---------------- 粗边插画：把矩形图刷成“印上去”的墨块 ---------------- */
  function roughIllo(img, w, h) {
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const c = off.getContext('2d');
    c.drawImage(img, 0, 0, w, h);

    c.globalCompositeOperation = 'source-atop';
    c.fillStyle = 'rgba(243,236,220,0.10)';
    c.fillRect(0, 0, w, h);

    const rnd = mulberry32(918273);
    c.globalCompositeOperation = 'destination-out';
    const step = 4;
    const amp = 15;

    for (let x = 0; x < w; x += step) {
      const wob = amp + Math.sin(x / 26) * 5 + rnd() * 9;
      c.fillRect(x, 0, step + 1, Math.max(0, wob));
    }
    for (let x = 0; x < w; x += step) {
      const wob = amp + Math.sin(x / 31 + 2) * 5 + rnd() * 9;
      c.fillRect(x, h - Math.max(0, wob), step + 1, Math.max(0, wob));
    }
    for (let y = 0; y < h; y += step) {
      const wob = amp + Math.sin(y / 23 + 1) * 4 + rnd() * 8;
      c.fillRect(0, y, Math.max(0, wob), step + 1);
    }
    for (let y = 0; y < h; y += step) {
      const wob = amp + Math.sin(y / 27 + 3) * 4 + rnd() * 8;
      c.fillRect(w - Math.max(0, wob), y, Math.max(0, wob), step + 1);
    }
    for (let i = 0; i < 2200; i++) {
      const t = rnd();
      const x = rnd() * w;
      const y = (t < 0.5 ? rnd() * 34 : h - rnd() * 34);
      c.fillRect(x, y, rnd() * 7 + 1, rnd() * 7 + 1);
    }
    // 两侧飞白
    for (let i = 0; i < 1200; i++) {
      const t = rnd();
      const y = rnd() * h;
      const x = (t < 0.5 ? rnd() * 34 : w - rnd() * 34);
      c.fillRect(x, y, rnd() * 7 + 1, rnd() * 7 + 1);
    }
    return off;
  }

  /* ---------------- 邮戳 ---------------- */
  function postmark(ctx, cx, cy, r, text) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.14);
    ctx.strokeStyle = PMBLUE;
    ctx.fillStyle = PMBLUE;
    ctx.globalAlpha = 0.60;

    ctx.lineWidth = 4.5;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(0, 0, r - 15, 0, Math.PI * 2); ctx.stroke();

    // 环内小点
    ctx.globalAlpha = 0.5;
    for (let k = 0; k < 28; k++) {
      const a = (Math.PI * 2 / 28) * k;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * (r - 7.5), Math.sin(a) * (r - 7.5), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 中间日期
    ctx.globalAlpha = 0.62;
    ctx.textAlign = 'center';
    const inner = text || 'POST';
    const fs = inner.length > 9 ? 15 : (inner.length > 6 ? 18 : 24);
    ctx.font = `500 ${fs}px "American Typewriter", "Courier New", monospace`;
    ctx.fillText(inner, 0, 6);
    ctx.font = '400 12px "American Typewriter", "Courier New", monospace';
    ctx.globalAlpha = 0.45;
    ctx.fillText('POST CARD', 0, 32);
    ctx.textAlign = 'left';

    // 波浪邮线（不出画布）
    ctx.globalAlpha = 0.42;
    ctx.lineWidth = 3;
    const xEnd = Math.min(W - cx - 24, r + 132);
    for (let k = 0; k < 4; k++) {
      const yy = -30 + k * 20;
      ctx.beginPath();
      for (let x = r + 8; x <= xEnd; x += 2) {
        const y = yy + Math.sin(x / 20) * 5.5;
        if (x === r + 8) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* ---------------- 合成绘制 ---------------- */
  function paint(canvas, yStart, opts) {
    const o = opts || {};
    const style = STYLES.find((s) => s.id === state.styleId) || STYLES[0];
    const ctx = canvas.getContext('2d');

    ctx.save();
    ctx.translate(0, -yStart);

    ctx.fillStyle = style.paper;
    ctx.fillRect(0, yStart, W, H - yStart);

    // 1) 原片
    if (!o.cardOnly && state.photo) {
      const im = state.photo;
      const cover = Math.max(W / im.naturalWidth, PHOTO_H / im.naturalHeight);
      const dw = im.naturalWidth * cover;
      const dh = im.naturalHeight * cover;
      const cropFrac = 1 - Math.min(W / dw, PHOTO_H / dh);
      if (cropFrac <= 0.22) {
        ctx.drawImage(im, (W - dw) / 2, (PHOTO_H - dh) / 2, dw, dh);
      } else {
        const sc = Math.min(W / im.naturalWidth, PHOTO_H / im.naturalHeight);
        const dw2 = im.naturalWidth * sc;
        const dh2 = im.naturalHeight * sc;
        ctx.fillStyle = style.paper;
        ctx.fillRect(0, 0, W, PHOTO_H);
        ctx.drawImage(im, (W - dw2) / 2, (PHOTO_H - dh2) / 2, dw2, dh2);
      }
    }

    // 2) 撕纸（投影 + 主纸面 + 纸边高光）
    const pts = tearPoints();
    const paperPath = (dy) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1] + dy);
      pts.forEach((p) => ctx.lineTo(p[0], p[1] + dy));
      ctx.lineTo(W, H + 40);
      ctx.lineTo(0, H + 40);
      ctx.closePath();
    };

    if (!o.cardOnly) {
      ctx.save();
      ctx.shadowColor = 'rgba(40,30,16,0.30)';
      ctx.shadowBlur = 22;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = style.paper;
      paperPath(0);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = style.paper;
    paperPath(0);
    ctx.fill();

    ctx.save();
    ctx.fillStyle = PAPER_HI;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1] - 7);
    pts.forEach((p) => ctx.lineTo(p[0], p[1] - 7));
    pts.slice().reverse().forEach((p) => ctx.lineTo(p[0], p[1] + 2));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 纸纹
    const rnd = mulberry32(556677);
    ctx.save();
    ctx.globalAlpha = 0.035;
    ctx.fillStyle = '#6B5F4D';
    for (let i = 0; i < 3600; i++) {
      ctx.fillRect(rnd() * W, TEAR + rnd() * (H - TEAR), 1, 1);
    }
    ctx.restore();

    // 3) 插画
    if (state.illo) {
      const rough = roughIllo(state.illo, IW, IH);
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(rough, IX, IY, IW, IH);
      ctx.restore();
    } else {
      ctx.save();
      ctx.strokeStyle = 'rgba(58,52,44,0.18)';
      ctx.setLineDash([14, 10]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(IX + .5, IY + .5, IW - 1, IH - 1);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(58,52,44,0.5)';
      ctx.font = typeFont(24);
      ctx.textAlign = 'center';
      ctx.fillText('AI 插画将印在这里', W / 2, IY + IH / 2);
      ctx.textAlign = 'left';
      ctx.restore();
    }

    // 4) 标题 + 5) 邮戳
    const place = ($('pcPlace') && $('pcPlace').value.trim()) || '';
    const date = ($('pcDate') && $('pcDate').value.trim()) || '';

    if (place) {
      ctx.save();
      ctx.fillStyle = INK;
      ctx.font = typeFont(40);
      ctx.globalAlpha = 0.92;
      spaced(ctx, place, TITLE_X - 2, TITLE_Y, 3.4);
      ctx.restore();
    }

    postmark(ctx, PM_CX, PM_CY, PM_R, date);

    // 6) 底部一行
    ctx.save();
    ctx.fillStyle = MUTED;
    ctx.font = typeFont(34);
    if (place) {
      spaced(ctx, place, TITLE_X - 2, BOTTOM_Y, 2.4);
      const w1 = ctx.measureText(place).width + 2.4 * place.length;
      spaced(ctx, '• PLACE', TITLE_X - 2 + w1 + 16, BOTTOM_Y, 2.4);
    }
    if (date) {
      const s = `${date} • DATE`;
      spacedRight(ctx, s, W - TITLE_X + 2, BOTTOM_Y, 2.4);
    }
    ctx.restore();

    ctx.restore();
  }

  function spacedRight(ctx, text, rightX, y, sp) {
    let total = 0;
    for (const ch of text) total += ctx.measureText(ch).width + sp;
    total -= sp;
    spaced(ctx, text, rightX - total, y, sp);
  }

  function render() {
    if (!state.photo) return;
    const full = document.createElement('canvas');
    full.width = W; full.height = H;
    paint(full, 0, {});
    state.fullCanvas = full;

    const card = document.createElement('canvas');
    card.width = W; card.height = H - TEAR + 22;
    paint(card, TEAR - 22, { cardOnly: true });
    state.cardCanvas = card;

    $('pcResultImg').src = full.toDataURL('image/png');
    $('pcResultCard').style.display = '';
    $('pcResultImg').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function download(canvas, name) {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  }

  /* ---------------- 上传 ---------------- */
  async function setFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { err('请选择图片文件。'); return; }
    if (file.size > 25 * 1024 * 1024) { err('图片太大（超过 25MB），请压缩后再传。'); return; }
    err(null);
    state.file = file;
    state.illo = null;

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        state.photo = await loadImage(reader.result);
        $('pcPreviewImg').src = reader.result;
        $('pcPreviewHint').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB · ${state.photo.naturalWidth}×${state.photo.naturalHeight}`;
        $('pcPreviewWrap').style.display = '';
        render();
      } catch (e) {
        err('这张图打不开（文件可能已损坏），换一张 JPG / PNG 试试。');
      }
    };
    reader.readAsDataURL(file);
  }

  /* ---------------- 生成 ---------------- */
  async function generate() {
    if (state.busy) return;
    if (!state.file) { err('请先上传一张照片。'); return; }
    const style = STYLES.find((s) => s.id === state.styleId) || STYLES[0];

    err(null);
    state.busy = true;
    $('pcGo').disabled = true;
    status('AI 正在印制插画…（约 30–90 秒）');

    try {
      const fd = new FormData();
      fd.append('image', state.file);
      fd.append('prompt', style.prompt);
      fd.append('model', 'gpt-image-2-pro');
      fd.append('size', '1536x1024');
      fd.append('quality', 'medium');
      fd.append('output_format', 'png');

      const res = await fetch('/api/edit', { method: 'POST', body: fd });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || `服务器返回异常 (${res.status})` }; }
      if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);

      const item = (data.data && data.data[0]) || {};
      const src = item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url;
      if (!src) throw new Error('接口没有返回插画数据');

      state.illo = await loadImage(src);
      render();
      status('完成。可以换风格再生成，或直接下载。');
    } catch (e) {
      err(e.message);
      status('');
    } finally {
      state.busy = false;
      $('pcGo').disabled = false;
    }
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    const wrap = $('pcStyles');
    if (!wrap) return;
    wrap.innerHTML = '';
    STYLES.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'chip' + (s.id === state.styleId ? ' pc-chip-active' : '');
      b.innerHTML = `${s.name}<span class="pc-chip-desc">${s.desc}</span>`;
      b.onclick = () => {
        state.styleId = s.id;
        wrap.querySelectorAll('.chip').forEach((el, i) => el.classList.toggle('pc-chip-active', STYLES[i].id === s.id));
        if (state.photo) render();
      };
      wrap.appendChild(b);
    });

    $('pcDrop').addEventListener('click', () => $('pcFile').click());
    $('pcDrop').addEventListener('dragover', (e) => { e.preventDefault(); $('pcDrop').classList.add('drag'); });
    $('pcDrop').addEventListener('dragleave', () => $('pcDrop').classList.remove('drag'));
    $('pcDrop').addEventListener('drop', (e) => {
      e.preventDefault();
      $('pcDrop').classList.remove('drag');
      if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
    });
    $('pcFile').addEventListener('change', (e) => { if (e.target.files.length) setFile(e.target.files[0]); });

    $('pcGo').onclick = generate;
    $('pcDownloadAll').onclick = () => state.fullCanvas && download(state.fullCanvas, 'travel-postcard.png');
    $('pcDownloadHalf').onclick = () => state.cardCanvas && download(state.cardCanvas, 'postcard-front.png');
    $('pcRegen').onclick = generate;

    ['pcPlace', 'pcDate'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', () => { if (state.photo) render(); });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
