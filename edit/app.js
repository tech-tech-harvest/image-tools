(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ブラウザのキャンバス上限を超えないようにするための制限
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_AREA = 100_000_000;
  const PREVIEW_MAX_SIDE = 1600; // 画面表示用の縮小版の長い辺（保存は元の解像度で作り直す）
  const HISTORY_LIMIT = 60;
  const JPEG_QUALITY = 0.92;
  const HANDLE_HIT = 12;   // つまみの当たり判定（画面px）
  const MIN_CROP = 24;     // トリミング枠の最小（画面px）
  const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif';
  const COLORS = ['#ffffff', '#111111', '#ef4444', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const HANDLE_CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  };

  const makeCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  };
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  const stage = $('stage');
  const view = $('view');
  const overlay = $('overlay');
  const toolHint = $('tool-hint');

  // ================= 編集内容（設定として持ち、画素は書き換えない） =================
  // 座標は「回転・反転・傾きを済ませたあとの、元の解像度の画像」の上での位置
  const defaultState = () => ({
    rotation: 0, flipH: false, flipV: false, straighten: 0,
    crop: null, // null は画像全体
    adjust: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 },
    filter: { id: 'none', strength: 100 },
    texts: [],   // { id, text, x, y（中心）, size, color, bold, stroke, band }
    strokes: [], // { mode: 'draw' | 'erase', color, width, points: [[x, y], ...] }
  });
  let state = defaultState();
  let history = [];
  let historyIndex = -1;

  let fileName = 'image';
  let sourceType = '';
  let baseFull = null;  // 元画像（EXIF の向きを反映済み）
  let baseSmall = null; // 画面表示用の縮小版
  let ps = 1;           // 元の解像度 → 表示用の縮小率
  let geomCache = null; // { key, canvas } 回転などを済ませた縮小版
  let colorCache = null; // { key, canvas } さらに調整・フィルタを済ませたもの
  let penLayer = null;  // ペンの線（縮小版の大きさ）
  let showOriginal = false;
  let selectedText = null;
  let drag = null;
  let pointer = null;
  let nextTextId = 1;

  const getTool = () => document.querySelector('input[name="tool"]:checked').value;

  // ================= ファイル入力 =================
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  ['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
  dropZone.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });
  // ページ全体へのドロップでブラウザが画像を開いてしまうのを防ぐ
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  function loadFile(file) {
    if (!file.type.startsWith('image/')) {
      alert('画像ファイルを選択してください。');
      return;
    }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      setup(im, file);
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      alert('画像を読み込めませんでした。');
    };
    im.src = url;
  }

  function setup(im, file) {
    fileName = file.name.replace(/\.[^.]+$/, '') || 'image';
    sourceType = file.type;
    const iw = im.naturalWidth;
    const ih = im.naturalHeight;
    const s = Math.min(1, MAX_CANVAS_SIDE / iw, MAX_CANVAS_SIDE / ih, Math.sqrt(MAX_CANVAS_AREA / (iw * ih)));
    baseFull = makeCanvas(iw * s, ih * s);
    baseFull.getContext('2d').drawImage(im, 0, 0, baseFull.width, baseFull.height);
    ps = Math.min(1, PREVIEW_MAX_SIDE / Math.max(baseFull.width, baseFull.height));
    baseSmall = makeCanvas(baseFull.width * ps, baseFull.height * ps);
    const sctx = baseSmall.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(baseFull, 0, 0, baseSmall.width, baseSmall.height);

    state = defaultState();
    history = [];
    historyIndex = -1;
    selectedText = null;
    geomCache = colorCache = null;
    estimate = null;
    commit();
    $('file-info').textContent = `${file.name}（${iw} × ${ih} px）`;
    $('save-result').textContent = '';

    $('step-input').classList.add('hidden');
    $('workspace').classList.remove('hidden');
    $('side').classList.remove('hidden');
    document.body.classList.add('has-side');
    window.scrollTo(0, 0);

    syncPanels();
    setView('edit');
    renderFilterThumbs();
  }

  // ================= 色の計算（調整・フィルタ） =================
  // ブラウザの filter は Safari で効かないことがあるので、画素を自前で計算する
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const saturate = (r, g, b, k) => {
    const y = lum(r, g, b);
    return [y + (r - y) * k, y + (g - y) * k, y + (b - y) * k];
  };
  const contrast = (v, k) => (v - 128) * k + 128;

  const FILTERS = [
    { id: 'none', name: 'なし', fn: null },
    { id: 'mono', name: 'モノクロ', fn: (r, g, b) => { const y = lum(r, g, b); return [y, y, y]; } },
    { id: 'sepia', name: 'セピア', fn: (r, g, b) => [0.393 * r + 0.769 * g + 0.189 * b, 0.349 * r + 0.686 * g + 0.168 * b, 0.272 * r + 0.534 * g + 0.131 * b] },
    { id: 'vivid', name: 'ビビッド', fn: (r, g, b) => saturate(r, g, b, 1.45).map((v) => contrast(v, 1.1)) },
    { id: 'retro', name: 'レトロ', fn: (r, g, b) => { const [r2, g2, b2] = saturate(r, g, b, 0.7); return [r2 * 0.85 + 38, g2 * 0.8 + 30, b2 * 0.7 + 22]; } },
    { id: 'cool', name: 'クール', fn: (r, g, b) => { const [r2, g2, b2] = saturate(r, g, b, 0.9); return [r2 * 0.9, g2 * 0.98 + 4, b2 * 1.08 + 18]; } },
    { id: 'warm', name: 'ウォーム', fn: (r, g, b) => [r * 1.08 + 12, g * 1.02 + 4, b * 0.85] },
    { id: 'drama', name: 'ドラマ', fn: (r, g, b) => saturate(r, g, b, 0.6).map((v) => contrast(v, 1.35)) },
    { id: 'fade', name: 'フェード', fn: (r, g, b) => saturate(r, g, b, 0.85).map((v) => v * 0.78 + 42) },
  ];
  const filterById = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

  function applyColor(img, adjust, filter) {
    const { brightness: B, contrast: C, saturation: S, temperature: T } = adjust;
    const fn = filterById(filter.id).fn;
    const k = filter.strength / 100;
    if (!B && !C && !S && !T && (!fn || !k)) return;
    const cf = C >= 0 ? 1 + C / 100 : 1 + C / 150;
    const sf = 1 + S / 100;
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] + B * 1.2;
      let g = d[i + 1] + B * 1.2;
      let b = d[i + 2] + B * 1.2;
      if (C) { r = contrast(r, cf); g = contrast(g, cf); b = contrast(b, cf); }
      if (S) [r, g, b] = saturate(r, g, b, sf);
      if (T) { r += T * 0.45; b -= T * 0.45; }
      if (fn && k) {
        const [fr, fg, fb] = fn(r, g, b);
        r += (fr - r) * k;
        g += (fg - g) * k;
        b += (fb - b) * k;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; // Uint8ClampedArray なので 0〜255 に収まる
    }
  }

  // ================= 回転・反転・傾き =================
  const geomSize = () => (state.rotation % 180 ? [baseFull.height, baseFull.width] : [baseFull.width, baseFull.height]);

  // 傾けても四隅に空きが出ないよう拡大する倍率
  function coverScale(w, h, deg) {
    const a = Math.abs((deg * Math.PI) / 180);
    const c = Math.cos(a);
    const s = Math.sin(a);
    return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
  }

  // 元画像（src は baseFull か baseSmall）を、回転・反転・傾きを済ませた画像にする。scale は元の解像度に対する倍率
  function drawGeometry(src, scale) {
    const [gw, gh] = geomSize();
    const c = makeCanvas(gw * scale, gh * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(c.width / 2, c.height / 2);
    if (state.straighten) {
      ctx.rotate((state.straighten * Math.PI) / 180);
      const k = coverScale(gw, gh, state.straighten);
      ctx.scale(k, k);
    }
    // 反転は見えている向きのまま行う（回転より先に掛ける）
    ctx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
    ctx.rotate((state.rotation * Math.PI) / 180);
    const w = baseFull.width * scale;
    const h = baseFull.height * scale;
    ctx.drawImage(src, -w / 2, -h / 2, w, h);
    // 後から文字やペンを描くときにずれないよう、変形を元に戻しておく
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  const geomKey = () => JSON.stringify([state.rotation, state.flipH, state.flipV, state.straighten]);
  const colorKey = () => geomKey() + JSON.stringify([state.adjust, state.filter]);

  function previewImage() {
    if (!geomCache || geomCache.key !== geomKey()) {
      geomCache = { key: geomKey(), canvas: drawGeometry(baseSmall, ps) };
      colorCache = null;
    }
    if (!colorCache || colorCache.key !== colorKey()) {
      const c = makeCanvas(geomCache.canvas.width, geomCache.canvas.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(geomCache.canvas, 0, 0);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      applyColor(img, state.adjust, state.filter);
      ctx.putImageData(img, 0, 0);
      colorCache = { key: colorKey(), canvas: c };
    }
    return colorCache.canvas;
  }

  // ================= ペン・文字の描画 =================
  function drawStrokes(ctx, strokes, scale) {
    strokes.forEach((st) => {
      ctx.globalCompositeOperation = st.mode === 'erase' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = st.color;
      ctx.fillStyle = st.color;
      ctx.lineWidth = st.width * scale;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const pts = st.points;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0][0] * scale, pts[0][1] * scale, (st.width * scale) / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      // 点と点の中間を通る曲線でなめらかにつなぐ
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * scale, pts[0][1] * scale);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = ((pts[i][0] + pts[i + 1][0]) / 2) * scale;
        const my = ((pts[i][1] + pts[i + 1][1]) / 2) * scale;
        ctx.quadraticCurveTo(pts[i][0] * scale, pts[i][1] * scale, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last[0] * scale, last[1] * scale);
      ctx.stroke();
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  function renderPenLayer() {
    const [gw, gh] = geomSize();
    penLayer = makeCanvas(gw * ps, gh * ps);
    drawStrokes(penLayer.getContext('2d'), state.strokes, ps);
  }

  const measureCtx = makeCanvas(1, 1).getContext('2d');
  const isLight = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return lum(n >> 16, (n >> 8) & 255, n & 255) > 150;
  };

  // 文字の外枠（元の解像度での位置と大きさ）
  function textBox(t) {
    measureCtx.font = `${t.bold ? 'bold ' : ''}${t.size}px ${FONT}`;
    const lines = (t.text || ' ').split('\n');
    const w = Math.max(...lines.map((l) => measureCtx.measureText(l || ' ').width));
    const lh = t.size * 1.25;
    const pad = t.band ? t.size * 0.35 : t.size * 0.1;
    const bw = w + pad * 2;
    const bh = lh * lines.length + pad * 2;
    return { x: t.x - bw / 2, y: t.y - bh / 2, w: bw, h: bh, lines, lh, pad };
  }

  // scale: 元の解像度に対する倍率、ox/oy: 描く範囲の左上（元の解像度）
  function drawText(ctx, t, scale, ox, oy) {
    const box = textBox(t);
    const tx = (v) => (v - ox) * scale;
    const ty = (v) => (v - oy) * scale;
    if (t.band) {
      ctx.fillStyle = isLight(t.color) ? 'rgba(0, 0, 0, .55)' : 'rgba(255, 255, 255, .75)';
      ctx.beginPath();
      ctx.roundRect(tx(box.x), ty(box.y), box.w * scale, box.h * scale, t.size * 0.2 * scale);
      ctx.fill();
    }
    ctx.font = `${t.bold ? 'bold ' : ''}${t.size * scale}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    box.lines.forEach((line, i) => {
      const y = ty(box.y + box.pad + box.lh * (i + 0.5));
      const x = tx(t.x);
      if (t.stroke) {
        ctx.strokeStyle = isLight(t.color) ? '#111' : '#fff';
        ctx.lineWidth = t.size * 0.14 * scale;
        ctx.strokeText(line, x, y);
      }
      ctx.fillStyle = t.color;
      ctx.fillText(line, x, y);
    });
  }

  // ================= 画面への描画 =================
  // トリミングのタブでは画像全体、それ以外ではトリミングした範囲を表示する
  const fullRegion = () => { const [w, h] = geomSize(); return { x: 0, y: 0, w, h }; };
  const cropRect = () => state.crop || fullRegion();
  const displayRegion = () => (getTool() === 'crop' ? fullRegion() : cropRect());

  function redraw() {
    if (!baseFull) return;
    const ctx = view.getContext('2d');
    if (showOriginal) {
      view.width = baseSmall.width;
      view.height = baseSmall.height;
      ctx.drawImage(baseSmall, 0, 0);
      drawOverlay();
      return;
    }
    const r = displayRegion();
    const w = Math.max(1, Math.round(r.w * ps));
    const h = Math.max(1, Math.round(r.h * ps));
    if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
    const img = previewImage();
    if (!penLayer || penLayer.width !== img.width || penLayer.height !== img.height) renderPenLayer();
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, r.x * ps, r.y * ps, r.w * ps, r.h * ps, 0, 0, w, h);
    ctx.drawImage(penLayer, r.x * ps, r.y * ps, r.w * ps, r.h * ps, 0, 0, w, h);
    state.texts.forEach((t) => drawText(ctx, t, ps, r.x, r.y));
    drawOverlay();
  }

  // 画面座標 → 元の解像度での位置
  function pointerToImage(e) {
    const rect = view.getBoundingClientRect();
    const r = displayRegion();
    return { x: r.x + ((e.clientX - rect.left) / rect.width) * r.w, y: r.y + ((e.clientY - rect.top) / rect.height) * r.h };
  }
  const imagePerScreen = () => displayRegion().w / view.getBoundingClientRect().width;

  // ---- ガイド（トリミング枠・文字の選択枠・ペンの円） ----
  function resizeOverlay() {
    const rect = view.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(rect.width * dpr);
    overlay.height = Math.round(rect.height * dpr);
    drawOverlay();
  }
  new ResizeObserver(resizeOverlay).observe(view);

  const handlePoint = (b, h) => ({
    x: h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2,
    y: h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : b.y + b.h / 2,
  });

  function drawOverlay() {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!baseFull || showOriginal) return;
    const dpr = window.devicePixelRatio || 1;
    const r = displayRegion();
    const k = overlay.width / r.w; // 元の解像度 → ガイドpx
    const X = (v) => (v - r.x) * k;
    const Y = (v) => (v - r.y) * k;
    const handle = (x, y) => {
      const s = 10 * dpr;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2 * dpr;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
      ctx.strokeRect(x - s / 2, y - s / 2, s, s);
    };
    const tool = getTool();

    if (tool === 'crop') {
      const c = cropRect();
      // 残さない部分を暗くする
      ctx.fillStyle = 'rgba(0, 0, 0, .55)';
      ctx.beginPath();
      ctx.rect(0, 0, overlay.width, overlay.height);
      ctx.rect(X(c.x), Y(c.y), c.w * k, c.h * k);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(X(c.x), Y(c.y), c.w * k, c.h * k);
      // 三分割の線
      ctx.strokeStyle = 'rgba(255, 255, 255, .45)';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo(X(c.x + (c.w * i) / 3), Y(c.y));
        ctx.lineTo(X(c.x + (c.w * i) / 3), Y(c.y + c.h));
        ctx.moveTo(X(c.x), Y(c.y + (c.h * i) / 3));
        ctx.lineTo(X(c.x + c.w), Y(c.y + (c.h * i) / 3));
      }
      ctx.stroke();
      HANDLES.forEach((h) => { const p = handlePoint(c, h); handle(X(p.x), Y(p.y)); });
    } else if (tool === 'text' && selectedText) {
      const b = textBox(selectedText);
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(X(b.x), Y(b.y), b.w * k, b.h * k);
      ctx.setLineDash([]);
      handle(X(b.x + b.w), Y(b.y + b.h));
      // 右上の × で削除
      const d = deleteBadge(b);
      const cx = X(d.x);
      const cy = Y(d.y);
      const rr = 11 * dpr;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.fillStyle = '#dc2626';
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      const a = rr * 0.4;
      ctx.beginPath();
      ctx.moveTo(cx - a, cy - a); ctx.lineTo(cx + a, cy + a);
      ctx.moveTo(cx + a, cy - a); ctx.lineTo(cx - a, cy + a);
      ctx.stroke();
    } else if (tool === 'pen' && pointer) {
      const rect = view.getBoundingClientRect();
      const x = (pointer.clientX - rect.left) * dpr;
      const y = (pointer.clientY - rect.top) * dpr;
      const radius = (Number($('pen-size').value) / 2) * dpr;
      [[3, 'rgba(0, 0, 0, .55)'], [1.5, '#fff']].forEach(([lw, color]) => {
        ctx.lineWidth = lw * dpr;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
      });
    }
  }

  // 文字の右上の外側に出す「×」
  function deleteBadge(b) {
    const k = imagePerScreen();
    return { x: b.x + b.w + 6 * k, y: b.y - 6 * k, r: 11 * k };
  }

  // ================= 道具の切り替え =================
  const HINTS = {
    adjust: 'スライダーで明るさや色合いを調整します。スライダーをダブルクリックすると 0 に戻ります。',
    filter: 'フィルタを選ぶと全体の雰囲気が変わります。「強さ」で効き具合を調整できます。',
    text: '「文字を追加」で文字を置きます。ドラッグで移動、右下の角で大きさを変更、右上の × で削除します。',
    pen: '画像の上をなぞって描きます。消しゴムはペンで描いた線だけを消します。',
    crop: '回転・反転・傾きの補正と、トリミング（残す範囲の指定）ができます。',
  };

  function onToolChange() {
    const tool = getTool();
    ['adjust', 'filter', 'text', 'pen', 'crop'].forEach((t) => $(`panel-${t}`).classList.toggle('hidden', t !== tool));
    toolHint.textContent = HINTS[tool];
    stage.dataset.tool = tool;
    stage.style.cursor = tool === 'pen' ? 'none' : tool === 'crop' || tool === 'text' ? 'default' : '';
    if (tool !== 'text') selectText(null);
    redraw();
  }
  document.querySelectorAll('input[name="tool"]').forEach((r) => r.addEventListener('change', onToolChange));

  // ================= 調整 =================
  document.querySelectorAll('input[data-adj]').forEach((input) => {
    const key = input.dataset.adj;
    input.addEventListener('input', () => {
      state.adjust[key] = Number(input.value);
      $(`v-${key}`).textContent = input.value > 0 ? `+${input.value}` : input.value;
      redraw();
    });
    input.addEventListener('change', commit);
    input.addEventListener('dblclick', () => {
      input.value = 0;
      input.dispatchEvent(new Event('input'));
      commit();
    });
  });
  $('adjust-reset').addEventListener('click', () => {
    state.adjust = defaultState().adjust;
    syncPanels();
    redraw();
    commit();
  });

  // ================= フィルタ =================
  const filterGrid = $('filter-grid');
  FILTERS.forEach((f) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter-item';
    b.dataset.filter = f.id;
    b.innerHTML = '<span class="filter-thumb"></span><span class="filter-name"></span>';
    b.querySelector('.filter-name').textContent = f.name;
    b.addEventListener('click', () => {
      state.filter = { id: f.id, strength: state.filter.id === f.id ? state.filter.strength : 100 };
      syncPanels();
      redraw();
      commit();
    });
    filterGrid.appendChild(b);
  });
  $('filter-strength').addEventListener('input', (e) => {
    state.filter.strength = Number(e.target.value);
    $('v-strength').textContent = e.target.value;
    redraw();
  });
  $('filter-strength').addEventListener('change', commit);

  // それぞれのフィルタを掛けた小さな見本を作る（回転などに合わせて作り直す）
  let thumbTimer = 0;
  function renderFilterThumbs() {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      if (!baseFull) return;
      const g = geomCache && geomCache.key === geomKey() ? geomCache.canvas : drawGeometry(baseSmall, ps);
      const size = 120;
      const s = size / Math.max(g.width, g.height);
      FILTERS.forEach((f) => {
        const c = makeCanvas(g.width * s, g.height * s);
        const ctx = c.getContext('2d');
        ctx.drawImage(g, 0, 0, c.width, c.height);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        applyColor(img, defaultState().adjust, { id: f.id, strength: 100 });
        ctx.putImageData(img, 0, 0);
        filterGrid.querySelector(`[data-filter="${f.id}"] .filter-thumb`).style.backgroundImage = `url(${c.toDataURL('image/jpeg', 0.8)})`;
      });
    }, 150);
  }

  // ================= 色の見本（文字・ペン） =================
  function makeSwatches(container, onPick) {
    COLORS.forEach((color) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.background = color;
      b.dataset.color = color;
      b.title = color;
      b.addEventListener('click', () => onPick(color));
      container.appendChild(b);
    });
    // その他の色
    const other = document.createElement('label');
    other.className = 'swatch swatch-other';
    other.title = 'ほかの色';
    other.innerHTML = '<input type="color" aria-label="ほかの色">';
    other.querySelector('input').addEventListener('input', (e) => onPick(e.target.value, true));
    other.querySelector('input').addEventListener('change', () => commit());
    container.appendChild(other);
  }
  function markSwatch(container, color) {
    let found = false;
    container.querySelectorAll('.swatch[data-color]').forEach((b) => {
      const on = b.dataset.color.toLowerCase() === color.toLowerCase();
      b.classList.toggle('active', on);
      found = found || on;
    });
    const other = container.querySelector('.swatch-other');
    other.classList.toggle('active', !found);
    if (!found) other.style.setProperty('--picked', color);
  }

  // ================= 文字 =================
  let textColor = '#ffffff';
  makeSwatches($('text-colors'), (color, live) => {
    textColor = color;
    if (selectedText) {
      selectedText.color = color;
      redraw();
      if (!live) commit();
    }
    markSwatch($('text-colors'), color);
  });

  function selectText(t) {
    selectedText = t;
    $('text-props').classList.toggle('hidden', !t);
    $('text-note').classList.toggle('hidden', !!t);
    if (t) {
      $('text-input').value = t.text;
      $('text-size').max = Math.max(400, Math.round(Math.min(...geomSize()) / 2));
      showTextSize(t.size);
      $('text-bold').checked = t.bold;
      $('text-stroke').checked = t.stroke;
      $('text-band').checked = t.band;
      markSwatch($('text-colors'), t.color);
    }
    drawOverlay();
  }

  $('text-add').addEventListener('click', () => {
    if (!baseFull) return;
    const c = cropRect();
    const t = {
      id: nextTextId++,
      text: 'テキスト',
      x: c.x + c.w / 2,
      y: c.y + c.h / 2,
      size: Math.max(12, Math.round(Math.min(c.w, c.h) * 0.08)),
      color: textColor,
      bold: true,
      stroke: true,
      band: false,
    };
    state.texts.push(t);
    selectText(t);
    redraw();
    commit();
    $('text-input').focus();
    $('text-input').select();
  });

  let textTimer = 0;
  $('text-input').addEventListener('input', (e) => {
    if (!selectedText) return;
    selectedText.text = e.target.value;
    redraw();
    // 打ち終わるのを待ってから履歴に残す
    clearTimeout(textTimer);
    textTimer = setTimeout(commit, 600);
  });
  // 大きさはスライダー・数値（px）・右下の角のドラッグのどれでも変えられ、互いに表示を合わせる
  function showTextSize(size) {
    const slider = $('text-size');
    if (size > Number(slider.max)) slider.max = Math.ceil(size); // 数値で大きく指定したらスライダーの上限も広げる
    slider.value = size;
    if (document.activeElement !== $('text-size-num')) $('text-size-num').value = Math.round(size);
  }
  function setTextSize(size) {
    if (!selectedText) return;
    selectedText.size = size;
    showTextSize(size);
    redraw();
  }
  $('text-size').addEventListener('input', (e) => setTextSize(Number(e.target.value)));
  $('text-size').addEventListener('change', commit);
  $('text-size-num').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    const ok = v >= 8 && v <= 5000;
    e.target.classList.toggle('invalid', !ok);
    if (ok) setTextSize(v);
  });
  $('text-size-num').addEventListener('change', (e) => {
    e.target.classList.remove('invalid');
    if (selectedText) e.target.value = Math.round(selectedText.size); // 範囲外の入力は元の値に戻す
    commit();
  });
  [['text-bold', 'bold'], ['text-stroke', 'stroke'], ['text-band', 'band']].forEach(([id, key]) => {
    $(id).addEventListener('change', (e) => {
      if (!selectedText) return;
      selectedText[key] = e.target.checked;
      redraw();
      commit();
    });
  });

  function deleteSelectedText() {
    if (!selectedText) return;
    state.texts = state.texts.filter((t) => t !== selectedText);
    selectText(null);
    redraw();
    commit();
  }

  function hitText(p) {
    for (let i = state.texts.length - 1; i >= 0; i--) {
      const b = textBox(state.texts[i]);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return state.texts[i];
    }
    return null;
  }

  // ================= ペン =================
  const penMode = $('pen-mode');
  let penColor = '#ef4444';
  makeSwatches($('pen-colors'), (color) => {
    penColor = color;
    markSwatch($('pen-colors'), color);
  });
  markSwatch($('pen-colors'), penColor);
  const roundTools = document.querySelectorAll('.round-tool');
  const syncRoundTools = () => roundTools.forEach((b) => {
    const on = b.dataset.mode === penMode.value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  roundTools.forEach((b) => b.addEventListener('click', () => {
    penMode.value = b.dataset.mode;
    syncRoundTools();
    $('pen-color-row').classList.toggle('hidden', penMode.value === 'erase');
  }));
  syncRoundTools();
  $('pen-size').addEventListener('input', (e) => {
    $('v-pen-size').textContent = e.target.value;
    drawOverlay();
  });
  $('pen-clear').addEventListener('click', () => {
    if (!state.strokes.length) return;
    state.strokes = [];
    renderPenLayer();
    redraw();
    commit();
  });

  // ================= 回転・反転・傾き・トリミング =================
  // 画像全体を時計回りに 90° 回したときの座標の移し替え（幅 w・高さ h の画像の上で）
  const turnCW = (x, y, w, h) => [h - y, x];
  function transformAll(fn) {
    const [w, h] = geomSize();
    state.texts.forEach((t) => { [t.x, t.y] = fn(t.x, t.y, w, h); });
    state.strokes.forEach((st) => { st.points = st.points.map(([x, y]) => fn(x, y, w, h)); });
    if (state.crop) {
      const c = state.crop;
      const [x1, y1] = fn(c.x, c.y, w, h);
      const [x2, y2] = fn(c.x + c.w, c.y + c.h, w, h);
      state.crop = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
  }

  function rotate(dir) {
    // 見えている向きのまま回す。片方だけ反転しているときは、内部の回転の向きが逆になる
    const flipped = state.flipH !== state.flipV;
    const turns = dir > 0 ? 1 : 3; // 左回り 90° ＝ 右回り 270°
    for (let i = 0; i < turns; i++) {
      transformAll(turnCW);
      state.rotation = (state.rotation + (flipped ? 270 : 90)) % 360;
    }
    afterGeometry();
  }
  $('rot-right').addEventListener('click', () => rotate(1));
  $('rot-left').addEventListener('click', () => rotate(-1));
  // 反転すると、傾きの補正の向きも見た目どおり逆になる
  $('flip-h').addEventListener('click', () => {
    transformAll((x, y, w) => [w - x, y]);
    state.flipH = !state.flipH;
    state.straighten = -state.straighten;
    syncPanels();
    afterGeometry();
  });
  $('flip-v').addEventListener('click', () => {
    transformAll((x, y, w, h) => [x, h - y]);
    state.flipV = !state.flipV;
    state.straighten = -state.straighten;
    syncPanels();
    afterGeometry();
  });
  $('straighten').addEventListener('input', (e) => {
    state.straighten = Number(e.target.value);
    $('v-straighten').textContent = state.straighten > 0 ? `+${state.straighten}` : state.straighten;
    redraw();
  });
  $('straighten').addEventListener('change', commit);
  $('straighten').addEventListener('dblclick', (e) => {
    e.target.value = 0;
    e.target.dispatchEvent(new Event('input'));
    commit();
  });
  $('crop-reset').addEventListener('click', () => {
    state.crop = null;
    redraw();
    commit();
  });

  function afterGeometry() {
    renderPenLayer();
    redraw();
    renderFilterThumbs();
    commit();
  }

  function cropHandleAt(p) {
    const c = cropRect();
    const tol = HANDLE_HIT * imagePerScreen();
    return HANDLES.find((h) => {
      const q = handlePoint(c, h);
      return Math.abs(q.x - p.x) <= tol && Math.abs(q.y - p.y) <= tol;
    }) || null;
  }

  function resizeCrop(p) {
    const o = drag.orig;
    const h = drag.handle;
    const [gw, gh] = geomSize();
    const min = MIN_CROP * imagePerScreen();
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (h.includes('w')) x1 = clamp(p.x, 0, x2 - min);
    if (h.includes('e')) x2 = clamp(p.x, x1 + min, gw);
    if (h.includes('n')) y1 = clamp(p.y, 0, y2 - min);
    if (h.includes('s')) y2 = clamp(p.y, y1 + min, gh);
    state.crop = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // ================= 画像の上の操作 =================
  stage.addEventListener('pointerdown', (e) => {
    if (!baseFull || showOriginal || e.button > 0) return;
    const tool = getTool();
    if (!['text', 'pen', 'crop'].includes(tool)) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    const p = pointerToImage(e);
    pointer = e;

    if (tool === 'pen') {
      const stroke = {
        mode: penMode.value,
        color: penColor,
        width: Number($('pen-size').value) * imagePerScreen(),
        points: [[p.x, p.y]],
      };
      state.strokes.push(stroke);
      drag = { kind: 'pen', stroke };
      drawStrokes(penLayer.getContext('2d'), [stroke], ps);
      redraw();
    } else if (tool === 'crop') {
      const handle = cropHandleAt(p);
      const c = cropRect();
      if (handle) drag = { kind: 'crop-resize', handle, orig: { ...c } };
      else if (p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h) drag = { kind: 'crop-move', start: p, orig: { ...c } };
    } else if (tool === 'text') {
      if (selectedText) {
        const b = textBox(selectedText);
        const d = deleteBadge(b);
        if (Math.hypot(p.x - d.x, p.y - d.y) <= d.r + 3 * imagePerScreen()) {
          deleteSelectedText();
          return;
        }
        const tol = HANDLE_HIT * imagePerScreen();
        if (Math.abs(p.x - (b.x + b.w)) <= tol && Math.abs(p.y - (b.y + b.h)) <= tol) {
          // 右下の角：中心からの距離の比で文字を拡大・縮小する
          drag = { kind: 'text-size', text: selectedText, startDist: Math.hypot(p.x - selectedText.x, p.y - selectedText.y), origSize: selectedText.size };
          return;
        }
      }
      const hit = hitText(p);
      selectText(hit);
      if (hit) drag = { kind: 'text-move', text: hit, start: p, orig: { x: hit.x, y: hit.y }, moved: false };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    pointer = e;
    if (!baseFull || showOriginal) return;
    const p = pointerToImage(e);
    if (!drag) {
      updateCursor(p);
      drawOverlay();
      return;
    }
    if (drag.kind === 'pen') {
      const pts = drag.stroke.points;
      const last = pts[pts.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) < 0.5 * imagePerScreen()) return;
      pts.push([p.x, p.y]);
      // 描いている間は最後の区間だけ足す
      drawStrokes(penLayer.getContext('2d'), [{ ...drag.stroke, points: [last, [p.x, p.y]] }], ps);
      redraw();
    } else if (drag.kind === 'crop-move') {
      const [gw, gh] = geomSize();
      const o = drag.orig;
      state.crop = { x: clamp(o.x + p.x - drag.start.x, 0, gw - o.w), y: clamp(o.y + p.y - drag.start.y, 0, gh - o.h), w: o.w, h: o.h };
      redraw();
    } else if (drag.kind === 'crop-resize') {
      resizeCrop(p);
      redraw();
    } else if (drag.kind === 'text-move') {
      drag.text.x = drag.orig.x + p.x - drag.start.x;
      drag.text.y = drag.orig.y + p.y - drag.start.y;
      drag.moved = true;
      redraw();
    } else if (drag.kind === 'text-size') {
      const t = drag.text;
      const dist = Math.hypot(p.x - t.x, p.y - t.y);
      t.size = Math.max(8, (drag.origSize * dist) / Math.max(1, drag.startDist));
      showTextSize(t.size);
      redraw();
    }
  });

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === 'pen') renderPenLayer(); // なめらかな曲線で描き直す
    if (d.kind === 'text-move' && !d.moved) { redraw(); return; }
    redraw();
    commit();
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('pointerleave', () => {
    if (drag) return;
    pointer = null;
    drawOverlay();
  });

  function updateCursor(p) {
    const tool = getTool();
    if (tool === 'crop') {
      const h = cropHandleAt(p);
      const c = cropRect();
      const inside = p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
      stage.style.cursor = h ? HANDLE_CURSORS[h] : inside ? 'move' : 'default';
    } else if (tool === 'text') {
      if (selectedText) {
        const b = textBox(selectedText);
        const tol = HANDLE_HIT * imagePerScreen();
        const d = deleteBadge(b);
        if (Math.hypot(p.x - d.x, p.y - d.y) <= d.r + 3 * imagePerScreen()) { stage.style.cursor = 'pointer'; return; }
        if (Math.abs(p.x - (b.x + b.w)) <= tol && Math.abs(p.y - (b.y + b.h)) <= tol) { stage.style.cursor = 'nwse-resize'; return; }
      }
      stage.style.cursor = hitText(p) ? 'move' : 'default';
    }
  }

  window.addEventListener('keydown', (e) => {
    if (!baseFull) return;
    const typing = e.target.matches('input[type="text"], input[type="number"], textarea');
    const key = e.key.toLowerCase();
    if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && selectedText && getTool() === 'text') {
      e.preventDefault();
      deleteSelectedText();
    } else if (!typing && (e.metaKey || e.ctrlKey) && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (!typing && (e.metaKey || e.ctrlKey) && ((key === 'z' && e.shiftKey) || key === 'y')) {
      e.preventDefault();
      redo();
    } else if (e.key === 'Escape' && selectedText && !typing) {
      selectText(null);
    }
  });

  // ================= 履歴（編集内容の設定を丸ごと保存するので軽い） =================
  function commit() {
    const snap = JSON.stringify(state);
    if (history[historyIndex] === snap) return;
    history = history.slice(0, historyIndex + 1);
    history.push(snap);
    if (history.length > HISTORY_LIMIT) history.shift();
    historyIndex = history.length - 1;
    $('save-result').textContent = ''; // 前に保存したときの表示は、編集したら消す
    updateUI();
    updateSummary();
  }

  function restore(index) {
    historyIndex = index;
    const selectedId = selectedText && selectedText.id;
    state = JSON.parse(history[index]);
    selectText(state.texts.find((t) => t.id === selectedId) || null);
    syncPanels();
    renderPenLayer();
    redraw();
    renderFilterThumbs();
    updateUI();
    updateSummary();
  }
  const undo = () => { if (historyIndex > 0) restore(historyIndex - 1); };
  const redo = () => { if (historyIndex < history.length - 1) restore(historyIndex + 1); };

  function updateUI() {
    $('btn-undo').disabled = historyIndex <= 0;
    $('btn-redo').disabled = historyIndex >= history.length - 1;
  }
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-reset-all').addEventListener('click', () => {
    state = defaultState();
    selectText(null);
    syncPanels();
    renderPenLayer();
    redraw();
    renderFilterThumbs();
    commit();
  });

  // 設定の値をサイドバーの表示に反映する（元に戻すときなど）
  function syncPanels() {
    document.querySelectorAll('input[data-adj]').forEach((input) => {
      const v = state.adjust[input.dataset.adj];
      input.value = v;
      $(`v-${input.dataset.adj}`).textContent = v > 0 ? `+${v}` : v;
    });
    filterGrid.querySelectorAll('.filter-item').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.filter.id));
    $('filter-strength-row').classList.toggle('hidden', state.filter.id === 'none');
    $('filter-strength').value = state.filter.strength;
    $('v-strength').textContent = state.filter.strength;
    $('straighten').value = state.straighten;
    $('v-straighten').textContent = state.straighten > 0 ? `+${state.straighten}` : state.straighten;
  }

  // ================= 編集／元画像の切り替え =================
  const viewButtons = document.querySelectorAll('.view-switch button');
  function setView(v) {
    showOriginal = v === 'original';
    viewButtons.forEach((b) => {
      b.classList.toggle('active', b.dataset.view === v);
      b.setAttribute('aria-selected', String(b.dataset.view === v));
    });
    stage.classList.toggle('readonly', showOriginal);
    redraw();
  }
  viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // ================= 保存（元の解像度で作り直す） =================
  function outputFormat() {
    if (sourceType === 'image/jpeg' || /^image\/(hei[cf]|avif)$/.test(sourceType)) return { type: 'image/jpeg', ext: 'jpg' };
    const c = makeCanvas(1, 1);
    if (sourceType === 'image/webp' && c.toDataURL('image/webp').startsWith('data:image/webp')) return { type: 'image/webp', ext: 'webp' };
    return { type: 'image/png', ext: 'png' };
  }

  function renderFull() {
    const geom = drawGeometry(baseFull, 1);
    const gctx = geom.getContext('2d');
    const img = gctx.getImageData(0, 0, geom.width, geom.height);
    applyColor(img, state.adjust, state.filter);
    gctx.putImageData(img, 0, 0);
    const pen = makeCanvas(geom.width, geom.height);
    drawStrokes(pen.getContext('2d'), state.strokes, 1);
    gctx.drawImage(pen, 0, 0);
    pen.width = pen.height = 0;
    state.texts.forEach((t) => drawText(gctx, t, 1, 0, 0));

    const c = cropRect();
    const { type } = outputFormat();
    const out = makeCanvas(c.w, c.h);
    const octx = out.getContext('2d');
    // JPEGは透過非対応なので白背景で合成
    if (type === 'image/jpeg') {
      octx.fillStyle = '#fff';
      octx.fillRect(0, 0, out.width, out.height);
    }
    octx.drawImage(geom, c.x, c.y, c.w, c.h, 0, 0, out.width, out.height);
    geom.width = geom.height = 0;
    return out;
  }

  const formatBytes = (n) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1000))}KB` : `${(n / 1e6).toFixed(1)}MB`);
  const FORMAT_LABEL = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP' };
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  function ratioText(w, h) {
    const g = gcd(w, h);
    if (w / g <= 32 && h / g <= 32) return `${w / g}:${h / g}`;
    for (let b = 1; b <= 20; b++) {
      const a = Math.round((w / h) * b);
      if (a && Math.abs(a / b - w / h) / (w / h) < 0.01) return `約 ${a}:${b}`;
    }
    return `約 ${(w / h).toFixed(2)}:1`;
  }

  // ---- 保存される画像の要約（重さは実際に作って測り、ダウンロードにも使う） ----
  let estimate = null; // { key, blob, type, ext, w, h }
  let estimateTimer = 0;
  async function makeOutput() {
    const canvas = renderFull();
    const { type, ext } = outputFormat();
    const blob = await new Promise((res) => canvas.toBlob(res, type, JPEG_QUALITY));
    const out = { blob, type, ext, w: canvas.width, h: canvas.height };
    canvas.width = canvas.height = 0;
    return out;
  }

  function updateSummary() {
    if (!baseFull) return;
    const c = cropRect();
    const w = Math.round(c.w);
    const h = Math.round(c.h);
    $('sum-dim').textContent = `${w}×${h} px`;
    $('sum-ratio').textContent = ratioText(w, h);
    const key = history[historyIndex];
    clearTimeout(estimateTimer);
    if (estimate && estimate.key === key) { showEstimate(); return; }
    $('sum-size').textContent = '計算中…';
    estimateTimer = setTimeout(async () => {
      const out = await makeOutput();
      if (history[historyIndex] !== key) return; // 計算中に編集が進んだ
      estimate = { key, ...out };
      showEstimate();
    }, 700);
  }
  function showEstimate() {
    $('sum-size').textContent = `約 ${formatBytes(estimate.blob.size)}`;
    $('sum-format').textContent = `ファイル（${FORMAT_LABEL[estimate.type]}）`;
  }

  $('btn-download').addEventListener('click', async () => {
    if (!baseFull) return;
    clearTimeout(textTimer);
    commit(); // 入力途中の文字も含める
    const btn = $('btn-download');
    btn.disabled = true;
    const key = history[historyIndex];
    if (!estimate || estimate.key !== key) {
      $('save-result').textContent = '画像を作成しています…';
      estimate = { key, ...(await makeOutput()) };
      showEstimate();
    }
    btn.disabled = false;
    const { blob, ext, w, h } = estimate;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName}_edited.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $('save-result').textContent = `保存しました（${w}×${h} px・${formatBytes(blob.size)}）`;
  });

  // ================= 写真の入れ替え =================
  const confirmDiscard = () => historyIndex <= 0 || confirm('いまの編集内容は破棄されます。別の写真に入れ替えますか？');
  $('btn-new').addEventListener('click', () => { if (confirmDiscard()) fileInput.click(); });

  // 編集中の画像の上に写真をドロップすると入れ替える
  const workspace = $('workspace');
  const hasFiles = (e) => [...e.dataTransfer.types].includes('Files');
  workspace.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    workspace.classList.add('drop-replace');
  });
  workspace.addEventListener('dragleave', (e) => {
    if (!workspace.contains(e.relatedTarget)) workspace.classList.remove('drop-replace');
  });
  workspace.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    workspace.classList.remove('drop-replace');
    const file = e.dataTransfer.files[0];
    if (file && confirmDiscard()) loadFile(file);
  });

  window.addEventListener('resize', () => drawOverlay());
  onToolChange();
})();
