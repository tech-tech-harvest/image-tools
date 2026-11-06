// 道具ごとの作業の保存・復元と、道具間の画像の受け渡し（ブラウザの中の IndexedDB を使い、外部には送らない）。
// 画像は Blob のままだと Safari がローカルファイルで開いたページで保存できないため、ArrayBuffer にして保存する。
// 保存できない環境では、何もせずに今までどおり動く。
(() => {
  'use strict';

  const DB_NAME = 'resise-pic-tools';
  const SESSIONS = 'sessions';
  const HANDOFF = 'handoff';
  const SAVE_DELAY = 800; // 編集が止まってから保存するまでの時間（ms）

  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(SESSIONS);
          req.result.createObjectStore(HANDOFF);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch(() => null);
    }
    return dbPromise;
  }

  async function run(store, mode, fn) {
    const d = await db();
    if (!d) return undefined;
    return new Promise((resolve) => {
      try {
        const tx = d.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => resolve(undefined);
        tx.onabort = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  // Blob（File）⇔ 保存用の形
  const pack = async (blob, name) => ({ buf: await blob.arrayBuffer(), type: blob.type, name: name || blob.name || 'image' });
  const unpack = (r) => new File([r.buf], r.name, { type: r.type });

  // ================= 作業の保存・復元 =================
  // files: [{ blob, name, key? }]（key は画像以外の用途の目印。例：ロゴ）、data: そのほかの設定（JSON にできる値）
  async function save(page, { files = [], data = {} } = {}) {
    const packed = await Promise.all(files.map(async (f) => ({ ...(await pack(f.blob, f.name)), key: f.key || null })));
    await run(SESSIONS, 'readwrite', (s) => s.put({ files: packed, data, savedAt: Date.now() }, page));
  }

  async function load(page) {
    const r = await run(SESSIONS, 'readonly', (s) => s.get(page));
    if (!r) return null;
    return { files: r.files.map((f) => Object.assign(unpack(f), { key: f.key })), data: r.data || {} };
  }

  const clear = (page) => run(SESSIONS, 'readwrite', (s) => s.delete(page));

  // 編集のたびに schedule() を呼ぶと、少し待ってから collect() の内容を保存する。
  // collect() が null を返したら保存を消す（ユーザーが画像をすべて外した）。
  // undefined なら何もしない（まだ画像を読み込む前など。復元前に保存を消さないため）
  const flushers = new Set();
  function autosave(page, collect) {
    let timer = 0;
    let pending = false;
    let enabled = true;
    async function flush() {
      clearTimeout(timer);
      if (!pending || !enabled) return;
      pending = false;
      try {
        const content = await collect();
        if (content) await save(page, content);
        else if (content === null) await clear(page);
      } catch {
        // 保存できなくても編集は続けられる
      }
    }
    flushers.add(flush);
    return {
      schedule() {
        if (!enabled) return;
        pending = true;
        clearTimeout(timer);
        timer = setTimeout(flush, SAVE_DELAY);
      },
      flush,
      // 復元の途中などで、保存を一時的に止める
      pause() { enabled = false; },
      resume() { enabled = true; },
    };
  }
  // ページを離れる前に、まだ保存していない作業を保存する
  const flushAll = () => Promise.all([...flushers].map((f) => f()));
  window.addEventListener('pagehide', () => { flushAll(); });

  // ================= 道具間の画像の受け渡し =================
  // 受け取れる道具（ナビのページの path）
  const RECEIVERS = ['index.html', 'edit/index.html', 'resize/index.html', 'mosaic/index.html', 'bg-remove/index.html', 'watermark/index.html', 'metadata/index.html'];

  async function send(target, files) {
    const packed = await Promise.all(files.map((f) => pack(f.blob, f.name)));
    await run(HANDOFF, 'readwrite', (s) => s.put({ target, files: packed, at: Date.now() }, 'pending'));
    await flushAll();
    location.href = window.SiteNav.url(target);
  }

  // このページあての画像があれば受け取る（受け取ったら消す。古すぎるものは使わない）
  async function takeHandoff(page) {
    const r = await run(HANDOFF, 'readonly', (s) => s.get('pending'));
    if (!r) return null;
    await run(HANDOFF, 'readwrite', (s) => s.delete('pending'));
    if (r.target !== page || Date.now() - r.at > 10 * 60 * 1000) return null;
    return r.files.map(unpack);
  }

  // 「ほかの道具で開く」のドロップダウン。getFiles() は送る画像 [{ blob, name }] を返す（なければ null）
  function mountSendTo(container, page, getFiles) {
    const select = document.createElement('select');
    select.className = 'dd send-to';
    select.setAttribute('aria-label', 'ほかの道具で開く');
    select.innerHTML = '<option value="">ほかの道具で開く…</option>';
    window.SiteNav.pages
      .filter(([path]) => path !== page && RECEIVERS.includes(path))
      .forEach(([path, label]) => {
        const o = document.createElement('option');
        o.value = path;
        o.textContent = label;
        select.appendChild(o);
      });
    select.addEventListener('change', async () => {
      const target = select.value;
      if (!target) return;
      select.disabled = true;
      select.options[0].textContent = '画像を送っています…';
      select.value = '';
      try {
        const files = await getFiles();
        if (!files || !files.length) throw new Error('送る画像がありません');
        await send(target, files);
      } catch (err) {
        alert(`ほかの道具で開けませんでした（${err.message || err}）`);
        select.disabled = false;
        select.options[0].textContent = 'ほかの道具で開く…';
      }
    });
    container.appendChild(select);
    return select;
  }

  window.ToolStore = { save, load, clear, autosave, flushAll, send, takeHandoff, mountSendTo };
})();
