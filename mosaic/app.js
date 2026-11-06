(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ブラウザのキャンバス上限を超えないようにするための制限
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_AREA = 100_000_000;
  const MASK_MAX_SIDE = 2048; // 範囲（マスク）の解像度の上限。履歴のメモリを抑える
  const HISTORY_LIMIT = 30;
  const HANDLE_HIT = 12;      // つまみの当たり判定（画面px）
  const MIN_SHAPE = 4;        // これより小さいドラッグは図形にしない（画面px）
  const EFFECTS = ['mosaic', 'blur'];
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const HANDLE_CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  };

  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  const fileInfo = $('file-info');
  const toolHint = $('tool-hint');

  const stage = $('stage');
  const view = $('view');       // 合成結果（元画像の解像度）
  const overlay = $('overlay'); // 図形の枠・つまみ・ブラシの円（画面の解像度）

  const shapeType = $('shape-type');
  const brushInput = $('brush');
  const paintMode = $('paint-mode');
  const effectSel = $('effect');
  const blockInput = $('block');
  const blurInput = $('blur');

  const makeCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  let fileName = 'image';
  let sourceType = '';
  let src = null;     // 元画像
  let layer = null;   // 効果を範囲で切り抜くための作業用
  let ms = 1;         // 元画像px → マスクpx
  // 効果ごとの加工済み画像と、ブラシで塗った範囲
  const fx = Object.fromEntries(EFFECTS.map((name) => [name, { canvas: null, mask: null, painted: false }]));
  let eraseMask = null; // ブラシで「消す」をした範囲（図形・ブラシどちらの効果も消す）
  let combined = null;  // 合成用の作業マスク
  let before = [];      // 操作前のマスク（履歴用）
  let shapes = [];      // { type, effect, x, y, w, h }（元画像px）
  let selected = null;
  let undoStack = [];
  let redoStack = [];
  let action = null;
  let drag = null;
  let pointer = null;
  let showOriginal = false;
  let frame = 0;

  const masks = () => [...EFFECTS.map((name) => fx[name].mask), eraseMask];

  // ================= ファイル入力 =================
  ['dragenter', 'dragover'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    })
  );
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });
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
    const w = Math.max(1, Math.floor(iw * s));
    const h = Math.max(1, Math.floor(ih * s));

    src = makeCanvas(w, h);
    src.getContext('2d').drawImage(im, 0, 0, w, h);
    layer = makeCanvas(w, h);
    view.width = w;
    view.height = h;

    ms = Math.min(1, MASK_MAX_SIDE / Math.max(w, h));
    const mw = Math.max(1, Math.round(w * ms));
    const mh = Math.max(1, Math.round(h * ms));
    EFFECTS.forEach((name) => {
      fx[name].canvas = null;
      fx[name].mask = makeCanvas(mw, mh);
      fx[name].painted = false;
    });
    eraseMask = makeCanvas(mw, mh);
    combined = makeCanvas(mw, mh);
    before = masks().map(() => makeCanvas(mw, mh));

    // 強さの範囲と初期値を画像の大きさに合わせる
    const long = Math.max(w, h);
    blockInput.max = Math.max(8, Math.round(long / 10));
    blockInput.value = Math.max(4, Math.round(long / 80));
    blurInput.max = Math.max(8, Math.round(long / 15));
    blurInput.value = Math.max(4, Math.round(long / 100));
    updateStrengthUI();

    shapes = [];
    selected = null;
    undoStack = [];
    redoStack = [];
    fileInfo.textContent = `${file.name}（${iw} × ${ih} px）`;

    // ドロップ画面から、左に画像・右に設定の編集画面へ
    $('step-input').classList.add('hidden');
    $('workspace').classList.remove('hidden');
    $('side').classList.remove('hidden');
    document.body.classList.add('has-side');
    window.scrollTo(0, 0);

    setView('edit');
    updateUI();
    resizeOverlay();
  }

  // ================= 効果の生成と合成 =================
  function buildEffect(name) {
    const { width: w, height: h } = src;
    const c = fx[name].canvas || makeCanvas(w, h);
    fx[name].canvas = c;
    c.width = w; // クリアを兼ねる
    c.height = h;
    const ctx = c.getContext('2d');

    if (name === 'mosaic') {
      // 画像全体を 1/粗さ に縮小してから拡大し、マス目を作る（範囲が重なってもマス目がずれない）
      const bs = Number(blockInput.value);
      const sw = Math.max(1, Math.ceil(w / bs));
      const sh = Math.max(1, Math.ceil(h / bs));
      const small = makeCanvas(sw, sh);
      const sctx = small.getContext('2d');
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(src, 0, 0, w, h, 0, 0, w / bs, h / bs);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, sw * bs, sh * bs);
    } else {
      ctx.drawImage(smoothBlur(src, Number(blurInput.value)), 0, 0);
    }
  }

  // ---- ぼかし ----
  // ブラウザ標準のぼかし（ctx.filter）は強くすると元の模様が粒状に残るため自前で計算する。
  // 縮小した画像に本物のガウスぼかしをかけてから、段階的に拡大して戻す（どのブラウザでも同じ見た目）
  const BLUR_SIGMA_SMALL = 4; // 縮小後の画像でのぼかし半径（これ以上は縮小で稼ぐ）

  function smoothBlur(image, sigma) {
    const w = image.width;
    const h = image.height;
    const f = Math.max(1, sigma / BLUR_SIGMA_SMALL);
    const sw = Math.max(1, Math.round(w / f));
    const sh = Math.max(1, Math.round(h / f));

    const small = resizeStepwise(image, sw, sh);
    const sctx = small.getContext('2d');
    const img = sctx.getImageData(0, 0, sw, sh);
    gaussianBlur(img, sigma / f);
    sctx.putImageData(img, 0, 0);
    return resizeStepwise(small, w, h);
  }

  // 半分ずつ縮小（画素を平均する）／倍ずつ拡大（なめらかに補間する）して目標の大きさにする
  function resizeStepwise(image, tw, th) {
    let cur = image;
    for (;;) {
      const shrinking = cur.width > tw || cur.height > th;
      const nw = shrinking ? Math.max(tw, Math.ceil(cur.width / 2)) : Math.min(tw, cur.width * 2);
      const nh = shrinking ? Math.max(th, Math.ceil(cur.height / 2)) : Math.min(th, cur.height * 2);
      if (nw === cur.width && nh === cur.height) break;
      const next = makeCanvas(nw, nh);
      const nctx = next.getContext('2d');
      nctx.imageSmoothingEnabled = true;
      nctx.imageSmoothingQuality = 'high';
      nctx.drawImage(cur, 0, 0, nw, nh);
      cur = next;
    }
    if (cur === image) {
      cur = makeCanvas(tw, th);
      cur.getContext('2d').drawImage(image, 0, 0);
    }
    return cur;
  }

  // 箱型ぼかしを3回重ねてガウスぼかしを近似する（端は端の色を延ばす。途中は小数で持って縞を防ぐ）
  function gaussianBlur(img, sigma) {
    const { width: w, height: h, data } = img;
    const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    let a = Float32Array.from(data);
    let b = new Float32Array(data.length);
    for (let pass = 0; pass < 3; pass++) {
      boxBlur(a, b, w, h, r, 4, w * 4); // 横方向
      boxBlur(b, a, h, w, r, w * 4, 4); // 縦方向
    }
    data.set(a);
  }

  // step: 隣の画素までの距離, lineStep: 次の行（列）までの距離, len: 1行の画素数, lines: 行数
  function boxBlur(src, dst, len, lines, r, step, lineStep) {
    const div = 2 * r + 1;
    for (let line = 0; line < lines; line++) {
      const base = line * lineStep;
      for (let c = 0; c < 4; c++) {
        const at = (i) => src[base + Math.min(Math.max(i, 0), len - 1) * step + c];
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += at(i);
        for (let i = 0; i < len; i++) {
          dst[base + i * step + c] = sum / div;
          sum += at(i + r + 1) - at(i - r);
        }
      }
    }
  }

  const effectUsed = (name) => fx[name].painted || shapes.some((s) => s.effect === name);

  function shapePath(ctx, s, k) {
    ctx.beginPath();
    if (s.type === 'rect') ctx.rect(s.x * k, s.y * k, s.w * k, s.h * k);
    else ctx.ellipse((s.x + s.w / 2) * k, (s.y + s.h / 2) * k, (s.w / 2) * k, (s.h / 2) * k, 0, 0, Math.PI * 2);
  }

  // その効果をかける範囲 = ブラシで塗った範囲 + 図形 − 消した範囲
  function effectMask(name) {
    const ctx = combined.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, combined.width, combined.height);
    ctx.drawImage(fx[name].mask, 0, 0);
    ctx.fillStyle = '#000';
    shapes.filter((s) => s.effect === name).forEach((s) => {
      shapePath(ctx, s, ms);
      ctx.fill();
    });
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(eraseMask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return combined;
  }

  function redraw() {
    const ctx = view.getContext('2d');
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(src, 0, 0);
    if (showOriginal) return;
    const lctx = layer.getContext('2d');
    for (const name of EFFECTS) {
      if (!effectUsed(name)) continue;
      if (!fx[name].canvas) buildEffect(name);
      lctx.globalCompositeOperation = 'source-over';
      lctx.clearRect(0, 0, layer.width, layer.height);
      lctx.drawImage(fx[name].canvas, 0, 0);
      lctx.globalCompositeOperation = 'destination-in';
      lctx.imageSmoothingEnabled = true;
      lctx.drawImage(effectMask(name), 0, 0, layer.width, layer.height);
      lctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(layer, 0, 0);
    }
  }

  const requestRedraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      redraw();
    });
  };

  // 強さのスライダー（動かしている間は1フレームに1回だけ作り直す）
  let rebuildFrame = 0;
  function onStrength(name) {
    updateStrengthUI();
    if (!src || !fx[name].canvas) return;
    cancelAnimationFrame(rebuildFrame);
    rebuildFrame = requestAnimationFrame(() => {
      buildEffect(name);
      redraw();
    });
  }
  blockInput.addEventListener('input', () => onStrength('mosaic'));
  blurInput.addEventListener('input', () => onStrength('blur'));

  function updateStrengthUI() {
    $('block-val').textContent = blockInput.value;
    $('blur-val').textContent = blurInput.value;
    $('block-row').classList.toggle('hidden', effectSel.value !== 'mosaic');
    $('blur-row').classList.toggle('hidden', effectSel.value !== 'blur');
  }

  // ================= 道具・設定の UI =================
  const getTool = () => document.querySelector('input[name="tool"]:checked').value;
  const erasing = () => paintMode.value === 'erase';
  const effectLabel = () => (effectSel.value === 'blur' ? 'ぼかし' : 'モザイク');

  function updateToolUI() {
    const tool = getTool();
    $('shape-fields').classList.toggle('hidden', tool !== 'shape');
    $('brush-fields').classList.toggle('hidden', tool !== 'brush');
    if (tool !== 'shape') selected = null;
    if (tool === 'brush') {
      toolHint.textContent = erasing()
        ? '画像の上をなぞった部分の加工を消します（図形の部分も消せます）。'
        : `画像の上をなぞった部分に${effectLabel()}をかけます。`;
    } else {
      toolHint.textContent = `ドラッグで${shapeType.value === 'rect' ? '四角' : '楕円'}の${effectLabel()}を追加。図形を選ぶと角や辺で大きさを変えられます。`;
    }
    stage.style.cursor = tool === 'brush' ? 'none' : 'crosshair';
    updateUI();
    drawOverlay();
  }
  document.querySelectorAll('input[name="tool"]').forEach((r) => r.addEventListener('change', updateToolUI));
  paintMode.addEventListener('change', updateToolUI);

  // 鉛筆（かける）・消しゴム（消す）の丸ボタン
  const roundTools = document.querySelectorAll('.round-tool');
  const syncRoundTools = () => roundTools.forEach((b) => {
    const on = b.dataset.mode === paintMode.value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  roundTools.forEach((b) => b.addEventListener('click', () => {
    if (paintMode.value === b.dataset.mode) return;
    paintMode.value = b.dataset.mode;
    paintMode.dispatchEvent(new Event('change'));
  }));
  paintMode.addEventListener('change', syncRoundTools);
  syncRoundTools();
  brushInput.addEventListener('input', () => {
    $('brush-val').textContent = brushInput.value;
    drawOverlay();
  });

  // 図形を選んでいるときは、形・効果の変更をその図形に反映する
  function editSelected(apply) {
    if (!selected) return;
    beginAction();
    apply(selected);
    commitAction(null);
    redraw();
    drawOverlay();
  }
  shapeType.addEventListener('change', () => {
    editSelected((s) => { s.type = shapeType.value; });
    updateToolUI();
  });
  effectSel.addEventListener('change', () => {
    editSelected((s) => { s.effect = effectSel.value; });
    updateStrengthUI();
    updateToolUI();
  });

  // ---- 形のパレット ----
  const palette = $('shape-palette');
  const tiles = palette.querySelectorAll('.shape-tile');
  const syncTiles = () => tiles.forEach((t) => t.classList.toggle('active', t.dataset.shape === shapeType.value));
  shapeType.addEventListener('input', syncTiles);
  shapeType.addEventListener('change', syncTiles);
  syncTiles();

  let paletteDrag = null; // { type, x0, y0, moved, ghost, rect }
  const DRAG_START = 5;   // これ以上動いたらクリックではなくドラッグ（画面px）

  // ドロップ位置を中心に、画像の短い辺の3割の大きさで置く
  function dropRect(p) {
    const size = Math.max(4, Math.min(view.width, view.height) * 0.3);
    return {
      x: clamp(p.x - size / 2, 0, view.width - size),
      y: clamp(p.y - size / 2, 0, view.height - size),
      w: size,
      h: size,
    };
  }

  function overView(e) {
    const r = view.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }

  tiles.forEach((tile) => {
    tile.addEventListener('pointerdown', (e) => {
      if (!src || e.button > 0) return;
      tile.setPointerCapture(e.pointerId);
      paletteDrag = { type: tile.dataset.shape, x0: e.clientX, y0: e.clientY, moved: false, ghost: null, rect: null };
    });
    tile.addEventListener('pointermove', (e) => {
      const d = paletteDrag;
      if (!d) return;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_START) return;
      if (!d.moved) {
        d.moved = true;
        setView('edit');
        d.ghost = document.createElement('div');
        d.ghost.className = `shape-ghost ${d.type}`;
        document.body.appendChild(d.ghost);
      }
      const inside = overView(e);
      // 画像の上では実際の大きさの枠で、外では小さな影で位置を示す
      d.ghost.classList.toggle('hidden', inside);
      d.ghost.style.left = `${e.clientX}px`;
      d.ghost.style.top = `${e.clientY}px`;
      d.rect = inside ? dropRect(pointerToImage(e)) : null;
      drawOverlay();
    });
    const finish = (e, cancelled) => {
      const d = paletteDrag;
      if (!d) return;
      paletteDrag = null;
      if (d.ghost) d.ghost.remove();
      if (!d.moved) {
        // ただのクリックは形の選択
        shapeType.value = d.type;
        shapeType.dispatchEvent(new Event('change'));
      } else if (!cancelled && d.rect) {
        shapeType.value = d.type;
        shapeType.dispatchEvent(new Event('input'));
        beginAction();
        addShape(d.type, d.rect);
        redraw();
        updateToolUI();
      }
      drawOverlay();
    };
    tile.addEventListener('pointerup', (e) => finish(e, false));
    tile.addEventListener('pointercancel', (e) => finish(e, true));
  });

  function select(shape) {
    selected = shape;
    if (shape) {
      // 選んだ図形の設定をサイドバーに表示（change は発火させず、ボタン表示だけ合わせる）
      shapeType.value = shape.type;
      effectSel.value = shape.effect;
      shapeType.dispatchEvent(new Event('input'));
      effectSel.dispatchEvent(new Event('input'));
      updateStrengthUI();
    }
    updateUI();
  }

  // ================= 座標 =================
  const imagePerScreen = () => view.width / view.getBoundingClientRect().width;

  function pointerToImage(e) {
    const r = view.getBoundingClientRect();
    const k = view.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }

  const handlePoint = (s, h) => ({
    x: h.includes('w') ? s.x : h.includes('e') ? s.x + s.w : s.x + s.w / 2,
    y: h.includes('n') ? s.y : h.includes('s') ? s.y + s.h : s.y + s.h / 2,
  });

  function hitHandle(s, p) {
    const tol = HANDLE_HIT * imagePerScreen();
    return HANDLES.find((h) => {
      const q = handlePoint(s, h);
      return Math.abs(q.x - p.x) <= tol && Math.abs(q.y - p.y) <= tol;
    }) || null;
  }

  // 選択中の図形の右上の外側に出す「×」（画像からはみ出す場合は内側に寄せる）
  const DELETE_RADIUS = 11; // 画面px
  function deleteBadge(s) {
    const k = imagePerScreen();
    const r = DELETE_RADIUS * k;
    return {
      x: clamp(s.x + s.w + 16 * k, r, view.width - r),
      y: clamp(s.y - 16 * k, r, view.height - r),
      r,
    };
  }

  function hitDelete(s, p) {
    const b = deleteBadge(s);
    return Math.hypot(p.x - b.x, p.y - b.y) <= b.r + 2 * imagePerScreen();
  }

  function hitShape(p) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.type === 'rect') {
        if (p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h) return s;
      } else {
        const dx = (p.x - (s.x + s.w / 2)) / (s.w / 2);
        const dy = (p.y - (s.y + s.h / 2)) / (s.h / 2);
        if (dx * dx + dy * dy <= 1) return s;
      }
    }
    return null;
  }

  // 2点から、画像からはみ出さない矩形を作る
  function rectFrom(a, b) {
    const x1 = clamp(Math.min(a.x, b.x), 0, view.width);
    const y1 = clamp(Math.min(a.y, b.y), 0, view.height);
    const x2 = clamp(Math.max(a.x, b.x), 0, view.width);
    const y2 = clamp(Math.max(a.y, b.y), 0, view.height);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // ================= 操作 =================
  stage.addEventListener('pointerdown', (e) => {
    if (!src || showOriginal || e.button > 0) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    const p = pointerToImage(e);
    pointer = e;
    if (getTool() === 'shape' && selected && hitDelete(selected, p)) {
      deleteSelected();
      return;
    }
    beginAction();

    if (getTool() === 'brush') {
      drag = { kind: 'brush', last: p, box: { x1: p.x, y1: p.y, x2: p.x, y2: p.y } };
      paintStroke(p, p);
    } else {
      const handle = selected && hitHandle(selected, p);
      const hit = handle ? selected : hitShape(p);
      if (handle) {
        drag = { kind: 'resize', handle, orig: { ...selected } };
      } else if (hit) {
        select(hit);
        drag = { kind: 'move', start: p, orig: { ...hit } };
      } else {
        select(null);
        drag = { kind: 'new', start: p, now: p };
      }
    }
    drawOverlay();
  });

  stage.addEventListener('pointermove', (e) => {
    pointer = e;
    if (showOriginal) return;
    const p = pointerToImage(e);
    if (!drag) {
      updateHoverCursor(p);
      drawOverlay();
      return;
    }
    if (drag.kind === 'brush') {
      paintStroke(drag.last, p);
      drag.last = p;
    } else if (drag.kind === 'new') {
      drag.now = p;
    } else if (drag.kind === 'move') {
      const o = drag.orig;
      selected.x = clamp(o.x + p.x - drag.start.x, 0, view.width - o.w);
      selected.y = clamp(o.y + p.y - drag.start.y, 0, view.height - o.h);
      requestRedraw();
    } else if (drag.kind === 'resize') {
      resizeSelected(p);
      requestRedraw();
    }
    drawOverlay();
  });

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.kind === 'brush') {
      commitAction(toMaskRegion(d.box, brushRadius()));
    } else if (d.kind === 'new') {
      const r = rectFrom(d.start, d.now);
      const minImg = MIN_SHAPE * imagePerScreen();
      if (r.w < minImg || r.h < minImg) {
        action = null; // クリックだけ・小さすぎる範囲は図形にしない
      } else {
        addShape(shapeType.value, r);
      }
    } else {
      commitAction(null);
    }
    redraw();
    updateUI();
    drawOverlay();
  }
  // beginAction() 済みの状態で呼ぶ
  function addShape(type, r) {
    const s = { type, effect: effectSel.value, ...r };
    shapes.push(s);
    // 新しい図形は、以前ブラシで消した範囲より上にくる
    const ctx = eraseMask.getContext('2d');
    ctx.globalCompositeOperation = 'destination-out';
    shapePath(ctx, s, ms);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    select(s);
    commitAction(toMaskRegion({ x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h }, 0));
  }

  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('pointerleave', () => {
    if (drag) return;
    pointer = null;
    drawOverlay();
  });

  function updateHoverCursor(p) {
    if (getTool() === 'brush') return;
    if (selected && hitDelete(selected, p)) {
      stage.style.cursor = 'pointer';
      return;
    }
    const handle = selected && hitHandle(selected, p);
    stage.style.cursor = handle ? HANDLE_CURSORS[handle] : hitShape(p) ? 'move' : 'crosshair';
  }

  // つまんだ角・辺だけを動かす（反対側を越えたら裏返す）
  function resizeSelected(p) {
    const o = drag.orig;
    const h = drag.handle;
    let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
    if (h.includes('w')) x1 = p.x;
    if (h.includes('e')) x2 = p.x;
    if (h.includes('n')) y1 = p.y;
    if (h.includes('s')) y2 = p.y;
    const r = rectFrom({ x: x1, y: y1 }, { x: x2, y: y2 });
    Object.assign(selected, { x: r.x, y: r.y, w: Math.max(r.w, 1), h: Math.max(r.h, 1) });
  }

  const brushRadius = () => (Number(brushInput.value) / 2) * imagePerScreen();

  // ブラシ：選んだ効果の範囲に塗る（他の効果と「消した範囲」からは取り除く）。消すときは消した範囲に塗る
  function paintStroke(a, b) {
    const r = brushRadius();
    const box = drag.box;
    box.x1 = Math.min(box.x1, b.x); box.y1 = Math.min(box.y1, b.y);
    box.x2 = Math.max(box.x2, b.x); box.y2 = Math.max(box.y2, b.y);

    const stroke = (canvas, op) => {
      const ctx = canvas.getContext('2d');
      ctx.globalCompositeOperation = op;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = r * 2 * ms;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x * ms, a.y * ms);
      ctx.lineTo(b.x * ms + (a.x === b.x && a.y === b.y ? 0.01 : 0), b.y * ms);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    };

    if (erasing()) {
      stroke(eraseMask, 'source-over');
    } else {
      const target = effectSel.value;
      fx[target].painted = true;
      stroke(fx[target].mask, 'source-over');
      EFFECTS.filter((n) => n !== target).forEach((n) => stroke(fx[n].mask, 'destination-out'));
      stroke(eraseMask, 'destination-out');
    }
    requestRedraw();
  }

  // ================= 履歴 =================
  // マスクは変更された範囲だけを保存してメモリを抑える
  function toMaskRegion(box, pad) {
    const mw = eraseMask.width;
    const mh = eraseMask.height;
    const x1 = clamp(Math.floor((box.x1 - pad) * ms) - 2, 0, mw);
    const y1 = clamp(Math.floor((box.y1 - pad) * ms) - 2, 0, mh);
    const x2 = clamp(Math.ceil((box.x2 + pad) * ms) + 2, 0, mw);
    const y2 = clamp(Math.ceil((box.y2 + pad) * ms) + 2, 0, mh);
    return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
  }

  const crop = (list, r) => list.map((m) => {
    const c = makeCanvas(r.w, r.h);
    c.getContext('2d').drawImage(m, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return c;
  });

  function beginAction() {
    masks().forEach((m, i) => {
      const ctx = before[i].getContext('2d');
      ctx.clearRect(0, 0, m.width, m.height);
      ctx.drawImage(m, 0, 0);
    });
    action = { shapes: JSON.stringify(shapes) };
  }

  function commitAction(region) {
    if (!action) return;
    const entry = { shapes: action.shapes, region, masks: region ? crop(before, region) : null };
    action = null;
    if (!region && entry.shapes === JSON.stringify(shapes)) return; // 何も変わっていない
    undoStack.push(entry);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateUI();
  }

  const capture = (region) => ({
    shapes: JSON.stringify(shapes),
    region,
    masks: region ? crop(masks(), region) : null,
  });

  function applyEntry(entry) {
    shapes = JSON.parse(entry.shapes);
    selected = null;
    if (entry.region) {
      const r = entry.region;
      masks().forEach((m, i) => {
        const ctx = m.getContext('2d');
        ctx.clearRect(r.x, r.y, r.w, r.h);
        ctx.drawImage(entry.masks[i], r.x, r.y);
      });
      EFFECTS.forEach((n) => { fx[n].painted = true; });
    }
    redraw();
    updateUI();
    drawOverlay();
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return;
    redoStack.push(capture(entry.region));
    applyEntry(entry);
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) return;
    undoStack.push(capture(entry.region));
    applyEntry(entry);
  }

  function deleteSelected() {
    if (!selected) return;
    beginAction();
    shapes = shapes.filter((s) => s !== selected);
    selected = null;
    commitAction(null);
    redraw();
    drawOverlay();
  }

  function updateUI() {
    $('btn-undo').disabled = !undoStack.length;
    $('btn-redo').disabled = !redoStack.length;
  }

  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-clear').addEventListener('click', () => {
    beginAction();
    masks().forEach((m) => m.getContext('2d').clearRect(0, 0, m.width, m.height));
    shapes = [];
    selected = null;
    commitAction({ x: 0, y: 0, w: eraseMask.width, h: eraseMask.height });
    EFFECTS.forEach((n) => { fx[n].painted = false; });
    redraw();
    drawOverlay();
  });

  window.addEventListener('keydown', (e) => {
    if (!src || e.target.matches('input[type="text"], input[type="number"]')) return;
    const key = e.key.toLowerCase();
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === 'Escape' && selected) {
      select(null);
      drawOverlay();
    } else if ((e.metaKey || e.ctrlKey) && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((e.metaKey || e.ctrlKey) && ((key === 'z' && e.shiftKey) || key === 'y')) {
      e.preventDefault();
      redo();
    }
  });

  // ================= 編集／元画像の切り替え =================
  const viewButtons = document.querySelectorAll('.view-switch button');
  function setView(v) {
    showOriginal = v === 'original';
    viewButtons.forEach((b) => {
      b.classList.toggle('active', b.dataset.view === v);
      b.setAttribute('aria-selected', String(b.dataset.view === v));
    });
    // 元画像の表示中は画像の上での操作を受け付けない
    stage.classList.toggle('readonly', showOriginal);
    if (!src) return;
    redraw();
    drawOverlay();
  }
  viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // ================= ガイド表示（図形の枠・つまみ・ブラシの円） =================
  function resizeOverlay() {
    const r = view.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(r.width * dpr);
    overlay.height = Math.round(r.height * dpr);
    drawOverlay();
  }
  new ResizeObserver(resizeOverlay).observe(view);

  function drawOverlay() {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!src || showOriginal) return;
    const dpr = window.devicePixelRatio || 1;
    const k = overlay.width / view.width; // 元画像px → ガイドpx
    const outline = (path, strong) => {
      ctx.lineWidth = (strong ? 3 : 2.5) * dpr;
      ctx.strokeStyle = 'rgba(0, 0, 0, .55)';
      ctx.setLineDash([]);
      path();
      ctx.stroke();
      ctx.lineWidth = (strong ? 1.5 : 1) * dpr;
      ctx.strokeStyle = strong ? '#fff' : 'rgba(255, 255, 255, .8)';
      ctx.setLineDash(strong ? [] : [6 * dpr, 4 * dpr]);
      path();
      ctx.stroke();
      ctx.setLineDash([]);
    };

    if (getTool() === 'shape') {
      // 図形の位置がわかるよう、すべての図形に点線の枠を出す
      shapes.forEach((s) => outline(() => shapePath(ctx, s, k), s === selected));
      if (selected) {
        const s = selected;
        ctx.strokeStyle = 'rgba(255, 255, 255, .7)';
        ctx.lineWidth = dpr;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        if (s.type === 'ellipse') ctx.strokeRect(s.x * k, s.y * k, s.w * k, s.h * k);
        ctx.setLineDash([]);
        const size = 10 * dpr;
        HANDLES.forEach((h) => {
          const q = handlePoint(s, h);
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 2 * dpr;
          ctx.fillRect(q.x * k - size / 2, q.y * k - size / 2, size, size);
          ctx.strokeRect(q.x * k - size / 2, q.y * k - size / 2, size, size);
        });
      }
      if (selected) {
        const d = deleteBadge(selected);
        const cx = d.x * k;
        const cy = d.y * k;
        const r = DELETE_RADIUS * dpr;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = '#dc2626';
        ctx.fill();
        ctx.lineWidth = 2 * dpr;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        const a = r * 0.4;
        ctx.beginPath();
        ctx.moveTo(cx - a, cy - a); ctx.lineTo(cx + a, cy + a);
        ctx.moveTo(cx + a, cy - a); ctx.lineTo(cx - a, cy + a);
        ctx.stroke();
      }
      if (paletteDrag && paletteDrag.rect) {
        outline(() => shapePath(ctx, { type: paletteDrag.type, ...paletteDrag.rect }, k), true);
      }
      if (drag && drag.kind === 'new') {
        const r = rectFrom(drag.start, drag.now);
        outline(() => shapePath(ctx, { type: shapeType.value, ...r }, k), true);
      }
    } else if (pointer) {
      const r = view.getBoundingClientRect();
      const x = (pointer.clientX - r.left) * dpr;
      const y = (pointer.clientY - r.top) * dpr;
      outline(() => {
        ctx.beginPath();
        ctx.arc(x, y, (Number(brushInput.value) / 2) * dpr, 0, Math.PI * 2);
      }, true);
    }
  }

  // ================= 出力 =================
  // 保存形式は元の画像に合わせる（JPEG・WebP はそのまま、写真形式の HEIC・AVIF は JPEG、それ以外は PNG）
  const JPEG_QUALITY = 0.92;
  const canWebp = () => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL('image/webp').startsWith('data:image/webp');
  };
  function outputFormat(mime) {
    if (mime === 'image/jpeg' || /^image\/(hei[cf]|avif)$/.test(mime)) return { type: 'image/jpeg', ext: 'jpg' };
    if (mime === 'image/webp' && canWebp()) return { type: 'image/webp', ext: 'webp' };
    return { type: 'image/png', ext: 'png' };
  }

  $('btn-download').addEventListener('click', () => {
    if (!src) return;
    const viewingOriginal = showOriginal;
    showOriginal = false;
    redraw();
    const { type, ext } = outputFormat(sourceType);
    let canvas = view;

    // JPEGは透過非対応なので白背景で合成
    if (type === 'image/jpeg') {
      canvas = makeCanvas(view.width, view.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(view, 0, 0);
    }

    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${fileName}_mosaic.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, type, JPEG_QUALITY);
    // toBlob は呼んだ時点の内容を書き出すので、すぐ表示を戻してよい
    if (viewingOriginal) {
      showOriginal = true;
      redraw();
    }
  });

  const confirmDiscard = () => !undoStack.length || confirm('いまの編集内容は破棄されます。別の写真に入れ替えますか？');

  $('btn-new').addEventListener('click', () => {
    if (confirmDiscard()) fileInput.click();
  });

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

  updateStrengthUI();
  updateToolUI();
})();
