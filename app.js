(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'vendor/pdf.worker.min.js';

  // ブラウザのキャンバス上限を超えないようにするための制限
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_AREA = 100_000_000;
  const THUMB_WIDTH = 240;
  const PT_PER_MM = 72 / 25.4;
  const PT_PER_PX = 72 / 96;

  const PAPER_MM = {
    a4: [210, 297],
    a3: [297, 420],
    b5: [182, 257],
    letter: [215.9, 279.4],
  };

  // 自動判定できる入力形式
  const INPUT_LABELS = {
    pdf: 'PDF',
    jpeg: 'JPEG',
    png: 'PNG',
    gif: 'GIF',
    webp: 'WebP',
    bmp: 'BMP',
    avif: 'AVIF',
    heic: 'HEIC',
    tiff: 'TIFF',
    ico: 'ICO',
    svg: 'SVG',
  };

  const OUTPUTS = {
    png: { label: 'PNG', mime: 'image/png', ext: 'png' },
    jpeg: { label: 'JPEG', mime: 'image/jpeg', ext: 'jpg', lossy: true },
    webp: { label: 'WebP', mime: 'image/webp', ext: 'webp', lossy: true },
    pdf: { label: 'PDF', mime: 'application/pdf', ext: 'pdf' },
  };

  // ================= 共通 =================
  // ページ全体へのドロップでブラウザがファイルを開いてしまうのを防ぐ
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  function setupDropZone(zone, input, onFiles) {
    const hasFiles = (e) => [...e.dataTransfer.types].includes('Files');
    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        zone.classList.add('dragover');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
      })
    );
    zone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
    });
    input.addEventListener('change', () => {
      if (input.files.length) onFiles([...input.files]);
      input.value = '';
    });
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

  const canvasToBlob = (canvas, type, quality) =>
    new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の生成に失敗しました'))), type, quality)
    );

  const baseName = (name, fallback) => name.replace(/\.[^.]+$/, '') || fallback;

  const loadImage = (url) =>
    new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });

  // キャンバス上限に収まる縮小率（1 以下）
  const fitScale = (w, h, scale = 1) =>
    Math.min(scale, MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h, Math.sqrt(MAX_CANVAS_AREA / (w * h)));

  // toBlob が指定形式を書き出せるか（非対応だと PNG が返る）
  const canEncode = (mime) => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL(mime).startsWith(`data:${mime}`);
  };

  // ================= 入力形式の自動判定 =================
  // 拡張子や MIME ではなくファイル先頭のバイト列から判定する
  async function detectType(file) {
    const b = new Uint8Array(await file.slice(0, 512).arrayBuffer());
    const ascii = (from, len) => String.fromCharCode(...b.subarray(from, from + len));
    if (ascii(0, 5) === '%PDF-') return 'pdf';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
    if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
    if (ascii(0, 4) === 'GIF8') return 'gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
    if (ascii(0, 2) === 'BM') return 'bmp';
    if (ascii(4, 4) === 'ftyp') {
      const brands = ascii(8, 32);
      if (/avif|avis/.test(brands)) return 'avif';
      if (/hei[cxms]|hev[cx]|mif1|msf1/.test(brands)) return 'heic';
    }
    if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'tiff';
    if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
    const head = new TextDecoder().decode(b);
    if (/^﻿?\s*</.test(head) && /<svg[\s>]/i.test(head)) return 'svg';
    if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return 'svg';
    return null;
  }

  // ================= 状態 =================
  const grid = $('grid');
  const inType = $('in-type');
  const outFormat = $('out-format');
  const quality = $('quality');
  const dpiSel = $('dpi');
  const paper = $('paper');
  const orient = $('orient');
  const margin = $('margin');
  const outName = $('out-name');
  const statusEl = $('status');
  const downloadBtn = $('download');

  // { id, file, type, el, ready, error, removed,
  //   画像: url, w, h / PDF: pdf, numPages, rangeInput }
  let items = [];
  let nextId = 1;
  let dragId = null;
  let busy = false;
  let nameEdited = false;

  // WebP に書き出せないブラウザ（Safari 等）では選択肢を無効化
  if (!canEncode('image/webp')) {
    const opt = outFormat.querySelector('option[value="webp"]');
    opt.disabled = true;
    opt.textContent += '（このブラウザは非対応）';
  }

  setupDropZone($('drop'), $('file-input'), addFiles);

  async function addFiles(files) {
    const wasEmpty = items.length === 0;
    for (const file of files) {
      const item = { id: nextId++, file, type: await detectType(file), ready: false, error: null };
      item.el = createThumb(item);
      items.push(item);
      grid.appendChild(item.el);
      refresh();
      await loadItem(item);
    }
    if (wasEmpty && items.length && !nameEdited) outName.value = baseName(items[0].file.name, 'converted');
    if (wasEmpty && items.length) window.scrollTo(0, 0);
  }

  async function loadItem(item) {
    try {
      if (!item.type) throw new Error('対応していない形式です');
      if (item.type === 'pdf') await loadPdfItem(item);
      else await loadImageItem(item);
      if (item.removed) return;
      item.ready = true;
    } catch (err) {
      item.error = err.message || '読み込めませんでした';
    }
    updateThumb(item);
    refresh();
  }

  async function loadImageItem(item) {
    item.url = URL.createObjectURL(item.file);
    let el;
    try {
      el = await loadImage(item.url);
    } catch {
      throw new Error('このブラウザでは読み込めない形式です');
    }
    // サイズ指定のない SVG は既定の大きさで描画する
    item.w = el.naturalWidth || 1024;
    item.h = el.naturalHeight || 1024;
    const frame = item.el.querySelector('.frame');
    frame.innerHTML = '';
    el.alt = '';
    el.draggable = false;
    frame.appendChild(el);
  }

  async function loadPdfItem(item) {
    const task = pdfjsLib.getDocument({ data: new Uint8Array(await item.file.arrayBuffer()) });
    task.onPassword = (update, reason) => {
      const msg = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
        ? `${item.file.name}: パスワードが違います。もう一度入力してください。`
        : `${item.file.name} はパスワードで保護されています。パスワードを入力してください。`;
      const pw = prompt(msg);
      if (pw === null) task.destroy();
      else update(pw);
    };
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      throw new Error(`PDFを読み込めませんでした（${err.message}）`);
    }
    if (item.removed) { doc.destroy(); return; }
    item.pdf = doc;
    item.numPages = doc.numPages;

    // 1ページ目をサムネイルに
    const page = await doc.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: THUMB_WIDTH / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    const frame = item.el.querySelector('.frame');
    frame.innerHTML = '';
    frame.appendChild(canvas);
  }

  // ================= サムネイル =================
  function createThumb(item) {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.draggable = true;

    const order = document.createElement('span');
    order.className = 'order';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.title = '削除';
    remove.textContent = '×';
    remove.addEventListener('click', () => removeItem(item));

    const frame = document.createElement('div');
    frame.className = 'frame';
    frame.innerHTML = '<span class="placeholder">読み込み中…</span>';

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = item.file.name;
    label.title = item.file.name;

    const meta = document.createElement('div');
    meta.className = 'meta';

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'save-one';
    save.textContent = '保存';
    save.disabled = true;
    save.addEventListener('click', () => runExport([item], baseName(item.file.name, 'converted')));

    div.append(order, remove, frame, label, meta);

    if (item.type === 'pdf') {
      const range = document.createElement('label');
      range.className = 'range';
      range.textContent = 'ページ ';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'すべて';
      // 並べ替え用の draggable が入力欄の文字選択を邪魔しないようにする
      input.addEventListener('pointerdown', () => { div.draggable = false; });
      input.addEventListener('blur', () => { div.draggable = true; });
      input.addEventListener('input', () => {
        input.classList.toggle('invalid', item.ready && !pagesOf(item));
        refresh();
      });
      range.appendChild(input);
      item.rangeInput = input;
      div.appendChild(range);
    }

    div.appendChild(save);
    setupSortable(div, item.id);
    return div;
  }

  function updateThumb(item) {
    const { el } = item;
    const meta = el.querySelector('.meta');
    meta.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = INPUT_LABELS[item.type] || '不明';
    meta.appendChild(badge);

    el.classList.toggle('error', !!item.error);
    if (item.error) {
      meta.append(item.error);
      el.querySelector('.frame').innerHTML = '<span class="placeholder">プレビューなし</span>';
      if (item.rangeInput) item.rangeInput.disabled = true;
    } else if (item.type === 'pdf') {
      meta.append(`${item.numPages} ページ`);
    } else {
      meta.append(`${item.w} × ${item.h} px`);
    }
    el.querySelector('.save-one').disabled = !item.ready;
  }

  function removeItem(item) {
    item.removed = true;
    if (item.url) URL.revokeObjectURL(item.url);
    if (item.pdf) item.pdf.destroy();
    item.el.remove();
    items = items.filter((x) => x !== item);
    refresh();
  }

  // ---- ドラッグで並べ替え ----
  // ドロップ先はカード内のどこでもよく、ポインタに最も近いサムネイルの前後に入れる
  function setupSortable(div, id) {
    div.addEventListener('dragstart', (e) => {
      dragId = id;
      div.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(id));
    });
    div.addEventListener('dragend', () => {
      dragId = null;
      clearDropMarks();
      div.classList.remove('dragging');
    });
  }

  const clearDropMarks = () =>
    grid.querySelectorAll('.thumb').forEach((t) => t.classList.remove('drop-before', 'drop-after'));

  // ポインタに最も近いサムネイルと、その前後どちらに入れるか
  function dropTarget(e) {
    let best = null;
    let bestD = Infinity;
    for (const item of items) {
      const r = item.el.getBoundingClientRect();
      const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
      const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
      // 行をまたぐより同じ行の隣を優先する
      const d = dx * dx + dy * dy * 4;
      if (d < bestD) {
        bestD = d;
        best = { item, after: e.clientX > r.left + r.width / 2 };
      }
    }
    return best;
  }

  const listCard = $('list-card');
  listCard.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    const t = dropTarget(e);
    if (t && t.item.id !== dragId) t.item.el.classList.add(t.after ? 'drop-after' : 'drop-before');
  });
  listCard.addEventListener('dragleave', (e) => {
    if (!listCard.contains(e.relatedTarget)) clearDropMarks();
  });
  listCard.addEventListener('drop', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    clearDropMarks();
    const t = dropTarget(e);
    if (!t || t.item.id === dragId) return;
    const from = items.findIndex((x) => x.id === dragId);
    const [moved] = items.splice(from, 1);
    let to = items.indexOf(t.item);
    if (t.after) to++;
    items.splice(to, 0, moved);
    reorder();
  });

  function reorder() {
    items.forEach((item) => grid.appendChild(item.el));
    refresh();
  }

  $('add-files').addEventListener('click', () => $('file-input').click());
  $('sort-name').addEventListener('click', () => {
    const collator = new Intl.Collator('ja', { numeric: true });
    items.sort((a, b) => collator.compare(a.file.name, b.file.name));
    reorder();
  });
  $('clear').addEventListener('click', () => {
    [...items].forEach(removeItem);
    nameEdited = false;
    statusEl.textContent = '';
  });

  // ================= ページ範囲 =================
  // "1-3, 5, 8-" → [1, 2, 3, 5, 8, …]。空欄はすべて、不正なら null
  function parseRange(text, max) {
    const t = text.normalize('NFKC').replace(/\s/g, '').replace(/[、]/g, ',').replace(/[ー〜~]/g, '-');
    if (!t) return Array.from({ length: max }, (_, i) => i + 1);
    const pages = new Set();
    for (const part of t.split(',')) {
      if (!part) continue;
      const m = part.match(/^(\d+)$|^(\d*)-(\d*)$/);
      if (!m || (m[1] === undefined && !m[2] && !m[3])) return null;
      const a = m[1] ? +m[1] : m[2] ? +m[2] : 1;
      const b = m[1] ? +m[1] : m[3] ? +m[3] : max;
      if (a < 1 || b > max || a > b) return null;
      for (let i = a; i <= b; i++) pages.add(i);
    }
    return pages.size ? [...pages].sort((x, y) => x - y) : null;
  }

  const pagesOf = (item) => parseRange(item.rangeInput.value, item.numPages);

  // ================= 設定 UI =================
  const getOutput = () => OUTPUTS[outFormat.value];
  const readyItems = () => items.filter((x) => x.ready);

  function refresh() {
    const has = items.length > 0;
    // ファイルがなければドロップ画面、あれば一覧＋設定の編集画面
    $('drop-card').classList.toggle('hidden', has);
    $('list-card').classList.toggle('hidden', !has);
    $('side').classList.toggle('hidden', !has);
    document.body.classList.toggle('has-side', has);
    grid.querySelectorAll('.order').forEach((el, i) => { el.textContent = i + 1; });

    // 入力形式（自動判定・変更不可）
    const counts = new Map();
    items.forEach((x) => {
      const label = INPUT_LABELS[x.type] || '不明';
      counts.set(label, (counts.get(label) || 0) + 1);
    });
    inType.innerHTML = '';
    counts.forEach((n, label) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = counts.size > 1 ? `${label} ×${n}` : label;
      inType.appendChild(chip);
    });

    const out = getOutput();
    const ready = readyItems();
    const hasPdf = ready.some((x) => x.type === 'pdf');
    const pdfOut = out.ext === 'pdf';
    $('quality-label').classList.toggle('hidden', !out.lossy);
    $('quality-val').textContent = Math.round(quality.value * 100);
    $('dpi-row').classList.toggle('hidden', !hasPdf || pdfOut);
    $('pdf-opts').classList.toggle('hidden', !pdfOut);
    const fit = paper.value === 'fit';
    $('orient-label').classList.toggle('hidden', fit);
    $('margin-label').classList.toggle('hidden', fit);

    // 出力件数
    const invalid = ready.filter((x) => x.type === 'pdf' && !pagesOf(x));
    const units = ready.reduce((n, x) => n + (x.type === 'pdf' ? (pagesOf(x) || []).length : 1), 0);
    const loading = items.filter((x) => !x.ready && !x.error).length;
    const failed = items.filter((x) => x.error).length;
    $('count').textContent =
      `${items.length} ファイル` + (loading ? `（読み込み中 ${loading}）` : '') + (failed ? `（読み込めないもの ${failed} 件は除外）` : '');

    $('name-row').classList.toggle('hidden', !pdfOut && units <= 1);
    $('out-ext').textContent = pdfOut ? '.pdf' : '.zip';

    downloadBtn.disabled = busy || units === 0 || invalid.length > 0;
    if (invalid.length) downloadBtn.textContent = 'ページ範囲の指定が正しくありません';
    else if (pdfOut) downloadBtn.textContent = `PDF（${units} ページ）を作成してダウンロード`;
    else if (units > 1) downloadBtn.textContent = `${out.label} ${units} 件を ZIP でダウンロード`;
    else downloadBtn.textContent = `${out.label} をダウンロード`;
  }

  [outFormat, paper, dpiSel].forEach((el) => el.addEventListener('change', refresh));
  quality.addEventListener('input', refresh);
  outName.addEventListener('input', () => { nameEdited = true; });

  // ================= 変換 =================
  async function imageToBlob(item, mime, q) {
    const el = await loadImage(item.url);
    const s = fitScale(item.w, item.h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(item.w * s);
    canvas.height = Math.floor(item.h * s);
    const ctx = canvas.getContext('2d');
    // JPEGは透過非対応なので白背景を敷く
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, mime, q);
    canvas.width = canvas.height = 0; // メモリ解放
    return blob;
  }

  async function renderPageBlob(item, n, mime, q, dpi) {
    const page = await item.pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: fitScale(vp1.width, vp1.height, dpi / 72) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    const blob = await canvasToBlob(canvas, mime, q);
    canvas.width = canvas.height = 0; // メモリ解放
    return blob;
  }

  // ---- PDF 出力 ----
  // JPEGのEXIF Orientation を取得（1 = 回転なし）
  function jpegOrientation(buf) {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { // "Exif"
        const tiff = off + 10;
        const little = v.getUint16(tiff) === 0x4949;
        const ifd = tiff + v.getUint32(tiff + 4, little);
        const count = v.getUint16(ifd, little);
        for (let i = 0; i < count; i++) {
          const entry = ifd + 2 + i * 12;
          if (v.getUint16(entry, little) === 0x0112) return v.getUint16(entry + 8, little);
        }
        return 1;
      }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      off += 2 + len;
    }
    return 1;
  }

  // 壊れたEXIFで範囲外を読んだ場合は「回転あり」扱いにしてキャンバス経由で変換する
  const safeOrientation = (buf) => {
    try { return jpegOrientation(buf); } catch { return 0; }
  };

  // 画像を pdf-lib に埋め込む。JPEG/PNG はそのまま（無劣化）、それ以外はPNGに変換
  async function embedImage(doc, item) {
    const buf = await item.file.arrayBuffer();
    try {
      if (item.type === 'jpeg' && safeOrientation(buf) === 1) return await doc.embedJpg(buf);
      if (item.type === 'png') return await doc.embedPng(buf);
    } catch {
      // 埋め込めない形式（CMYK PNG 等）はキャンバス経由で変換する
    }
    // 回転情報付きJPEG・WebP・GIF 等はブラウザで描画して再エンコード
    const isJpeg = item.type === 'jpeg';
    const blob = await imageToBlob(item, isJpeg ? 'image/jpeg' : 'image/png', 0.95);
    const bytes = await blob.arrayBuffer();
    return isJpeg ? doc.embedJpg(bytes) : doc.embedPng(bytes);
  }

  function pageLayout(item) {
    if (paper.value === 'fit') {
      const w = item.w * PT_PER_PX;
      const h = item.h * PT_PER_PX;
      return { pw: w, ph: h, x: 0, y: 0, w, h };
    }
    let [pw, ph] = PAPER_MM[paper.value].map((mm) => mm * PT_PER_MM);
    const o = orient.value;
    const landscape = o === 'landscape' || (o === 'auto' && item.w > item.h);
    if (landscape) [pw, ph] = [ph, pw];

    const maxMargin = Math.min(pw, ph) / 2 - 1;
    const m = Math.min(Math.max(parseFloat(margin.value) || 0, 0) * PT_PER_MM, maxMargin);
    const aw = pw - m * 2;
    const ah = ph - m * 2;
    const s = Math.min(aw / item.w, ah / item.h);
    const w = item.w * s;
    const h = item.h * s;
    return { pw, ph, x: (pw - w) / 2, y: (ph - h) / 2, w, h };
  }

  async function appendPdf(doc, item) {
    const pages = pagesOf(item);
    let src = null;
    try {
      src = await PDFLib.PDFDocument.load(await item.file.arrayBuffer());
    } catch {
      // 暗号化PDFなどは下で画像化して取り込む
    }
    if (src) {
      const copied = await doc.copyPages(src, pages.map((n) => n - 1));
      copied.forEach((p) => doc.addPage(p));
      return;
    }
    const dpi = Number(dpiSel.value);
    for (const n of pages) {
      const page = await item.pdf.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      const blob = await renderPageBlob(item, n, 'image/jpeg', 0.92, dpi);
      const img = await doc.embedJpg(await blob.arrayBuffer());
      doc.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
    }
  }

  async function buildPdf(targets) {
    const doc = await PDFLib.PDFDocument.create();
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      statusEl.textContent = `PDFを作成中… ${i + 1} / ${targets.length}`;
      if (item.type === 'pdf') {
        await appendPdf(doc, item);
      } else {
        const embedded = await embedImage(doc, item);
        const { pw, ph, x, y, w, h } = pageLayout(item);
        doc.addPage([pw, ph]).drawImage(embedded, { x, y, width: w, height: h });
      }
    }
    return doc.save();
  }

  // ---- 画像出力：1ファイル（PDFは1ページ）ごとの出力を列挙 ----
  function imageJobs(targets, out) {
    const q = parseFloat(quality.value);
    const dpi = Number(dpiSel.value);
    const jobs = [];
    for (const item of targets) {
      const base = baseName(item.file.name, 'image');
      if (item.type === 'pdf') {
        const digits = String(item.numPages).length;
        for (const n of pagesOf(item)) {
          jobs.push({
            name: `${base}_p${String(n).padStart(digits, '0')}.${out.ext}`,
            make: () => renderPageBlob(item, n, out.mime, q, dpi),
          });
        }
      } else {
        jobs.push({ name: `${base}.${out.ext}`, make: () => imageToBlob(item, out.mime, q) });
      }
    }
    // 同名ファイルが上書きされないよう連番を付ける
    const used = new Set();
    for (const job of jobs) {
      let name = job.name;
      for (let i = 2; used.has(name); i++) name = job.name.replace(/(\.[^.]+)$/, `_${i}$1`);
      used.add(name);
      job.name = name;
    }
    return jobs;
  }

  async function runExport(targets, name) {
    targets = targets.filter((x) => x.ready);
    if (busy || !targets.length) return;
    if (targets.some((x) => x.type === 'pdf' && !pagesOf(x))) {
      statusEl.textContent = 'ページ範囲の指定が正しくありません。';
      return;
    }
    busy = true;
    refresh();
    const out = getOutput();
    try {
      if (out.ext === 'pdf') {
        const bytes = await buildPdf(targets);
        downloadBlob(new Blob([bytes], { type: out.mime }), `${name}.pdf`);
      } else {
        const jobs = imageJobs(targets, out);
        if (jobs.length === 1) {
          statusEl.textContent = '変換中…';
          downloadBlob(await jobs[0].make(), jobs[0].name);
        } else {
          const zip = new JSZip();
          for (let i = 0; i < jobs.length; i++) {
            statusEl.textContent = `変換中… ${i + 1} / ${jobs.length}`;
            zip.file(jobs[i].name, await jobs[i].make());
          }
          statusEl.textContent = 'ZIP を作成中…';
          // 画像は圧縮済みなので無圧縮で格納
          const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
          downloadBlob(blob, `${name}.zip`);
        }
      }
      statusEl.textContent = '完了しました。';
    } catch (err) {
      statusEl.textContent = `エラーが発生しました（${err.message}）`;
    } finally {
      busy = false;
      refresh();
    }
  }

  downloadBtn.addEventListener('click', () =>
    runExport(items, (outName.value.trim() || 'converted').replace(/\.(pdf|zip)$/i, ''))
  );
})();
