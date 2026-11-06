(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  const fileInfo = $('file-info');

  const stepSettings = $('step-settings');
  const stepInput = $('step-input');
  const workspace = $('workspace');

  const outW = $('out-w');
  const outH = $('out-h');
  const ratioW = $('ratio-w');
  const ratioH = $('ratio-h');
  const pixelFields = $('pixel-fields');
  const ratioFields = $('ratio-fields');
  const freeNote = $('free-note');
  const cropHint = $('crop-hint');

  const stage = $('stage');
  const img = $('src-img');
  const cropBox = $('crop-box');
  const cropInfo = $('crop-info');

  const preview = $('preview');
  const outputInfo = $('output-info');

  const MIN_DISPLAY_SIZE = 24; // 枠の最小サイズ（表示上のpx）
  const LOUPE_SIZE = 180;      // ルーペの表示サイズ（px）
  const LOUPE_ZOOM = 4;        // 画面表示に対する拡大率
  const LOUPE_MAX_PX = 12;     // 元画像1pxあたりの最大表示px

  const loupe = $('loupe');

  let fileName = 'image';
  let sourceType = '';
  // 切り取り範囲（元画像のピクセル座標）
  let crop = { x: 0, y: 0, w: 0, h: 0 };
  let drag = null;
  let previewTimer = null;

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
  });
  // ページ全体へのドロップでブラウザが画像を開いてしまうのを防ぐ
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  function loadFile(file) {
    if (!file.type.startsWith('image/')) {
      alert('画像ファイルを選択してください。');
      return;
    }
    fileName = file.name.replace(/\.[^.]+$/, '') || 'image';
    sourceType = file.type;
    const url = URL.createObjectURL(file);
    img.onload = () => {
      fileInfo.textContent = `${file.name}（${img.naturalWidth} × ${img.naturalHeight} px）`;
      $('save-result').textContent = '';
      // ドロップ画面から、左に作業領域・右に設定の編集画面へ
      stepInput.classList.add('hidden');
      workspace.classList.remove('hidden');
      stepSettings.classList.remove('hidden');
      document.body.classList.add('has-side');
      setView('edit');
      applyOriginalRatio(); // 「元の写真と同じ」なら、新しい写真の比率にする
      resetCrop();
      window.scrollTo(0, 0);
    };
    img.onerror = () => alert('画像を読み込めませんでした。');
    if (img.src) URL.revokeObjectURL(img.src);
    img.src = url;
  }

  // ================= 編集／プレビューの切り替え =================
  const viewButtons = document.querySelectorAll('.view-switch button');
  function setView(view) {
    viewButtons.forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
      b.setAttribute('aria-selected', String(b.dataset.view === view));
    });
    $('view-edit').classList.toggle('hidden', view !== 'edit');
    $('view-preview').classList.toggle('hidden', view !== 'preview');
    // 非表示の間は枠の表示位置を計算できないので、編集に戻ったときに描き直す
    if (view === 'edit') render();
    else drawOutput();
  }
  viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // ================= 出力設定 =================
  const getMode = () => document.querySelector('input[name="mode"]:checked').value;

  function getRatio() {
    let w, h;
    if (getMode() === 'free') return null;
    if (getMode() === 'pixel') {
      w = parseFloat(outW.value);
      h = parseFloat(outH.value);
    } else if (followOriginal && img.naturalWidth) {
      // 「元の写真と同じ」は表示用に短い比へ丸めているので、計算には写真の正確な比を使う
      w = img.naturalWidth;
      h = img.naturalHeight;
    } else {
      w = parseFloat(ratioW.value);
      h = parseFloat(ratioH.value);
    }
    if (!(w > 0) || !(h > 0)) return null;
    return w / h;
  }

  function getOutputSize() {
    if (getMode() === 'pixel') {
      const w = Math.round(parseFloat(outW.value));
      const h = Math.round(parseFloat(outH.value));
      if (!(w > 0) || !(h > 0)) return null;
      return { w, h };
    }
    return { w: Math.max(1, Math.round(crop.w)), h: Math.max(1, Math.round(crop.h)) };
  }

  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener('change', () => {
      const mode = getMode();
      pixelFields.classList.toggle('hidden', mode !== 'pixel');
      ratioFields.classList.toggle('hidden', mode !== 'ratio');
      freeNote.classList.toggle('hidden', mode !== 'free');
      $('size-opt').classList.toggle('hidden', mode === 'pixel');
      stage.classList.toggle('free', mode === 'free');
      cropHint.textContent = mode === 'free'
        ? '画像上をドラッグで範囲を指定。枠をドラッグで移動、四隅・各辺をドラッグでサイズを自由に変更'
        : '枠をドラッグで移動、四隅をドラッグで拡大・縮小（比率は固定）';
      resetCrop();
    })
  );
  [outW, outH, ratioW, ratioH].forEach((el) => el.addEventListener('input', resetCrop));

  // ---- ピクセル指定：よく使うサイズ・入れ替え・補足 ----
  const sizePreset = $('size-preset');
  const setPixels = (w, h) => {
    outW.value = w;
    outH.value = h;
    resetCrop();
    updatePixelUI();
  };
  sizePreset.addEventListener('change', () => {
    if (sizePreset.value === 'custom') {
      outW.focus();
      return;
    }
    const [w, h] = sizePreset.value.split('x').map(Number);
    setPixels(w, h);
  });
  $('swap-wh').addEventListener('click', () => setPixels(outH.value, outW.value));
  [outW, outH].forEach((el) => el.addEventListener('input', updatePixelUI));

  const gcd = (a, b) => (b ? gcd(b, a % b) : a);

  // ---- 縦横比：よく使う比率・入れ替え・補足 ----
  const ratioPreset = $('ratio-preset');
  let followOriginal = true; // 「元の写真と同じ」を選んでいる間は、写真を変えても比率を合わせ直す

  // 大きさを、一般的な短い整数の比にする（ぴったりにならなければ誤差 1% 以内の近い比）
  function simpleRatio(w, h) {
    const g = gcd(w, h);
    if (w / g <= 32 && h / g <= 32) return [w / g, h / g];
    for (let b = 1; b <= 20; b++) {
      const a = Math.round((w / h) * b);
      if (a && Math.abs(a / b - w / h) / (w / h) < 0.01) return [a, b];
    }
    return [Number((w / h).toFixed(2)), 1];
  }

  const setRatio = (w, h) => {
    ratioW.value = w;
    ratioH.value = h;
    resetCrop();
    updateRatioUI();
  };
  function applyOriginalRatio() {
    if (!followOriginal || !img.naturalWidth) return;
    const [w, h] = simpleRatio(img.naturalWidth, img.naturalHeight);
    ratioW.value = w;
    ratioH.value = h;
  }
  ratioPreset.addEventListener('change', () => {
    followOriginal = ratioPreset.value === 'original';
    if (ratioPreset.value === 'custom') {
      ratioW.focus();
      return;
    }
    if (followOriginal) {
      applyOriginalRatio();
      resetCrop();
      updateRatioUI();
      return;
    }
    const [w, h] = ratioPreset.value.split(':').map(Number);
    setRatio(w, h);
  });
  $('swap-ratio').addEventListener('click', () => {
    followOriginal = false;
    setRatio(ratioH.value, ratioW.value);
  });
  [ratioW, ratioH].forEach((el) => el.addEventListener('input', () => {
    followOriginal = false;
    updateRatioUI();
  }));

  function updateRatioUI() {
    const w = parseFloat(ratioW.value);
    const h = parseFloat(ratioH.value);
    ratioW.classList.toggle('invalid', !(w > 0));
    ratioH.classList.toggle('invalid', !(h > 0));
    if (!followOriginal) {
      const match = [...ratioPreset.options].find((o) => o.value === `${w}:${h}`);
      ratioPreset.value = match ? match.value : 'custom';
    }
    const info = $('ratio-info');
    info.classList.toggle('warn-text', !(w > 0 && h > 0));
    if (!(w > 0 && h > 0)) {
      info.textContent = '横と縦には 0 より大きい数値を入れてください。';
      return;
    }
    info.textContent = crop.w
      ? `出力は切り取った範囲の元の解像度のまま（いまは ${Math.round(crop.w)}×${Math.round(crop.h)} px）`
      : '出力は切り取った範囲の元の解像度のまま保存されます。';
  }
  // 入力に合わせて、よく使うサイズの表示・縦横比・拡大か縮小かを更新する
  function updatePixelUI() {
    const w = Math.round(parseFloat(outW.value));
    const h = Math.round(parseFloat(outH.value));
    const ok = w > 0 && h > 0;
    outW.classList.toggle('invalid', !(w > 0));
    outH.classList.toggle('invalid', !(h > 0));
    const match = [...sizePreset.options].find((o) => o.value === `${w}x${h}`);
    sizePreset.value = match ? match.value : 'custom';

    const info = $('px-info');
    info.classList.remove('warn-text');
    if (!ok) {
      info.textContent = '幅と高さには 1 以上の数値を入れてください。';
      info.classList.add('warn-text');
      return;
    }
    const g = gcd(w, h);
    const ratio = w / g <= 32 && h / g <= 32 ? `${w / g}:${h / g}` : `約 ${(w / h).toFixed(2)}:1`;
    let size = '';
    if (crop.w) {
      const cw = Math.round(crop.w);
      const ch = Math.round(crop.h);
      if (w > cw * 1.01) {
        size = `切り取った範囲（${cw}×${ch}）を拡大して保存。画質が粗くなります`;
        info.classList.add('warn-text');
      } else if (w < cw * 0.99) {
        size = `切り取った範囲（${cw}×${ch}）を縮小して保存`;
      } else {
        size = '切り取った範囲をそのままの大きさで保存';
      }
    }
    info.textContent = `縦横比 ${ratio}${size ? ' ・ ' + size : ''}`;
  }
  // 初期選択（自由）の表示を反映
  document.querySelector('input[name="mode"]:checked').dispatchEvent(new Event('change'));

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

  // ================= 切り取り枠 =================
  const scale = () => img.clientWidth / img.naturalWidth; // 元画像px → 表示px

  // 比率を保ったまま画像に収まる最大の枠を中央に配置（自由モードは画像全体）
  function resetCrop() {
    if (!img.naturalWidth) return;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const ratio = getMode() === 'free' ? iw / ih : getRatio();
    if (!ratio) return;
    let w = iw;
    let h = w / ratio;
    if (h > ih) {
      h = ih;
      w = h * ratio;
    }
    crop = { x: (iw - w) / 2, y: (ih - h) / 2, w, h };
    render();
  }

  function render() {
    const s = scale();
    cropBox.style.left = `${crop.x * s}px`;
    cropBox.style.top = `${crop.y * s}px`;
    cropBox.style.width = `${crop.w * s}px`;
    cropBox.style.height = `${crop.h * s}px`;
    cropInfo.textContent =
      `切り取り範囲: ${Math.round(crop.w)} × ${Math.round(crop.h)} px` +
      `（位置 ${Math.round(crop.x)}, ${Math.round(crop.y)}）`;
    if (getMode() === 'pixel') updatePixelUI();
    if (getMode() === 'ratio') updateRatioUI();
    updateSummary();
    schedulePreview();
  }

  // 表示座標 → 元画像座標
  function pointerToImage(e) {
    const rect = img.getBoundingClientRect();
    const s = scale();
    return { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s };
  }

  cropBox.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target.dataset.handle || null;
    const p = pointerToImage(e);
    drag = { handle, start: p, orig: { ...crop } };
    if (handle) {
      // 掴んだ角の対角を固定点にする
      drag.anchor = {
        x: handle.includes('w') ? crop.x + crop.w : crop.x,
        y: handle.includes('n') ? crop.y + crop.h : crop.y,
      };
    }
    cropBox.setPointerCapture(e.pointerId);
    if (handle) showLoupe(e);
  });

  cropBox.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pointerToImage(e);
    if (drag.handle && getMode() === 'free') resizeFree(p);
    else if (drag.handle) resizeTo(p);
    else moveBy(p.x - drag.start.x, p.y - drag.start.y);
    render();
    if (drag.handle) showLoupe(e);
  });

  const endDrag = () => { drag = null; hideLoupe(); };
  cropBox.addEventListener('pointerup', endDrag);
  cropBox.addEventListener('pointercancel', endDrag);

  // 自由モード：枠の外をドラッグして新しい範囲を描く
  stage.addEventListener('pointerdown', (e) => {
    if (getMode() !== 'free' || !img.naturalWidth) return;
    e.preventDefault();
    const p = clampPoint(pointerToImage(e));
    drag = { draw: true, start: p, orig: { ...crop } };
    stage.setPointerCapture(e.pointerId);
    showLoupe(e);
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag || !drag.draw) return;
    const p = clampPoint(pointerToImage(e));
    const { start } = drag;
    crop = {
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    };
    render();
    showLoupe(e);
  });

  const endDraw = () => {
    if (!drag || !drag.draw) return;
    // クリックだけ・小さすぎる範囲は元の枠に戻す
    const min = MIN_DISPLAY_SIZE / scale();
    if (crop.w < min || crop.h < min) {
      crop = drag.orig;
      render();
    }
    drag = null;
    hideLoupe();
  };
  stage.addEventListener('pointerup', endDraw);
  stage.addEventListener('pointercancel', endDraw);

  const clampPoint = (p) => ({
    x: clamp(p.x, 0, img.naturalWidth),
    y: clamp(p.y, 0, img.naturalHeight),
  });

  function moveBy(dx, dy) {
    const { orig } = drag;
    crop.x = clamp(orig.x + dx, 0, img.naturalWidth - orig.w);
    crop.y = clamp(orig.y + dy, 0, img.naturalHeight - orig.h);
  }

  function resizeTo(p) {
    const ratio = getRatio();
    const { anchor, handle } = drag;
    const toRight = handle.includes('e');
    const toBottom = handle.includes('s');

    // ポインタ位置から希望サイズを算出（比率を保つため大きい方に合わせる）
    let w = Math.max(toRight ? p.x - anchor.x : anchor.x - p.x, 0);
    let h = Math.max(toBottom ? p.y - anchor.y : anchor.y - p.y, 0);
    w = Math.max(w, h * ratio);

    // 画像からはみ出さないよう制限
    const maxW = toRight ? img.naturalWidth - anchor.x : anchor.x;
    const maxH = toBottom ? img.naturalHeight - anchor.y : anchor.y;
    w = Math.min(w, maxW, maxH * ratio);

    // 最小サイズ
    const minW = Math.max(MIN_DISPLAY_SIZE / scale(), MIN_DISPLAY_SIZE / scale() * ratio);
    w = Math.max(w, Math.min(minW, maxW, maxH * ratio));
    h = w / ratio;

    crop.w = w;
    crop.h = h;
    crop.x = toRight ? anchor.x : anchor.x - w;
    crop.y = toBottom ? anchor.y : anchor.y - h;
  }

  // 自由モード：掴んだ辺・角だけを動かす（比率は固定しない）
  function resizeFree(p) {
    const { orig, handle } = drag;
    const min = Math.min(MIN_DISPLAY_SIZE / scale(), img.naturalWidth, img.naturalHeight);
    let x1 = orig.x, y1 = orig.y, x2 = orig.x + orig.w, y2 = orig.y + orig.h;
    if (handle.includes('w')) x1 = clamp(p.x, 0, x2 - min);
    if (handle.includes('e')) x2 = clamp(p.x, x1 + min, img.naturalWidth);
    if (handle.includes('n')) y1 = clamp(p.y, 0, y2 - min);
    if (handle.includes('s')) y2 = clamp(p.y, y1 + min, img.naturalHeight);
    crop = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  // ================= ルーペ =================
  // 拡大の中心：つまんでいる角・辺（枠を描いている間はポインタ位置）
  function loupeFocus(e) {
    if (drag.draw) return clampPoint(pointerToImage(e));
    const h = drag.handle;
    return {
      x: h.includes('w') ? crop.x : h.includes('e') ? crop.x + crop.w : crop.x + crop.w / 2,
      y: h.includes('n') ? crop.y : h.includes('s') ? crop.y + crop.h : crop.y + crop.h / 2,
    };
  }

  function showLoupe(e) {
    if (!drag) return;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(LOUPE_SIZE * dpr);
    if (loupe.width !== size) loupe.width = loupe.height = size;

    // 元画像1px → ルーペ上のpx
    const z = Math.min(scale() * LOUPE_ZOOM, LOUPE_MAX_PX) * dpr;
    const f = loupeFocus(e);
    const tx = (x) => (x - f.x) * z + size / 2;
    const ty = (y) => (y - f.y) * z + size / 2;

    const ctx = loupe.getContext('2d');
    ctx.fillStyle = '#2b2b2b'; // 画像の外側
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false; // 画素の境目が見えるように
    ctx.drawImage(img, tx(0), ty(0), img.naturalWidth * z, img.naturalHeight * z);

    // 切り取り範囲の外を暗くする
    ctx.fillStyle = 'rgba(0, 0, 0, .55)';
    ctx.beginPath();
    ctx.rect(tx(0), ty(0), img.naturalWidth * z, img.naturalHeight * z);
    ctx.rect(tx(crop.x), ty(crop.y), crop.w * z, crop.h * z);
    ctx.fill('evenodd');

    // 切り取り枠
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeRect(tx(crop.x), ty(crop.y), crop.w * z, crop.h * z);

    // 画像の端（ここまで寄せられる境界）
    ctx.strokeStyle = '#f59e0b';
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.strokeRect(tx(0), ty(0), img.naturalWidth * z, img.naturalHeight * z);
    ctx.setLineDash([]);

    // 中心の十字
    ctx.strokeStyle = 'rgba(37, 99, 235, .9)';
    ctx.beginPath();
    ctx.moveTo(size / 2, size / 2 - 10 * dpr); ctx.lineTo(size / 2, size / 2 + 10 * dpr);
    ctx.moveTo(size / 2 - 10 * dpr, size / 2); ctx.lineTo(size / 2 + 10 * dpr, size / 2);
    ctx.stroke();

    // 座標表示
    const label = `${Math.round(f.x)}, ${Math.round(f.y)}`;
    ctx.font = `${12 * dpr}px -apple-system, sans-serif`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0, 0, 0, .65)';
    ctx.fillRect(size - tw - 12 * dpr, size - 20 * dpr, tw + 12 * dpr, 20 * dpr);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, size - tw - 6 * dpr, size - 6 * dpr);

    // ポインタの右上に表示（画面からはみ出す場合は反対側へ）
    const gap = 28;
    let left = e.clientX + gap;
    let top = e.clientY - gap - LOUPE_SIZE;
    if (left + LOUPE_SIZE > window.innerWidth - 8) left = e.clientX - gap - LOUPE_SIZE;
    if (top < 8) top = e.clientY + gap;
    loupe.style.left = `${left}px`;
    loupe.style.top = `${top}px`;
    loupe.classList.remove('hidden');
  }

  const hideLoupe = () => loupe.classList.add('hidden');

  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  $('btn-reset').addEventListener('click', resetCrop);
  // ウィンドウサイズ変更時に表示位置を再計算
  window.addEventListener('resize', () => { if (img.naturalWidth) render(); });

  // ================= 出力 =================
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(drawOutput, drag ? 60 : 0);
  }

  // 大きく縮小する場合は段階的に半分ずつ縮小して画質を保つ
  function drawOutput() {
    const size = getOutputSize();
    if (!size || !crop.w) return;

    let src = img;
    let sx = crop.x, sy = crop.y, sw = crop.w, sh = crop.h;

    while (sw / 2 >= size.w && sh / 2 >= size.h) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw / 2));
      c.height = Math.max(1, Math.round(sh / 2));
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
      src = c;
      sx = 0; sy = 0; sw = c.width; sh = c.height;
    }

    preview.width = size.w;
    preview.height = size.h;
    const ctx = preview.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, size.w, size.h);

    outputInfo.textContent = `出力サイズ: ${size.w} × ${size.h} px`;
  }

  // ---- ファイルの重さの指定 ----
  const sizeMode = $('size-mode');
  const sizeValue = $('size-value');
  const sizeUnit = $('size-unit');
  // 重さの上限（バイト）。「そのまま」なら 0、入力が正しくなければ NaN
  const readLimit = () => {
    if (sizeMode.value !== 'limit') return 0;
    const v = parseFloat(sizeValue.value) * Number(sizeUnit.value);
    return v >= 1 ? Math.round(v) : NaN;
  };
  const updateSizeUI = () => {
    $('size-input').classList.toggle('hidden', sizeMode.value !== 'limit');
    sizeValue.classList.toggle('invalid', Number.isNaN(readLimit()));
  };
  sizeMode.addEventListener('change', () => {
    updateSizeUI();
    if (sizeMode.value === 'limit') sizeValue.focus();
  });
  [sizeValue, sizeUnit].forEach((el) => el.addEventListener('input', updateSizeUI));
  const MIN_QUALITY = 0.3;
  const formatBytes = (n) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1000))}KB` : `${(n / 1e6).toFixed(1)}MB`);
  const encode = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

  // 指定した重さ以下で一番きれいな画質を探す（このページでは指定された幅・高さは変えない）
  async function encodeWithin(canvas, type, limit) {
    const first = await encode(canvas, type, JPEG_QUALITY);
    if (first.size <= limit) return { blob: first, reached: true };
    let lo = MIN_QUALITY;
    let hi = JPEG_QUALITY;
    let best = await encode(canvas, type, lo);
    if (best.size > limit) return { blob: best, reached: false }; // 一番低い画質でも収まらない
    for (let i = 0; i < 6; i++) {
      const q = (lo + hi) / 2;
      const b = await encode(canvas, type, q);
      if (b.size <= limit) { best = b; lo = q; } else { hi = q; }
    }
    return { blob: best, reached: true };
  }

  // ---- 保存される画像を作る（要約の計測とダウンロードで共通） ----
  const FORMAT_LABEL = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP' };
  // ピクセル指定のときは重さを指定しない（幅・高さで決まる）
  const currentLimit = () => (getMode() === 'pixel' ? 0 : readLimit());

  async function makeOutput() {
    drawOutput();
    const limit = currentLimit();
    let { type, ext } = outputFormat(sourceType);
    // 重さを指定したときは、画質を調整できる形式で保存する（PNG は JPEG に）
    if (limit && type === 'image/png') ({ type, ext } = { type: 'image/jpeg', ext: 'jpg' });
    let canvas = preview;
    // JPEGは透過非対応なので白背景で合成
    if (type === 'image/jpeg') {
      canvas = document.createElement('canvas');
      canvas.width = preview.width;
      canvas.height = preview.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(preview, 0, 0);
    }
    const { blob, reached } = limit
      ? await encodeWithin(canvas, type, limit)
      : { blob: await encode(canvas, type, JPEG_QUALITY), reached: true };
    return { blob, reached, type, ext, w: canvas.width, h: canvas.height };
  }

  // ---- 保存される画像の要約（大きさ・縦横比・ファイルの重さ） ----
  // 大きさと縦横比はすぐ出す。重さは操作が止まってから実際に作って測り、ダウンロードにも使う
  let estimate = null; // { key, blob, reached, type, ext, w, h }
  let estimateTimer = 0;
  const outputKey = () => {
    const size = getOutputSize();
    return JSON.stringify([img.src, Math.round(crop.x), Math.round(crop.y), Math.round(crop.w), Math.round(crop.h),
      size && size.w, size && size.h, currentLimit()]);
  };

  function updateSummary() {
    const size = getOutputSize();
    if (!size || !crop.w) {
      $('sum-dim').textContent = $('sum-ratio').textContent = $('sum-size').textContent = '—';
      return;
    }
    $('sum-dim').textContent = `${size.w}×${size.h} px`;
    const [a, b] = simpleRatio(size.w, size.h);
    $('sum-ratio').textContent = `${Math.abs(a / b - size.w / size.h) > 1e-9 ? '約 ' : ''}${a}:${b}`;

    clearTimeout(estimateTimer);
    const key = outputKey();
    if (estimate && estimate.key === key) {
      showEstimate();
      return;
    }
    const sizeEl = $('sum-size');
    sizeEl.classList.remove('warn-text');
    if (Number.isNaN(currentLimit())) {
      sizeEl.textContent = '重さの指定を確認';
      return;
    }
    sizeEl.textContent = '計算中…';
    estimateTimer = setTimeout(async () => {
      const out = await makeOutput();
      if (outputKey() !== key) return; // 計算中に設定が変わった
      estimate = { key, ...out };
      showEstimate();
    }, 500);
  }

  function showEstimate() {
    const el = $('sum-size');
    el.textContent = `約 ${formatBytes(estimate.blob.size)}`;
    $('sum-format').textContent = `ファイル（${FORMAT_LABEL[estimate.type]}）`;
    el.classList.toggle('warn-text', !estimate.reached);
    el.title = estimate.reached ? '' : '指定した重さまで小さくできません';
  }
  [sizeMode, sizeValue, sizeUnit].forEach((el) => el.addEventListener('input', updateSummary));
  sizeMode.addEventListener('change', updateSummary);

  $('btn-download').addEventListener('click', async () => {
    const result = $('save-result');
    if (Number.isNaN(currentLimit())) {
      result.textContent = '重さの上限には 0 より大きい数値を入れてください。';
      result.classList.add('warn-text');
      sizeValue.focus();
      return;
    }
    const btn = $('btn-download');
    btn.disabled = true;
    result.classList.remove('warn-text');
    const key = outputKey();
    // 要約で計算済みならそれを使う
    if (!estimate || estimate.key !== key) {
      if (currentLimit()) result.textContent = '重さを調整しています…';
      estimate = { key, ...(await makeOutput()) };
      showEstimate();
    }
    btn.disabled = false;
    const { blob, reached, ext, w, h } = estimate;

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${fileName}_${w}x${h}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);

    if (reached) {
      result.textContent = `保存しました（${formatBytes(blob.size)}）`;
    } else {
      result.textContent = `この幅・高さでは ${formatBytes(blob.size)} までしか小さくできませんでした。幅・高さを小さくすると軽くなります。`;
      result.classList.add('warn-text');
    }
  });

  $('btn-new').addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });

  // 編集中の画像の上に写真をドロップすると入れ替える
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
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
})();
