/* ============================================================
 * 旅行明信片模块（v1）
 * 设计原则：
 *   1. 上半部分 = 用户原片，程序直接绘制，不经过 AI，绝不改人脸/建筑
 *   2. 下半部分 = AI 只生成「插画」，禁止出现文字、邮戳、边框
 *   3. 纸张、撕边、邮戳、地点/日期文字、排版 全部由 canvas 程序绘制
 * ============================================================ */
(() => {
  'use strict';

  const W = 1536;
  const H = 2048;

  const TOP_H = 1064;                 // 上半原片区域
  const CARD_TOP = 1040;              // 撕边位置（略微压住原片）
  const ART_PAD = 10;                 // 撕边下方留一条纸边
  const BAND_H = 140;                 // 底部文字纸带

  const INK = '#26221E';
  const MUT = '#7B7268';

  const STYLES = [
    {
      id: 'watercolor',
      name: '日系水彩',
      desc: '温柔治愈 · 旅行感',
      paper: '#FBF7EF',
      accent: '#8C9A86',
      prompt: `Convert this photograph into a hand-painted Japanese vintage travel postcard illustration: soft transparent watercolour on textured cotton paper. Keep the same scene exactly — the same main subject, the same people with identical faces, pose and clothing, the same landmark buildings, mountains, coastline, streets, boats and trees, with the same spatial relationships. Anyone who knows this place must instantly recognise it. Simplify details into gentle watercolour washes, light ink accents only where they help. Muted palette limited to 2 to 4 colours: cream white, warm ivory, misty blue, sage green, warm sand. Calm, nostalgic, sunny travel mood, generous breathing space. Wide landscape composition matching the original framing. Keep the photograph's own colour mood and lighting: a warm sunset must stay warm and luminous, never faded, overexposed or desaturated. Keep clear value separation between sky, sea and buildings, medium-strong pigment with layered washes and a few crisp edges. Strictly NO text, NO letters, NO numbers, NO logo, NO watermark, NO signature, NO border, NO frame, NO stamp, NO postmark, NO paper mock-up — illustration only, all typography and paper texture are added later by the layout program.`
    },
    {
      id: 'minimal',
      name: '极简手绘',
      desc: '留白干净 · 艺术感',
      paper: '#FCFBF7',
      accent: '#9AA0A6',
      prompt: `Convert this photograph into a minimal hand-drawn travel illustration in the style of a modern independent travel magazine: fine ink line work, flat very light colour washes, plenty of clean white space, calm editorial composition. Keep the same scene exactly — the same main subject, the same people with identical faces, pose and clothing, the same landmark buildings and landscape elements, same spatial arrangement, instantly recognisable. Restrained palette of 2 to 3 colours: off-white, warm grey, plus one soft accent such as sage or dusty blue, but preserve the photograph's colour relationships and value structure: do not flatten everything into pale grey, keep one clear focal point and readable contrast. Wide landscape composition matching the original framing. Strictly NO text, NO letters, NO numbers, NO logo, NO watermark, NO signature, NO border, NO frame, NO stamp, NO paper texture, NO mock-up — illustration only.`
    },
    {
      id: 'retro',
      name: '复古票根',
      desc: '怀旧收藏 · 杂志感',
      paper: '#F7F0E1',
      accent: '#B0663F',
      prompt: `Convert this photograph into a vintage screen-printed travel poster illustration, mid-century retro print style: simplified bold flat shapes, limited flat shading, slight ink misregistration and subtle print grain, warm nostalgic feeling. Keep the same scene exactly — the same main subject, the same people with identical faces, pose and clothing, the same landmark buildings, coast, mountains and boats, same spatial arrangement, instantly recognisable. Limited palette of 3 to 4 colours: cream paper tone, deep teal or terracotta red, warm sand, dark ink. Carry over the photograph's light direction and colour mood - a golden sunset must still read as golden - with strong flat contrast and solid ink coverage. Wide landscape composition matching the original framing. Strictly NO text, NO letters, NO numbers, NO logo, NO watermark, NO signature, NO border, NO frame, NO stamp, NO paper mock-up — pure illustration only.`
    }
  ];

  const state = {
    file: null,
    photo: null,      // HTMLImageElement
    illo: null,       // HTMLImageElement
    styleId: 'watercolor',
    busy: false,
    fullCanvas: null,
    cardCanvas: null
  };

  const $ = (id) => document.getElementById(id);

  /* ---------- 小工具 ---------- */
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

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片加载失败'));
      im.src = src;
    });
  }

  function err(msg) {
    const el = $('pcError');
    if (msg) { el.textContent = msg; el.style.display = 'block'; }
    else { el.style.display = 'none'; }
  }

  function status(msg) { $('pcStatus').textContent = msg || ''; }

  /* ---------- 合成绘制 ---------- */
  // xStart / yStart：导出局部时把绝对坐标平移
  function paint(canvas, yStart, opts) {
    const o = opts || {};
    const style = STYLES.find((s) => s.id === state.styleId) || STYLES[0];
    const ctx = canvas.getContext('2d');

    ctx.save();
    ctx.translate(0, -yStart);

    // 底色
    ctx.fillStyle = o.cardOnly ? style.paper : '#EFE7D8';
    ctx.fillRect(0, yStart, W, H - yStart);

    // 1) 上半部分：原片，等比完整显示（不裁切、不拉伸）
    if (!o.cardOnly && state.photo) {
      const im = state.photo;
      const sc = Math.min(W / im.naturalWidth, TOP_H / im.naturalHeight);
      const dw = im.naturalWidth * sc;
      const dh = im.naturalHeight * sc;
      ctx.drawImage(im, (W - dw) / 2, (TOP_H - dh) / 2, dw, dh);
    }

    // 2) 纸卡（下半），手撕纸边缘
    const steps = 128;
    const edge = [];
    for (let i = 0; i <= steps; i++) {
      const x = (W / steps) * i;
      const y = CARD_TOP + Math.sin(i * 1.45) * 4 + Math.sin(i * 0.33 + 1) * 8;
      edge.push([x, y]);
    }

    // 3) 插画：满幅铺满下半张卡片
    const artTop = CARD_TOP + ART_PAD;
    const artH = H - artTop;
    if (state.illo) {
      const im = state.illo;
      const sc = Math.max(W / im.naturalWidth, artH / im.naturalHeight);
      const dw = im.naturalWidth * sc;
      const dh = im.naturalHeight * sc;
      ctx.drawImage(im, (W - dw) / 2, artTop + (artH - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = '#F3EADA';
      ctx.fillRect(0, artTop, W, artH);
      ctx.strokeStyle = 'rgba(38,34,30,0.18)';
      ctx.setLineDash([12, 9]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(40.5, artTop + 40.5, W - 81, artH - 81);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(90,80,64,0.8)';
      ctx.font = '400 30px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('AI 插画 · 满幅', W / 2, artTop + artH / 2);
      ctx.textAlign = 'left';
    }

    // 4) 撕边纸沿（盖在插画顶部，露出纸张厚度）
    ctx.beginPath();
    ctx.moveTo(0, edge[0][1]);
    edge.forEach((pt) => ctx.lineTo(pt[0], pt[1]));
    ctx.lineTo(W, artTop + 6);
    ctx.lineTo(0, artTop + 6);
    ctx.closePath();
    ctx.save();
    ctx.shadowColor = 'rgba(48,36,20,0.16)';
    ctx.shadowBlur = o.cardOnly ? 0 : 16;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = style.paper;
    ctx.fill();
    ctx.restore();

    // 5) 底部文字纸带
    const bandTop = H - BAND_H;
    ctx.fillStyle = style.paper;
    ctx.fillRect(0, bandTop, W, BAND_H);
    ctx.strokeStyle = 'rgba(38,34,30,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, bandTop + 0.5);
    ctx.lineTo(W, bandTop + 0.5);
    ctx.stroke();

    // 纸张纤维颗粒（固定随机，整张/半张导出一致）
    const rnd = mulberry32(20260116);
    ctx.save();
    ctx.globalAlpha = 0.03;
    ctx.fillStyle = '#6B5F4D';
    for (let i = 0; i < 1800; i++) {
      ctx.fillRect(rnd() * W, bandTop + 2 + rnd() * (BAND_H - 4), 1, 1);
    }
    ctx.restore();

    const place = ($('pcPlace') && $('pcPlace').value.trim()) || '';
    const date = ($('pcDate') && $('pcDate').value.trim()) || '';
    const tx = 64;

    if (place || date) {
      ctx.fillStyle = MUT;
      ctx.font = '600 13px "Helvetica Neue", Arial, sans-serif';
      spaced(ctx, 'TRAVEL MOMENT', tx, bandTop + 40, 3);

      if (place) {
        ctx.fillStyle = INK;
        ctx.font = '500 42px "Songti SC", "Noto Serif SC", Georgia, serif';
        ctx.fillText(place, tx - 1, bandTop + 86);
        if (date) {
          ctx.fillStyle = MUT;
          ctx.font = '400 21px "Helvetica Neue", Arial, sans-serif';
          ctx.fillText(date, tx, bandTop + 118);
        }
      } else {
        ctx.fillStyle = INK;
        ctx.font = '500 30px "Helvetica Neue", Arial, sans-serif';
        ctx.fillText(date, tx, bandTop + 92);
      }
    }

    // 6) 邮戳
    const pmCx = W - 96;
    const pmCy = bandTop + BAND_H / 2 + 2;
    ctx.strokeStyle = style.accent;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(pmCx, pmCy, 48, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(pmCx, pmCy, 40, 0, Math.PI * 2); ctx.stroke();

    ctx.save();
    ctx.fillStyle = style.accent;
    ctx.globalAlpha = 0.7;
    ctx.textAlign = 'center';
    if (date) {
      ctx.font = '400 15px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText(date, pmCx, pmCy + 5);
    } else {
      ctx.font = '600 12px "Helvetica Neue", Arial, sans-serif';
      spacedCenter(ctx, 'POST', pmCx, pmCy + 4, 2);
    }
    ctx.textAlign = 'left';
    ctx.restore();

    // 波浪邮线
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = style.accent;
    ctx.lineWidth = 1.5;
    for (let k = 0; k < 3; k++) {
      const yy = pmCy - 12 + k * 12;
      ctx.beginPath();
      for (let x = pmCx - 190; x <= pmCx - 66; x += 2) {
        const y = yy + Math.sin(x / 7) * 3;
        if (x === pmCx - 190) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function spacedCenter(ctx, text, cx, y, sp) {
    ctx.font = ctx.font;
    let total = 0;
    for (const ch of text) total += ctx.measureText(ch).width + sp;
    total -= sp;
    spaced(ctx, text, cx - total / 2, y, sp);
  }

  function render() {
    if (!state.photo) return;
    const full = document.createElement('canvas');
    full.width = W; full.height = H;
    paint(full, 0, {});
    state.fullCanvas = full;

    const card = document.createElement('canvas');
    card.width = W; card.height = H - CARD_TOP;
    paint(card, CARD_TOP, { cardOnly: true });
    state.cardCanvas = card;

    $('pcResultImg').src = full.toDataURL('image/png');
    $('pcResultCard').style.display = '';
    $('pcResultImg').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function download(canvas, name) {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  }

  /* ---------- 上传 ---------- */
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
        render();   // 先显示占位版式，让用户看到构图
      } catch (e) { err('这张图打不开（文件可能已损坏），换一张 JPG / PNG 试试。'); console.error(e); }
    };
    reader.readAsDataURL(file);
  }

  /* ---------- 生成 ---------- */
  async function generate() {
    if (state.busy) return;
    if (!state.file) { err('请先上传一张照片。'); return; }
    const style = STYLES.find((s) => s.id === state.styleId) || STYLES[0];

    err(null);
    state.busy = true;
    $('pcGo').disabled = true;
    status('AI 正在绘制明信片插画…（约 30–90 秒）');

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

  /* ---------- 初始化 ---------- */
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
    $('pcDownloadHalf').onclick = () => state.cardCanvas && download(state.cardCanvas, 'postcard-illustration.png');
    $('pcRegen').onclick = generate;

    ['pcPlace', 'pcDate'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', () => { if (state.photo) render(); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else init();
})();
