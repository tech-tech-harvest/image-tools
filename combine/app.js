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

  // ================= グリッドのパターン =================
  // cols：列の数の設定を使うパターン
  const PATTERNS = [
    { id: 'z', label: '横に順番に並べる', cols: true },
    { id: 'n', label: '縦に順番に並べる', cols: true },
    { id: 'snake', label: '行ごとに折り返して並べる', cols: true },
    { id: 'big-corner', label: '1枚目を左上に大きく、残りを横に順番に', cols: true },
    { id: 'big-left', label: '1枚目を左に大きく、残りを右に縦に並べる' },
    { id: 'big-right', label: '1枚目を右に大きく、残りを左に縦に並べる' },
    { id: 'big-top', label: '1枚目を上に大きく、残りを下に横に並べる' },
    { id: 'big-bottom', label: '1枚目を下に大きく、残りを上に横に並べる' },
  ];
  let gridPattern = 'z';

  // n 枚をマス目のどこに置くか。c, r：左上のマス、cs, rs：何マス分使うか。C, R：全体のマスの数
  function gridSlots(pattern, n, colsOpt) {
    const one = (c, r, s = 1) => ({ c, r, cs: s, rs: s });
    const rest = (f) => Array.from({ length: n - 1 }, (_, k) => f(k));
    const m = n - 1;
    let slots;
    if (n === 1) slots = [one(0, 0)];
    else if (pattern === 'big-left') slots = [one(0, 0, m), ...rest((k) => one(m, k))];
    else if (pattern === 'big-right') slots = [one(1, 0, m), ...rest((k) => one(0, k))];
    else if (pattern === 'big-top') slots = [one(0, 0, m), ...rest((k) => one(k, m))];
    else if (pattern === 'big-bottom') slots = [one(0, 1, m), ...rest((k) => one(k, 0))];
    else if (pattern === 'big-corner') {
      // 1枚目が 2×2 マスを使い、残りは空いているマスに左上から順に入る
      const C = Math.max(2, colsOpt);
      const taken = new Set(['0,0', '1,0', '0,1', '1,1']);
      slots = [one(0, 0, 2)];
      let pos = 0;
      for (let k = 1; k < n; k++) {
        while (taken.has(`${pos % C},${Math.floor(pos / C)}`)) pos++;
        slots.push(one(pos % C, Math.floor(pos / C)));
        pos++;
      }
    } else if (pattern === 'n') {
      const R = Math.ceil(n / Math.min(colsOpt, n));
      slots = Array.from({ length: n }, (_, i) => one(Math.floor(i / R), i % R));
    } else {
      const C = Math.min(colsOpt, n);
      slots = Array.from({ length: n }, (_, i) => {
        const r = Math.floor(i / C);
        const k = i % C;
        return one(pattern === 'snake' && r % 2 ? C - 1 - k : k, r);
      });
    }
    return {
      C: Math.max(...slots.map((s) => s.c + s.cs)),
      R: Math.max(...slots.map((s) => s.r + s.rs)),
      slots,
    };
  }

  // パターンの図：マス目と、並ぶ順番を表す矢印
  const BOX = 56;
  function patternIcon(pattern, n, cols) {
    const G = gridSlots(pattern, n, cols);
    const g = 2;
    const u = Math.min((BOX - (G.C - 1) * g) / G.C, (BOX - (G.R - 1) * g) / G.R);
    const ox = (BOX - (G.C * u + (G.C - 1) * g)) / 2;
    const oy = (BOX - (G.R * u + (G.R - 1) * g)) / 2;
    const f = (v) => +v.toFixed(1);
    const pts = [];
    const rects = G.slots.map((s) => {
      const x = ox + s.c * (u + g);
      const y = oy + s.r * (u + g);
      const w = s.cs * u + (s.cs - 1) * g;
      const h = s.rs * u + (s.rs - 1) * g;
      pts.push([x + w / 2, y + h / 2]);
      return `<rect class="cb-cell" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="1.5"/>`;
    }).join('');
    let arrow = '';
    if (pts.length > 1) {
      // 矢印の先が最後のマスの中心に来るように、線は少し手前で止める
      const [ax, ay] = pts[pts.length - 2];
      const [bx, by] = pts[pts.length - 1];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const dx = (bx - ax) / len;
      const dy = (by - ay) / len;
      const hl = Math.min(7, len * 0.6);
      const end = [bx - dx * hl, by - dy * hl];
      const line = [...pts.slice(0, -1), end].map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
      const head = [[bx, by], [end[0] - dy * 4, end[1] + dx * 4], [end[0] + dy * 4, end[1] - dx * 4]]
        .map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
      arrow = `<polyline class="cb-arrow" points="${line}"/><polygon class="cb-head" points="${head}"/>`;
    }
    const [sx, sy] = pts[0];
    return `<svg viewBox="0 0 ${BOX} ${BOX}" aria-hidden="true">${rects}${arrow}<circle class="cb-head" cx="${f(sx)}" cy="${f(sy)}" r="2.5"/></svg>`;
  }

  function renderPatterns() {
    const n = Math.max(2, items.length);
    const cols = Number($('cols').value);
    $('patterns').innerHTML = PATTERNS.map((p) => `<button type="button" class="cb-pat${p.id === gridPattern ? ' active' : ''}" role="radio" aria-checked="${p.id === gridPattern}" data-id="${p.id}" title="${p.label}" aria-label="${p.label}">${patternIcon(p.id, n, cols)}</button>`).join('');
  }
  $('patterns').addEventListener('click', (e) => {
    const b = e.target.closest('.cb-pat');
    if (!b) return;
    gridPattern = b.dataset.id;
    refresh();
  });

  // ================= 設定 =================
  const getLayout = () => document.querySelector('input[name="layout"]:checked').value;
  const settings = () => ({
    layout: getLayout(),
    pattern: gridPattern,
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

    // グリッド：1マスの大きさは、各画像が入る大きさの中央値（極端に小さい画像に全体が引きずられないように）。
    // 何マス分も使う画像は、1マスあたりの大きさで数える
    const G = gridSlots(o.pattern, n, o.cols);
    const ratio = o.cellRatio === 'first' ? sizes[0].w / sizes[0].h : Number(o.cellRatio);
    const cw = median(sizes.map((s, i) => Math.min(s.w, s.h * ratio) / G.slots[i].cs));
    const ch = cw / ratio;
    const gap = Math.round((Math.min(cw, ch) * o.gapPct) / 100);
    const m = o.outer ? gap : 0;
    sizes.forEach((s, i) => {
      const t = G.slots[i];
      const cx = m + t.c * (cw + gap);
      const cy = m + t.r * (ch + gap);
      const sw0 = t.cs * cw + (t.cs - 1) * gap;
      const sh0 = t.rs * ch + (t.rs - 1) * gap;
      if (o.cellFit === 'cover') {
        // マスを埋めるように拡大し、はみ出す部分（画像の中央以外）を切り抜く
        const k = Math.max(sw0 / s.w, sh0 / s.h);
        const sw = sw0 / k;
        const sh = sh0 / k;
        place.push({ i, x: cx, y: cy, w: sw0, h: sh0, src: { x: (s.w - sw) / 2, y: (s.h - sh) / 2, w: sw, h: sh } });
      } else {
        const k = Math.min(sw0 / s.w, sh0 / s.h);
        const w = s.w * k;
        const h = s.h * k;
        place.push({ i, x: cx + (sw0 - w) / 2, y: cy + (sh0 - h) / 2, w, h });
      }
    });
    return { W: G.C * cw + (G.C - 1) * gap + m * 2, H: G.R * ch + (G.R - 1) * gap + m * 2, place, gap };
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
    $('cols-row').classList.toggle('hidden', !PATTERNS.find((p) => p.id === o.pattern).cols);
    if (!line) renderPatterns();
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
