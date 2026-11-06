(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ブラウザのキャンバス上限を超えないようにするための制限
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_AREA = 100_000_000;
  const PREVIEW_MAX_SIDE = 1600;
  const JPEG_QUALITY = 0.92;
  const SETTINGS_KEY = 'watermark-settings';
  const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif';
  const COLORS = ['#ffffff', '#111111', '#9ca3af', '#ef4444', '#f59e0b', '#3b82f6'];
  // 1か所に置くときの位置（3×3）
  const POSITIONS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
  const POSITION_NAMES = { tl: '左上', tc: '上', tr: '右上', ml: '左', mc: '中央', mr: '右', bl: '左下', bc: '下', br: '右下' };

  const makeCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  };
  const loadImage = (url) => new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = url;
  });

  // ================= 設定（次に開いたときのためにブラウザに覚えておく） =================
  const defaults = {
    kind: 'text',
    text: 'SAMPLE',
    color: '#ffffff',
    bold: true,
    stroke: true,
    mode: 'tile',
    position: 'br',
    size: 8,
    opacity: 30,
    angleTile: -30,  // 角度は入れ方ごとに覚える（繰り返しは斜め、1か所は水平が多い）
    angleSingle: 0,
    gap: 80,
    margin: 4,
  };
  let settings = { ...defaults };
  try {
    settings = { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    // 保存できない環境（プライベートブラウズなど）では毎回初期値
  }
  const saveSettings = () => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 保存できなくても動作は続ける */ }
  };

  let logo = null;     // 読み込んだロゴ画像
  let logoFile = null; // 作業の保存に使うロゴのファイル

  // ================= 透かしの描画（プレビューと保存で共通） =================
  // 透かし1つ分の画像を作る。unit は画像の短い辺（大きさの基準）
  function makeItem(unit) {
    if (settings.kind === 'logo') {
      if (!logo) return null;
      const w = (unit * settings.size * 2.5) / 100; // ロゴは文字より大きめを基準にする
      const h = (w * logo.naturalHeight) / logo.naturalWidth;
      const c = makeCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(logo, 0, 0, c.width, c.height);
      return c;
    }
    const text = settings.text.trim();
    if (!text) return null;
    const size = Math.max(4, (unit * settings.size) / 100);
    const font = `${settings.bold ? 'bold ' : ''}${size}px ${FONT}`;
    const lines = text.split('\n');
    const measure = makeCanvas(1, 1).getContext('2d');
    measure.font = font;
    const pad = settings.stroke ? size * 0.12 : 2;
    const w = Math.max(...lines.map((l) => measure.measureText(l || ' ').width)) + pad * 2;
    const lh = size * 1.2;
    const c = makeCanvas(w, lh * lines.length + pad * 2);
    const ctx = c.getContext('2d');
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const light = (() => {
      const n = parseInt(settings.color.slice(1), 16);
      return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150;
    })();
    lines.forEach((line, i) => {
      const y = pad + lh * (i + 0.5);
      if (settings.stroke) {
        ctx.strokeStyle = light ? 'rgba(0, 0, 0, .6)' : 'rgba(255, 255, 255, .7)';
        ctx.lineWidth = size * 0.12;
        ctx.strokeText(line, c.width / 2, y);
      }
      ctx.fillStyle = settings.color;
      ctx.fillText(line, c.width / 2, y);
    });
    return c;
  }

  // 幅 w・高さ h の画像に透かしを描く
  function drawWatermark(ctx, w, h) {
    const item = makeItem(Math.min(w, h));
    if (!item) return;
    const iw = item.width;
    const ih = item.height;
    ctx.save();
    ctx.globalAlpha = settings.opacity / 100;
    if (settings.mode === 'tile') {
      // 画像の中心を軸に回した格子に敷き詰める（段ごとに半分ずらしてレンガ状に）
      const angle = (settings.angleTile * Math.PI) / 180;
      const gap = settings.gap / 100;
      const sx = iw * (1 + gap);
      const sy = ih * (1 + gap * 1.5);
      const r = Math.hypot(w, h) / 2 + Math.max(iw, ih);
      ctx.translate(w / 2, h / 2);
      ctx.rotate(angle);
      let row = 0;
      for (let y = -r; y <= r; y += sy, row++) {
        const offset = row % 2 ? sx / 2 : 0;
        for (let x = -r - offset; x <= r; x += sx) ctx.drawImage(item, x - iw / 2, y - ih / 2);
      }
    } else {
      // 回したあとの外枠の大きさで、画像からはみ出さない位置に置く
      const angle = (settings.angleSingle * Math.PI) / 180;
      const bw = Math.abs(iw * Math.cos(angle)) + Math.abs(ih * Math.sin(angle));
      const bh = Math.abs(iw * Math.sin(angle)) + Math.abs(ih * Math.cos(angle));
      const m = (Math.min(w, h) * settings.margin) / 100;
      const [v, hz] = settings.position;
      const cx = hz === 'l' ? m + bw / 2 : hz === 'r' ? w - m - bw / 2 : w / 2;
      const cy = v === 't' ? m + bh / 2 : v === 'b' ? h - m - bh / 2 : h / 2;
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.drawImage(item, -iw / 2, -ih / 2);
    }
    ctx.restore();
  }

  // ================= 画像の追加・削除 =================
  // { id, file, url, el(サムネイル) }
  let items = [];
  let current = null;
  let nextId = 1;
  let previewCache = null; // { item, canvas } 表示用に縮小した元画像
  let showOriginal = false;

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  function setupDrop(zone, onFiles, cls = 'dragover') {
    const hasFiles = (e) => [...e.dataTransfer.types].includes('Files');
    zone.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      zone.classList.add(cls);
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove(cls);
    });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      zone.classList.remove(cls);
      onFiles([...e.dataTransfer.files]);
    });
  }
  setupDrop($('drop'), addFiles);
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files.length) addFiles([...e.target.files]);
    e.target.value = '';
  });
  $('add-files').addEventListener('click', () => $('file-input').click());
  $('clear').addEventListener('click', () => [...items].forEach(removeItem));
  // 編集中の画面にドロップすると、画像を追加する
  setupDrop($('workspace'), addFiles, 'drop-replace');

  function addFiles(files) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    const skipped = files.length - images.length;
    images.forEach((file) => {
      const item = { id: nextId++, file, url: URL.createObjectURL(file) };
      item.el = createThumb(item);
      $('strip').appendChild(item.el);
      items.push(item);
    });
    if (!current && items.length) select(items[0]);
    refresh();
    saving.schedule();
    $('status').textContent = skipped ? `画像以外のファイル ${skipped} 件は読み込みませんでした。` : '';
  }

  function createThumb(item) {
    const div = document.createElement('div');
    div.className = 'wm-thumb';
    div.title = item.file.name;
    div.innerHTML = '<img alt=""><button type="button" class="remove" title="一覧から外す">×</button>';
    div.querySelector('img').src = item.url;
    div.addEventListener('click', () => select(item));
    div.querySelector('.remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeItem(item);
    });
    return div;
  }

  function removeItem(item) {
    URL.revokeObjectURL(item.url);
    item.el.remove();
    items = items.filter((x) => x !== item);
    if (current === item) {
      current = null;
      previewCache = null;
      if (items.length) select(items[0]);
    }
    refresh();
    saving.schedule();
  }

  async function select(item) {
    current = item;
    saving.schedule();
    items.forEach((x) => x.el.classList.toggle('active', x === item));
    if (!previewCache || previewCache.item !== item) {
      try {
        const img = await loadImage(item.url);
        if (current !== item) return;
        const s = Math.min(1, PREVIEW_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const c = makeCanvas(img.naturalWidth * s, img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        previewCache = { item, canvas: c, w: img.naturalWidth, h: img.naturalHeight };
      } catch {
        previewCache = null;
        $('file-info').textContent = `${item.file.name}（このブラウザでは読み込めない形式です）`;
        return;
      }
    }
    $('file-info').textContent = `${item.file.name}（${previewCache.w} × ${previewCache.h} px）`;
    redraw();
  }

  function refresh() {
    const has = items.length > 0;
    $('drop-card').classList.toggle('hidden', has);
    $('workspace').classList.toggle('hidden', !has);
    $('side').classList.toggle('hidden', !has);
    document.body.classList.toggle('has-side', has);
    const btn = $('download');
    btn.disabled = !has;
    btn.textContent = items.length > 1 ? `ダウンロード（${items.length} 枚・ZIP）` : 'ダウンロード';
  }

  // ================= プレビュー =================
  const view = $('view');
  function redraw() {
    if (!previewCache) return;
    const src = previewCache.canvas;
    view.width = src.width;
    view.height = src.height;
    const ctx = view.getContext('2d');
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(src, 0, 0);
    if (!showOriginal) drawWatermark(ctx, view.width, view.height);
  }

  document.querySelectorAll('.view-switch button').forEach((b) => b.addEventListener('click', () => {
    showOriginal = b.dataset.view === 'original';
    document.querySelectorAll('.view-switch button').forEach((x) => x.classList.toggle('active', x === b));
    redraw();
  }));

  // ================= 設定の画面 =================
  const kindInputs = document.querySelectorAll('input[name="kind"]');
  const modeSel = $('wm-mode');
  const SLIDERS = [
    ['wm-size', 'size', 'v-size'],
    ['wm-opacity', 'opacity', 'v-opacity'],
    ['wm-gap', 'gap', 'v-gap'],
    ['wm-margin', 'margin', 'v-margin'],
  ];
  const angleKey = () => (settings.mode === 'tile' ? 'angleTile' : 'angleSingle');

  // 色の見本
  COLORS.forEach((color) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = color;
    b.dataset.color = color;
    b.title = color;
    b.addEventListener('click', () => update({ color }));
    $('wm-colors').appendChild(b);
  });
  const other = document.createElement('label');
  other.className = 'swatch swatch-other';
  other.title = 'ほかの色';
  other.innerHTML = '<input type="color" aria-label="ほかの色">';
  other.querySelector('input').addEventListener('input', (e) => update({ color: e.target.value }));
  $('wm-colors').appendChild(other);

  // 位置（3×3）
  POSITIONS.forEach((pos) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pos-cell';
    b.dataset.pos = pos;
    b.title = POSITION_NAMES[pos];
    b.setAttribute('aria-label', POSITION_NAMES[pos]);
    b.addEventListener('click', () => update({ position: pos }));
    $('pos-grid').appendChild(b);
  });

  // 設定の値を画面に反映する
  function syncUI() {
    kindInputs.forEach((r) => { r.checked = r.value === settings.kind; });
    $('text-fields').classList.toggle('hidden', settings.kind !== 'text');
    $('logo-fields').classList.toggle('hidden', settings.kind !== 'logo');
    if (document.activeElement !== $('wm-text')) $('wm-text').value = settings.text;
    $('wm-bold').checked = settings.bold;
    $('wm-stroke').checked = settings.stroke;
    let found = false;
    $('wm-colors').querySelectorAll('.swatch[data-color]').forEach((b) => {
      const on = b.dataset.color.toLowerCase() === settings.color.toLowerCase();
      b.classList.toggle('active', on);
      found = found || on;
    });
    other.classList.toggle('active', !found);
    if (!found) other.style.setProperty('--picked', settings.color);

    modeSel.value = settings.mode;
    modeSel.dispatchEvent(new Event('input')); // ボタンの表示だけ合わせる
    const tile = settings.mode === 'tile';
    $('pos-row').classList.toggle('hidden', tile);
    $('gap-row').classList.toggle('hidden', !tile);
    $('margin-row').classList.toggle('hidden', tile);
    $('pos-grid').querySelectorAll('.pos-cell').forEach((b) => b.classList.toggle('active', b.dataset.pos === settings.position));

    SLIDERS.forEach(([id, key, label]) => { $(id).value = settings[key]; $(label).textContent = settings[key]; });
    $('wm-angle').value = settings[angleKey()];
    $('v-angle').textContent = settings[angleKey()];
  }

  function update(patch) {
    Object.assign(settings, patch);
    saveSettings();
    syncUI();
    redraw();
  }

  kindInputs.forEach((r) => r.addEventListener('change', () => update({ kind: r.value })));
  $('wm-text').addEventListener('input', (e) => update({ text: e.target.value }));
  $('wm-bold').addEventListener('change', (e) => update({ bold: e.target.checked }));
  $('wm-stroke').addEventListener('change', (e) => update({ stroke: e.target.checked }));
  modeSel.addEventListener('change', () => update({ mode: modeSel.value }));
  SLIDERS.forEach(([id, key]) => $(id).addEventListener('input', (e) => update({ [key]: Number(e.target.value) })));
  $('wm-angle').addEventListener('input', (e) => update({ [angleKey()]: Number(e.target.value) }));
  // 角度のスライダーをダブルクリックすると 0° に戻す
  $('wm-angle').addEventListener('dblclick', () => update({ [angleKey()]: 0 }));

  // ---- ロゴ ----
  // restoring: 前回の作業の復元（選んでいる種類＝文字／ロゴは変えない）
  async function setLogo(file, restoring) {
    if (!file || !file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    try {
      logo = await loadImage(url);
    } catch {
      URL.revokeObjectURL(url);
      alert('ロゴ画像を読み込めませんでした。');
      return;
    }
    logoFile = file;
    $('logo-preview').src = url;
    $('logo-preview').classList.remove('hidden');
    $('logo-empty').classList.add('hidden');
    $('logo-clear').classList.remove('hidden');
    if (restoring) redraw();
    else update({ kind: 'logo' });
    saving.schedule();
  }
  $('logo-input').addEventListener('change', (e) => {
    setLogo(e.target.files[0]);
    e.target.value = '';
  });
  const logoDrop = $('logo-drop');
  logoDrop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); logoDrop.classList.add('dragover'); });
  logoDrop.addEventListener('dragleave', () => logoDrop.classList.remove('dragover'));
  logoDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation(); // 画像一覧への追加として扱わない
    logoDrop.classList.remove('dragover');
    setLogo(e.dataTransfer.files[0]);
  });
  $('logo-clear').addEventListener('click', () => {
    if ($('logo-preview').src) URL.revokeObjectURL($('logo-preview').src);
    logo = null;
    logoFile = null;
    saving.schedule();
    $('logo-preview').removeAttribute('src');
    $('logo-preview').classList.add('hidden');
    $('logo-empty').classList.remove('hidden');
    $('logo-clear').classList.add('hidden');
    redraw();
  });

  // ================= 保存（すべての画像に、元の解像度で入れる） =================
  function outputFormat(mime) {
    if (mime === 'image/jpeg' || /^image\/(hei[cf]|avif)$/.test(mime)) return { type: 'image/jpeg', ext: 'jpg' };
    if (mime === 'image/webp' && makeCanvas(1, 1).toDataURL('image/webp').startsWith('data:image/webp')) return { type: 'image/webp', ext: 'webp' };
    return { type: 'image/png', ext: 'png' };
  }

  async function render(item) {
    const img = await loadImage(item.url);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const s = Math.min(1, MAX_CANVAS_SIDE / iw, MAX_CANVAS_SIDE / ih, Math.sqrt(MAX_CANVAS_AREA / (iw * ih)));
    const c = makeCanvas(iw * s, ih * s);
    const ctx = c.getContext('2d');
    const { type, ext } = outputFormat(item.file.type);
    // JPEGは透過非対応なので白背景を敷く
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    drawWatermark(ctx, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, type, JPEG_QUALITY));
    c.width = c.height = 0;
    return { blob, name: `${item.file.name.replace(/\.[^.]+$/, '') || 'image'}_wm.${ext}` };
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('download').addEventListener('click', async () => {
    if (!items.length) return;
    if (settings.kind === 'logo' && !logo) {
      $('status').textContent = 'ロゴ画像を選んでください。';
      return;
    }
    if (settings.kind === 'text' && !settings.text.trim()) {
      $('status').textContent = '透かしの文字を入れてください。';
      return;
    }
    const btn = $('download');
    btn.disabled = true;
    try {
      if (items.length === 1) {
        $('status').textContent = '作成中…';
        const { blob, name } = await render(items[0]);
        downloadBlob(blob, name);
      } else {
        const zip = new JSZip();
        const used = new Set();
        for (let i = 0; i < items.length; i++) {
          $('status').textContent = `作成中… ${i + 1} / ${items.length}`;
          const { blob, name } = await render(items[i]);
          // 同名ファイルが上書きされないよう連番を付ける
          let unique = name;
          for (let n = 2; used.has(unique); n++) unique = name.replace(/(\.[^.]+)$/, `_${n}$1`);
          used.add(unique);
          zip.file(unique, blob);
        }
        $('status').textContent = 'ZIP を作成中…';
        downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), 'watermarked.zip');
      }
      $('status').textContent = `保存しました（${items.length} 枚）`;
    } catch (err) {
      $('status').textContent = `保存できませんでした（${err.message || '読み込めない画像があります'}）`;
    } finally {
      btn.disabled = false;
    }
  });

  // ================= 作業の保存・復元と、ほかの道具との受け渡し（store.js） =================
  // 透かしの設定は localStorage に保存済み。ここでは画像の一覧とロゴを保存する
  const PAGE = 'watermark/index.html';
  const store = window.ToolStore;
  let restoring = true; // 復元が終わるまでは保存しない（空の一覧で上書きしないため）
  const saving = store
    ? store.autosave(PAGE, async () => {
      if (restoring) return undefined;
      if (!items.length && !logoFile) return null; // すべて外したら保存も消す
      return {
        files: [...items.map((x) => ({ blob: x.file, name: x.file.name, key: 'image' })),
          ...(logoFile ? [{ blob: logoFile, name: logoFile.name, key: 'logo' }] : [])],
        data: { current: Math.max(0, items.indexOf(current)) },
      };
    })
    : { schedule() {} };

  if (store) {
    // 選んでいる画像に透かしを入れて送る
    store.mountSendTo($('send-slot'), PAGE, async () => {
      if (!current) return null;
      if (settings.kind === 'logo' && !logo) throw new Error('ロゴ画像を選んでください');
      return [await render(current)];
    });
    (async () => {
      const saved = await store.load(PAGE);
      const handed = await store.takeHandoff(PAGE);
      if (saved) {
        const logoSaved = saved.files.find((f) => f.key === 'logo');
        if (logoSaved) await setLogo(logoSaved, true);
        const images = saved.files.filter((f) => f.key === 'image');
        if (images.length) {
          addFiles(images);
          const pick = items[saved.data.current];
          if (pick) select(pick);
        }
      }
      // ほかの道具から送られた画像は、一覧の最後に足して選ぶ
      if (handed && handed.length) {
        addFiles(handed);
        select(items[items.length - 1]);
      }
      restoring = false;
      saving.schedule();
    })();
  } else {
    restoring = false;
  }

  syncUI();
})();
