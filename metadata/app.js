(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const statusEl = $('status');
  const downloadBtn = $('download');

  const MODE_NOTES = {
    gps: '撮影場所（緯度・経度・高度など）だけを削除します。撮影日時やカメラの機種は残ります。',
    all: '撮影場所に加えて、撮影日時・機種・ソフト名・コメントなども削除します。写真の向きと色の情報（カラープロファイル）は、見た目が変わらないよう残します。',
  };

  // ================= 共通 =================
  const ascii = (bytes, start, len) => String.fromCharCode(...bytes.subarray(start, start + len));

  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    parts.forEach((p) => { out.set(p, off); off += p.length; });
    return out;
  }

  // ================= EXIF（TIFF 形式）の読み取り =================
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  const TAG = {
    make: 0x010f, model: 0x0110, orientation: 0x0112, software: 0x0131, dateTime: 0x0132,
    exifIfd: 0x8769, gpsIfd: 0x8825, dateOriginal: 0x9003,
    gpsLatRef: 1, gpsLat: 2, gpsLonRef: 3, gpsLon: 4,
  };

  // tiff: TIFF ヘッダの位置、tiffEnd: 終わり。壊れたデータでも範囲外を読まないようにする
  function readTiff(bytes, tiff, tiffEnd) {
    const order = ascii(bytes, tiff, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const little = order === 'II';
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const inRange = (o, n) => o >= tiff && o + n <= tiffEnd;
    const u16 = (o) => v.getUint16(o, little);
    const u32 = (o) => v.getUint32(o, little);

    function ifd(offset) {
      const at = tiff + offset;
      if (!offset || !inRange(at, 2)) return null;
      const count = u16(at);
      if (!inRange(at + 2, count * 12 + 4)) return null;
      const entries = [];
      for (let i = 0; i < count; i++) {
        const e = at + 2 + i * 12;
        const type = u16(e + 2);
        const n = u32(e + 4);
        const size = (TYPE_SIZE[type] || 1) * n;
        const valueAt = size <= 4 ? e + 8 : tiff + u32(e + 8);
        entries.push({ tag: u16(e), type, count: n, size, valueAt, ok: inRange(valueAt, size) });
      }
      return { at, count, entries };
    }

    const get = (dir, tag) => dir && dir.entries.find((x) => x.tag === tag && x.ok);
    const num = (e) => (e ? (e.type === 3 ? u16(e.valueAt) : u32(e.valueAt)) : 0);
    const ifd0 = inRange(tiff + 4, 4) ? ifd(u32(tiff + 4)) : null;
    const exifPtr = get(ifd0, TAG.exifIfd);
    const gpsPtr = get(ifd0, TAG.gpsIfd);
    return {
      ifd0,
      exif: exifPtr ? ifd(num(exifPtr)) : null,
      gps: gpsPtr ? ifd(num(gpsPtr)) : null,
      get,
      num,
      str: (e) => (e ? ascii(bytes, e.valueAt, e.count).replace(/\0[\s\S]*$/, '').trim() : ''),
      rationals: (e) => Array.from({ length: e.count }, (_, i) => {
        const d = u32(e.valueAt + i * 8 + 4);
        return d ? u32(e.valueAt + i * 8) / d : 0;
      }),
    };
  }

  // 表示用に、撮影場所・日時・機種などを取り出す
  function describeTiff(t) {
    const info = {
      make: t.str(t.get(t.ifd0, TAG.make)),
      model: t.str(t.get(t.ifd0, TAG.model)),
      software: t.str(t.get(t.ifd0, TAG.software)),
      date: t.str(t.get(t.exif, TAG.dateOriginal)) || t.str(t.get(t.ifd0, TAG.dateTime)),
      orientation: t.num(t.get(t.ifd0, TAG.orientation)) || 1,
      gps: null,
      gpsPartial: false,
    };
    if (t.gps && t.gps.count) {
      const lat = t.get(t.gps, TAG.gpsLat);
      const lon = t.get(t.gps, TAG.gpsLon);
      if (lat && lon && lat.count >= 3 && lon.count >= 3) {
        const deg = ([d, m, s]) => d + m / 60 + s / 3600;
        let la = deg(t.rationals(lat));
        let lo = deg(t.rationals(lon));
        if (t.str(t.get(t.gps, TAG.gpsLatRef)) === 'S') la = -la;
        if (t.str(t.get(t.gps, TAG.gpsLonRef)) === 'W') lo = -lo;
        info.gps = { lat: la, lon: lo };
      } else {
        info.gpsPartial = true; // 緯度経度はないが、GPS の時刻などが入っている
      }
    }
    return info;
  }

  // 位置情報の項目を 0 で塗りつぶし、件数を 0 にする（中身ごと消えるので復元できない）
  function wipeGps(out, t) {
    const g = t && t.gps;
    if (!g) return;
    g.entries.forEach((e) => { if (e.size > 4 && e.ok) out.fill(0, e.valueAt, e.valueAt + e.size); });
    out.fill(0, g.at, g.at + 2 + g.count * 12 + 4); // 件数・各項目・次へのリンク
  }

  // ================= JPEG =================
  // SOI の後に「マーカー＋長さ＋中身」の並びが続く。SOS（画像データ）から後ろは一切触らない
  function jpegSegments(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const segs = [];
    let off = 2;
    while (off + 4 <= bytes.length) {
      if (bytes[off] !== 0xff) throw new Error('JPEG の構造が壊れています');
      const marker = bytes[off + 1];
      if (marker === 0xff) { off++; continue; } // 詰め物
      if (marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { off += 2; continue; } // 長さのないマーカー
      const end = off + 2 + v.getUint16(off + 2);
      if (end > bytes.length) throw new Error('JPEG の構造が壊れています');
      segs.push({ marker, start: off, end, data: off + 4 });
      off = end;
    }
    return { segs, imageStart: off };
  }

  const isExif = (bytes, s) => s.marker === 0xe1 && ascii(bytes, s.data, 6) === 'Exif\0\0';
  const isXmp = (bytes, s) => s.marker === 0xe1 && ascii(bytes, s.data, 29) === 'http://ns.adobe.com/xap/1.0/\0';
  const XMP_GPS = /exif:GPS(Latitude|Longitude)/;

  function analyzeJpeg(bytes) {
    const { segs, imageStart } = jpegSegments(bytes);
    const a = { segs, imageStart, info: { orientation: 1 }, extras: [], tiffs: [], xmpGps: false };
    segs.forEach((s) => {
      if (isExif(bytes, s)) {
        // EXIF が複数入っているファイルもあるので、すべて調べる（表示は最初のもの、位置情報はどれかにあれば）
        const t = readTiff(bytes, s.data + 6, s.end);
        if (!t) return;
        const info = describeTiff(t);
        if (!a.tiffs.length) a.info = info;
        else if (!a.info.gps && (info.gps || info.gpsPartial)) Object.assign(a.info, { gps: info.gps, gpsPartial: info.gpsPartial });
        a.tiffs.push(t);
      } else if (isXmp(bytes, s)) {
        a.extras.push('XMP');
        if (XMP_GPS.test(new TextDecoder().decode(bytes.subarray(s.data, s.end)))) a.xmpGps = true;
      } else if (s.marker === 0xed) {
        a.extras.push('IPTC');
      } else if (s.marker === 0xfe) {
        a.extras.push('コメント');
      }
    });
    return a;
  }

  // 向きだけを持つ最小の EXIF（すべて削除しても写真が横倒しにならないように）
  function orientationExif(orientation) {
    const seg = new Uint8Array(36);
    const v = new DataView(seg.buffer);
    v.setUint16(0, 0xffe1);
    v.setUint16(2, seg.length - 2);
    seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
    seg.set([0x4d, 0x4d, 0x00, 0x2a], 10);      // ビッグエンディアンの TIFF
    v.setUint32(14, 8);                          // 最初の IFD の位置
    v.setUint16(18, 1);                          // 項目数
    v.setUint16(20, TAG.orientation);
    v.setUint16(22, 3);                          // SHORT
    v.setUint32(24, 1);
    v.setUint16(28, orientation);
    v.setUint32(32, 0);                          // 次の IFD なし
    return seg;
  }

  function cleanJpeg(bytes, mode) {
    const a = analyzeJpeg(bytes);
    // 消す部分：位置情報だけなら GPS を含む XMP、すべてなら EXIF・XMP・IPTC・コメントなど（色・向き以外）
    const drop = (s) => (mode === 'gps'
      ? a.xmpGps && isXmp(bytes, s)
      : s.marker === 0xe1 || (s.marker >= 0xe3 && s.marker <= 0xed) || s.marker === 0xef || s.marker === 0xfe);

    const source = bytes.slice();
    if (mode === 'gps') a.tiffs.forEach((t) => wipeGps(source, t));

    const kept = a.segs.filter((s) => !drop(s)).map((s) => source.subarray(s.start, s.end));
    if (mode === 'all' && a.info.orientation > 1) {
      // 向きの EXIF は、先頭の APP0（JFIF）があればその直後、なければ先頭に入れる
      kept.splice(a.segs[0] && a.segs[0].marker === 0xe0 ? 1 : 0, 0, orientationExif(a.info.orientation));
    }
    const parts = [source.subarray(0, 2), ...kept];
    parts.push(source.subarray(a.imageStart));
    return concat(parts);
  }

  // ================= PNG =================
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const PNG_TEXT = ['tEXt', 'zTXt', 'iTXt'];

  function pngChunks(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    let off = 8;
    while (off + 12 <= bytes.length) {
      const len = v.getUint32(off);
      const type = ascii(bytes, off + 4, 4);
      const end = off + 12 + len;
      if (end > bytes.length) throw new Error('PNG の構造が壊れています');
      chunks.push({ type, start: off, end, data: off + 8, len });
      off = end;
      if (type === 'IEND') break;
    }
    return chunks;
  }

  function analyzePng(bytes) {
    const chunks = pngChunks(bytes);
    const a = { chunks, info: { orientation: 1 }, extras: [], tiff: null, exifChunk: null, xmpGps: false };
    chunks.forEach((c) => {
      if (c.type === 'eXIf') {
        const t = readTiff(bytes, c.data, c.data + c.len);
        if (t) { a.tiff = t; a.exifChunk = c; a.info = describeTiff(t); }
      } else if (PNG_TEXT.includes(c.type)) {
        if (!a.extras.includes('テキスト情報')) a.extras.push('テキスト情報');
        if (XMP_GPS.test(new TextDecoder().decode(bytes.subarray(c.data, c.data + c.len)))) a.xmpGps = true;
      } else if (c.type === 'tIME') {
        a.extras.push('更新日時');
      }
    });
    return a;
  }

  const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // 向きだけを持つ eXIf チャンク（中身は JPEG 用の最小 EXIF の TIFF 部分と同じ）
  function orientationChunk(orientation) {
    const tiff = orientationExif(orientation).subarray(10);
    const chunk = new Uint8Array(12 + tiff.length);
    const v = new DataView(chunk.buffer);
    v.setUint32(0, tiff.length);
    chunk.set([0x65, 0x58, 0x49, 0x66], 4); // "eXIf"
    chunk.set(tiff, 8);
    v.setUint32(8 + tiff.length, crc32(chunk.subarray(4, 8 + tiff.length)));
    return chunk;
  }

  function cleanPng(bytes, mode) {
    const a = analyzePng(bytes);
    const source = bytes.slice();
    if (mode === 'gps' && a.exifChunk) {
      wipeGps(source, a.tiff);
      // 中身を書き換えたのでチェック値を計算し直す
      const c = a.exifChunk;
      new DataView(source.buffer).setUint32(c.end - 4, crc32(source.subarray(c.start + 4, c.end - 4)));
    }
    const drop = (c) => (mode === 'gps'
      ? a.xmpGps && PNG_TEXT.includes(c.type) && XMP_GPS.test(new TextDecoder().decode(source.subarray(c.data, c.data + c.len)))
      : c.type === 'eXIf' || c.type === 'tIME' || PNG_TEXT.includes(c.type));
    const parts = [source.subarray(0, 8)];
    a.chunks.forEach((c) => {
      if (!drop(c)) parts.push(source.subarray(c.start, c.end));
      // すべて削除でも向きは残す（IHDR の直後に、向きだけの eXIf を入れる）
      if (c.type === 'IHDR' && mode === 'all' && a.info.orientation > 1) parts.push(orientationChunk(a.info.orientation));
    });
    return concat(parts);
  }

  // ================= 形式の判定 =================
  function kindOf(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
    if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'png';
    return null;
  }
  const analyze = (kind, bytes) => (kind === 'jpeg' ? analyzeJpeg(bytes) : analyzePng(bytes));
  const clean = (kind, bytes, mode) => (kind === 'jpeg' ? cleanJpeg(bytes, mode) : cleanPng(bytes, mode));
  const hasLocation = (a) => !!(a.info.gps || a.info.gpsPartial || a.xmpGps);

  // ================= ファイルの追加・削除 =================
  // { id, file, url, kind, bytes, before, after, out, error, el }
  let items = [];
  let nextId = 1;

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files.length) addFiles([...e.target.files]);
    e.target.value = '';
  });
  $('add-files').addEventListener('click', () => $('file-input').click());
  $('clear').addEventListener('click', () => [...items].forEach(removeItem));

  async function addFiles(files) {
    const wasEmpty = items.length === 0;
    for (const file of files) {
      const item = { id: nextId++, file, url: URL.createObjectURL(file) };
      try {
        item.bytes = new Uint8Array(await file.arrayBuffer());
        item.kind = kindOf(item.bytes);
        if (!item.kind) throw new Error('この形式は未対応です（JPEG・PNG のみ）。「形式変換」で JPEG にすると、付加情報のない画像になります。');
        item.before = analyze(item.kind, item.bytes);
      } catch (err) {
        item.error = err.message;
      }
      item.el = createRow(item);
      grid.appendChild(item.el);
      items.push(item);
      process(item);
    }
    if (wasEmpty && items.length) window.scrollTo(0, 0);
    refresh();
  }

  function removeItem(item) {
    URL.revokeObjectURL(item.url);
    item.el.remove();
    items = items.filter((x) => x !== item);
    refresh();
  }

  // ================= 削除の実行（モードを変えたら作り直す） =================
  const getMode = () => document.querySelector('input[name="mode"]:checked').value;

  function process(item) {
    if (item.error && !item.before) {
      updateRow(item); // 読み込めなかった理由を表示する
      return;
    }
    try {
      item.out = clean(item.kind, item.bytes, getMode());
      item.after = analyze(item.kind, item.out);
      // 念のため、消したあとのファイルを読み直して位置情報が残っていないか確かめる
      if (hasLocation(item.after)) throw new Error('位置情報を削除できませんでした');
      item.error = null;
    } catch (err) {
      item.out = null;
      item.error = err.message;
    }
    updateRow(item);
  }

  function onModeChange() {
    $('mode-note').textContent = MODE_NOTES[getMode()];
    items.forEach(process);
    refresh();
  }
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', onModeChange));
  $('mode-note').textContent = MODE_NOTES[getMode()];

  // ================= 一覧の表示 =================
  function createRow(item) {
    const div = document.createElement('div');
    div.className = 'meta-row';
    div.innerHTML = `
      <div class="meta-thumb"><img alt=""></div>
      <div class="meta-body">
        <div class="meta-name"></div>
        <dl class="meta-info"></dl>
        <div class="meta-result"></div>
      </div>
      <div class="meta-actions">
        <button type="button" class="save-one" disabled>保存</button>
        <button type="button" class="remove" title="削除">×</button>
      </div>`;
    div.querySelector('img').src = item.url;
    div.querySelector('.meta-name').textContent = item.file.name;
    div.querySelector('.remove').addEventListener('click', () => removeItem(item));
    div.querySelector('.save-one').addEventListener('click', () => {
      if (item.out) downloadBlob(new Blob([item.out], { type: item.file.type }), item.file.name);
    });
    return div;
  }

  function infoRows(a) {
    const i = a.info;
    const rows = [];
    rows.push(['撮影場所', i.gps ? `${i.gps.lat.toFixed(5)}, ${i.gps.lon.toFixed(5)}` : i.gpsPartial || a.xmpGps ? 'あり' : 'なし', !!(i.gps || i.gpsPartial || a.xmpGps)]);
    if (i.date) rows.push(['撮影日時', i.date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1/$2/$3')]);
    const device = [i.make, i.model].filter(Boolean).join(' ');
    if (device) rows.push(['機種', device]);
    if (i.software) rows.push(['ソフト', i.software]);
    if (a.extras.length) rows.push(['その他', [...new Set(a.extras)].join('・')]);
    return rows;
  }

  function updateRow(item) {
    const el = item.el;
    el.classList.toggle('error', !!item.error);
    el.querySelector('.save-one').disabled = !item.out;
    const dl = el.querySelector('.meta-info');
    dl.innerHTML = '';
    if (item.before) {
      infoRows(item.before).forEach(([k, v, warn]) => {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = v;
        if (warn) dd.className = 'warn';
        dl.append(dt, dd);
      });
    }
    const result = el.querySelector('.meta-result');
    result.className = 'meta-result';
    if (item.error) {
      result.textContent = item.error;
      result.classList.add('ng');
    } else if (item.out) {
      const had = hasLocation(item.before);
      result.textContent = getMode() === 'all'
        ? '✓ 位置情報・撮影日時・機種などを削除しました'
        : had ? '✓ 位置情報を削除しました' : '✓ 位置情報は含まれていません';
      result.classList.add('ok');
    }
  }

  function refresh() {
    const has = items.length > 0;
    $('drop-card').classList.toggle('hidden', has);
    $('list-card').classList.toggle('hidden', !has);
    $('side').classList.toggle('hidden', !has);
    document.body.classList.toggle('has-side', has);

    const ready = items.filter((x) => x.out);
    const withGps = items.filter((x) => x.before && hasLocation(x.before)).length;
    $('summary').textContent = `${items.length} 件中 ${withGps} 件に位置情報あり`;
    downloadBtn.disabled = ready.length === 0;
    downloadBtn.textContent = ready.length > 1 ? `${ready.length} 件を ZIP でダウンロード` : 'ダウンロード';
    statusEl.textContent = '';
  }

  // ================= ダウンロード =================
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  downloadBtn.addEventListener('click', async () => {
    const ready = items.filter((x) => x.out);
    if (ready.length === 1) {
      downloadBlob(new Blob([ready[0].out], { type: ready[0].file.type }), ready[0].file.name);
      return;
    }
    downloadBtn.disabled = true;
    statusEl.textContent = 'ZIP を作成中…';
    const zip = new JSZip();
    const used = new Set();
    ready.forEach((item) => {
      // 同名ファイルが上書きされないよう連番を付ける
      let name = item.file.name;
      for (let i = 2; used.has(name); i++) name = item.file.name.replace(/(\.[^.]+)?$/, `_${i}$1`);
      used.add(name);
      zip.file(name, item.out);
    });
    downloadBlob(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), 'no-location.zip');
    refresh();
  });
})();
