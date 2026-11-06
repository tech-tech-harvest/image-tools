(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ブラウザのキャンバス上限を超えないようにするための制限
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_AREA = 100_000_000;
  const PREVIEW_MAX_SIDE = 1600;
  const JPEG_QUALITY = 0.92;

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
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  // ================= 設定 =================
  const getLayout = () => document.querySelector('input[name="layout"]:checked').value;
  const settings = () => ({
    layout: getLayout(),
    fit: $('fit').value,
    align: $('align').value,
    cols: Number($('cols').value),
    cellRatio: $('cell-ratio').value,
    cellFit: $('cell-fit').value,
    gapPct: Number($('gap').value),
    outer: $('outer').checked,
    bg: $('bg').value === 'custom' ? $('bg-color').value : $('bg').value,
  });

  // ================= 配置の計算（プレビューと保存で共通） =================
  // 画像の大きさの一覧から、結合後の大きさと各画像の置き場所を求める（元の解像度の単位）。
  // src は画像の中の使う範囲（グリッドで切り抜いて埋めるとき）
  function computeLayout(sizes, o) {
    const n = sizes.length;
    const place = [];
    if (o.layout === 'row' || o.layout === 'column') {
      const row = o.layout === 'row';
      // 横に並べるなら高さ、縦に並べるなら幅をそろえる
      const cross = sizes.map((s) => (row ? s.h : s.w));
      const target = o.fit === 'min' ? Math.min(...cross) : o.fit === 'max' ? Math.max(...cross) : null;
      const scaled = sizes.map((s, i) => {
        const k = target ? target / cross[i] : 1;
        return { w: s.w * k, h: s.h * k };
      });
      const crossMax = Math.max(...scaled.map((s) => (row ? s.h : s.w)));
      const gap = Math.round(((target || median(cross)) * o.gapPct) / 100);
      const m = o.outer ? gap : 0;
      let pos = m;
      scaled.forEach((s, i) => {
        const size = row ? s.h : s.w;
        const off = o.align === 'start' ? 0 : o.align === 'end' ? crossMax - size : (crossMax - size) / 2;
        place.push(row
          ? { i, x: pos, y: m + off, w: s.w, h: s.h }
          : { i, x: m + off, y: pos, w: s.w, h: s.h });
        pos += (row ? s.w : s.h) + gap;
      });
      const main = pos - gap + m;
      return { W: row ? main : crossMax + m * 2, H: row ? crossMax + m * 2 : main, place, gap };
    }

    // グリッド：1マスの大きさは、各画像が入る大きさの中央値（極端に小さい画像に全体が引きずられないように）
    const cols = Math.min(o.cols, n);
    const rows = Math.ceil(n / cols);
    const ratio = o.cellRatio === 'first' ? sizes[0].w / sizes[0].h : Number(o.cellRatio);
    const cw = median(sizes.map((s) => Math.min(s.w, s.h * ratio)));
    const ch = cw / ratio;
    const gap = Math.round((Math.min(cw, ch) * o.gapPct) / 100);
    const m = o.outer ? gap : 0;
    sizes.forEach((s, i) => {
      const cx = m + (i % cols) * (cw + gap);
      const cy = m + Math.floor(i / cols) * (ch + gap);
      if (o.cellFit === 'cover') {
        // マスを埋めるように拡大し、はみ出す部分（画像の中央以外）を切り抜く
        const k = Math.max(cw / s.w, ch / s.h);
        const sw = cw / k;
        const sh = ch / k;
        place.push({ i, x: cx, y: cy, w: cw, h: ch, src: { x: (s.w - sw) / 2, y: (s.h - sh) / 2, w: sw, h: sh } });
      } else {
        const k = Math.min(cw / s.w, ch / s.h);
        const w = s.w * k;
        const h = s.h * k;
        place.push({ i, x: cx + (cw - w) / 2, y: cy + (ch - h) / 2, w, h });
      }
    });
    return { W: cols * cw + (cols - 1) * gap + m * 2, H: rows * ch + (rows - 1) * gap + m * 2, place, gap };
  }

  // 結合した画像を描く。scale：元の解像度に対する倍率
  function drawCombined(o, scale, forJpeg) {
    const L = computeLayout(items.map((x) => ({ w: x.w, h: x.h })), o);
    const c = makeCanvas(L.W * scale, L.H * scale);
    const ctx = c.getContext('2d');
    if (o.bg !== 'transparent') {
      ctx.fillStyle = o.bg;
      ctx.fillRect(0, 0, c.width, c.height);
    } else if (forJpeg) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    L.place.forEach((p) => {
      const img = items[p.i].img;
      const s = p.src || { x: 0, y: 0, w: items[p.i].w, h: items[p.i].h };
      ctx.drawImage(img, s.x, s.y, s.w, s.h, p.x * scale, p.y * scale, p.w * scale, p.h * scale);
    });
    return { canvas: c, layout: L };
  }

  // 保存するときの倍率（ブラウザで扱える大きさに収める）
  function exportScale(L) {
    return Math.min(1, MAX_CANVAS_SIDE / L.W, MAX_CANVAS_SIDE / L.H, Math.sqrt(MAX_CANVAS_AREA / (L.W * L.H)));
  }

  // ================= 画像の追加・削除・並べ替え =================
  // { id, file, url, img, w, h, el }
  let items = [];
  let nextId = 1;
  let dragId = null;

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  function setupDrop(zone, onFiles, cls) {
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
  setupDrop($('drop'), addFiles, 'dragover');
  setupDrop($('workspace'), addFiles, 'drop-replace'); // 編集中の画面にドロップすると追加
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files.length) addFiles([...e.target.files]);
    e.target.value = '';
  });
  $('add-files').addEventListener('click', () => $('file-input').click());
  $('clear').addEventListener('click', () => {
    [...items].forEach((x) => removeItem(x, true));
    refresh();
  });

  async function addFiles(files) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    let failed = files.length - images.length;
    for (const file of images) {
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        const item = { id: nextId++, file, url, img, w: img.naturalWidth, h: img.naturalHeight };
        item.el = createThumb(item);
        $('strip').appendChild(item.el);
        items.push(item);
      } catch {
        URL.revokeObjectURL(url);
        failed++;
      }
    }
    $('status').textContent = failed ? `読み込めないファイル ${failed} 件は外しました。` : '';
    refresh();
  }

  function createThumb(item) {
    const div = document.createElement('div');
    div.className = 'wm-thumb';
    div.draggable = true;
    div.title = `${item.file.name}（${item.w} × ${item.h} px）`;
    div.innerHTML = '<span class="cb-order"></span><img alt="" draggable="false"><button type="button" class="remove" title="外す">×</button>';
    div.querySelector('img').src = item.url;
    div.querySelector('.remove').addEventListener('click', () => removeItem(item));
    // ドラッグで並べ替え（一覧の中のどこに落としても、一番近い画像の前後に入れる）
    div.addEventListener('dragstart', (e) => {
      dragId = item.id;
      div.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(item.id));
    });
    div.addEventListener('dragend', () => {
      dragId = null;
      div.classList.remove('dragging');
      clearMarks();
    });
    return div;
  }

  const clearMarks = () => items.forEach((x) => x.el.classList.remove('drop-before', 'drop-after'));
  function dropTarget(e) {
    let best = null;
    let bestD = Infinity;
    items.forEach((x) => {
      const r = x.el.getBoundingClientRect();
      const d = Math.abs(e.clientX - (r.left + r.width / 2)) + Math.abs(e.clientY - (r.top + r.height / 2)) * 2;
      if (d < bestD) { bestD = d; best = { item: x, after: e.clientX > r.left + r.width / 2 }; }
    });
    return best;
  }
  const strip = $('strip');
  strip.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    clearMarks();
    const t = dropTarget(e);
    if (t && t.item.id !== dragId) t.item.el.classList.add(t.after ? 'drop-after' : 'drop-before');
  });
  strip.addEventListener('drop', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.stopPropagation();
    clearMarks();
    const t = dropTarget(e);
    if (!t || t.item.id === dragId) return;
    const moved = items.find((x) => x.id === dragId);
    items = items.filter((x) => x !== moved);
    let to = items.indexOf(t.item);
    if (t.after) to++;
    items.splice(to, 0, moved);
    items.forEach((x) => strip.appendChild(x.el));
    refresh();
  });

  function removeItem(item, silent) {
    URL.revokeObjectURL(item.url);
    item.el.remove();
    items = items.filter((x) => x !== item);
    if (!silent) refresh();
  }

  // ================= 画面の更新 =================
  const view = $('view');
  let estimate = null; // { key, blob, type, ext, w, h }
  let estimateTimer = 0;

  function refresh() {
    const has = items.length > 0;
    $('drop-card').classList.toggle('hidden', has);
    $('workspace').classList.toggle('hidden', !has);
    $('side').classList.toggle('hidden', !has);
    document.body.classList.toggle('has-side', has);
    items.forEach((x, i) => { x.el.querySelector('.cb-order').textContent = i + 1; });
    $('count').textContent = `${items.length} 枚`;
    $('download').disabled = items.length < 1;

    const o = settings();
    const line = o.layout !== 'grid';
    $('line-fields').classList.toggle('hidden', !line);
    $('grid-fields').classList.toggle('hidden', line);
    $('fit-title').textContent = o.layout === 'row' ? '高さのそろえ方' : '幅のそろえ方';
    $('align-row').classList.toggle('hidden', !line || o.fit !== 'none');
    $('v-cols').textContent = o.cols;
    $('v-gap').textContent = o.gapPct;
    $('bg-color-row').classList.toggle('hidden', $('bg').value !== 'custom');
    if (!has) return;

    // プレビュー（縮小版）
    const L = computeLayout(items.map((x) => ({ w: x.w, h: x.h })), o);
    const ps = Math.min(1, PREVIEW_MAX_SIDE / Math.max(L.W, L.H));
    const { canvas } = drawCombined(o, ps, false);
    view.width = canvas.width;
    view.height = canvas.height;
    view.getContext('2d').drawImage(canvas, 0, 0);

    // 保存される画像の大きさ・縦横比・重さ
    const es = exportScale(L);
    const w = Math.round(L.W * es);
    const h = Math.round(L.H * es);
    $('v-gap-px').textContent = Math.round(L.gap * es);
    $('sum-dim').textContent = `${w}×${h} px`;
    $('sum-ratio').textContent = ratioText(w, h);
    $('status').classList.toggle('warn-text', es < 1);
    if (es < 1) $('status').textContent = '大きすぎるため、全体を縮小して保存します。';
    else if (/縮小して保存/.test($('status').textContent)) $('status').textContent = '';
    scheduleEstimate();
  }

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

  // 設定を変えたらすぐ反映する
  document.querySelectorAll('input[name="layout"]').forEach((r) => r.addEventListener('change', refresh));
  ['fit', 'align', 'cols', 'cell-ratio', 'cell-fit', 'gap', 'outer', 'bg', 'bg-color'].forEach((id) => {
    $(id).addEventListener('input', refresh);
    $(id).addEventListener('change', refresh);
  });

  // ================= 保存 =================
  // 背景が透明なら PNG。そうでなければ、全部が JPEG なら JPEG、混ざっていれば PNG
  function outputFormat(o) {
    if (o.bg === 'transparent') return { type: 'image/png', ext: 'png' };
    return items.every((x) => x.file.type === 'image/jpeg') ? { type: 'image/jpeg', ext: 'jpg' } : { type: 'image/png', ext: 'png' };
  }
  const FORMAT_LABEL = { 'image/jpeg': 'JPEG', 'image/png': 'PNG' };
  const formatBytes = (n) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1000))}KB` : `${(n / 1e6).toFixed(1)}MB`);
  const outputKey = () => JSON.stringify([items.map((x) => x.id), settings()]);

  async function makeOutput() {
    const o = settings();
    const { type, ext } = outputFormat(o);
    const L = computeLayout(items.map((x) => ({ w: x.w, h: x.h })), o);
    const { canvas } = drawCombined(o, exportScale(L), type === 'image/jpeg');
    const blob = await new Promise((res) => canvas.toBlob(res, type, JPEG_QUALITY));
    const out = { blob, type, ext, w: canvas.width, h: canvas.height };
    canvas.width = canvas.height = 0;
    return out;
  }

  // 重さは操作が止まってから実際に作って測り、ダウンロードにもそのまま使う
  function scheduleEstimate() {
    clearTimeout(estimateTimer);
    const key = outputKey();
    if (estimate && estimate.key === key) { showEstimate(); return; }
    $('sum-size').textContent = '計算中…';
    estimateTimer = setTimeout(async () => {
      const out = await makeOutput();
      if (outputKey() !== key) return;
      estimate = { key, ...out };
      showEstimate();
    }, 600);
  }
  function showEstimate() {
    $('sum-size').textContent = `約 ${formatBytes(estimate.blob.size)}`;
    $('sum-format').textContent = `ファイル（${FORMAT_LABEL[estimate.type]}）`;
  }

  $('download').addEventListener('click', async () => {
    if (!items.length) return;
    const btn = $('download');
    btn.disabled = true;
    const key = outputKey();
    if (!estimate || estimate.key !== key) {
      $('status').textContent = '画像を作成しています…';
      estimate = { key, ...(await makeOutput()) };
      showEstimate();
    }
    btn.disabled = false;
    const { blob, ext, w, h } = estimate;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `combined_${w}x${h}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    $('status').classList.remove('warn-text');
    $('status').textContent = `保存しました（${w}×${h} px・${formatBytes(blob.size)}）`;
  });

  refresh();
})();
