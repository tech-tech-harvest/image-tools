(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ブラウザのキャンバス上限を超えないようにするための制限
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_AREA = 100_000_000;
  const MASK_MAX_SIDE = 2048; // 残す範囲（マスク）の解像度の上限。履歴のメモリを抑える
  const HISTORY_LIMIT = 30;

  // AI：Transformers.js と ormbg（どちらも Apache-2.0）。
  // ボタンを押したときに初めて CDN から読み込み、モデルは以降ブラウザにキャッシュされる
  const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
  const MODEL_ID = 'onnx-community/ormbg-ONNX';
  // 準備中に Worker からこの時間返事がなければ、Worker をやめて画面側でやり直す
  const WORKER_SILENCE_LIMIT = 20000;
  // AI の出力のうち、ほぼ透明・ほぼ不透明な部分は完全な透明・不透明にそろえる（被写体がうっすら透けるのを防ぐ）
  const ALPHA_CLEAN_LOW = 10;
  const ALPHA_CLEAN_HIGH = 240;

  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  const workspace = $('workspace');
  const fileInfo = $('file-info');
  const toolHint = $('tool-hint');
  const stage = $('stage');
  const view = $('view');
  const toleranceInput = $('tolerance');
  const bgMode = $('bg-mode');
  const bgColor = $('bg-color');
  const aiBtn = $('btn-ai');
  const aiStatus = $('ai-status');

  const makeCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  let fileName = 'image';
  let currentFile = null; // 作業の保存に使う元のファイル
  let sourceType = '';
  let src = null;   // 元画像
  let mask = null;  // 残す範囲（不透明な部分が残る）
  let before = null;
  let ms = 1;       // 元画像px → マスクpx
  let undoStack = [];
  let redoStack = [];
  let action = null;
  let colors = null; // 色で消すときに調べる、マスクと同じ大きさの元画像の画素
  let guideStep = 'start'; // 画像の上の手順案内（start → adjust → done）
  let guideTimer = 0;
  let showOriginal = false;
  let frame = 0;
  let aiRunning = false;

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

  // saved: 保存しておいた作業（復元するとき）
  function loadFile(file, saved) {
    if (!file.type.startsWith('image/')) {
      alert('画像ファイルを選択してください。');
      return;
    }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      setup(im, file);
      if (saved) restoreWork(saved);
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      alert('画像を読み込めませんでした。');
    };
    im.src = url;
  }

  function setup(im, file) {
    currentFile = file;
    fileName = file.name.replace(/\.[^.]+$/, '') || 'image';
    sourceType = file.type;
    const iw = im.naturalWidth;
    const ih = im.naturalHeight;
    const s = Math.min(1, MAX_CANVAS_SIDE / iw, MAX_CANVAS_SIDE / ih, Math.sqrt(MAX_CANVAS_AREA / (iw * ih)));
    const w = Math.max(1, Math.floor(iw * s));
    const h = Math.max(1, Math.floor(ih * s));

    src = makeCanvas(w, h);
    src.getContext('2d').drawImage(im, 0, 0, w, h);
    view.width = w;
    view.height = h;

    ms = Math.min(1, MASK_MAX_SIDE / Math.max(w, h));
    mask = makeCanvas(Math.max(1, Math.round(w * ms)), Math.max(1, Math.round(h * ms)));
    fillMask();
    before = makeCanvas(mask.width, mask.height);
    const cctx = makeCanvas(mask.width, mask.height).getContext('2d');
    cctx.drawImage(src, 0, 0, mask.width, mask.height);
    colors = cctx.getImageData(0, 0, mask.width, mask.height).data;

    undoStack = [];
    redoStack = [];
    fileInfo.textContent = `${file.name}（${iw} × ${ih} px）`;
    if (aiBlocked) setAiStatus(SAFARI_MESSAGE, true);
    else setAiStatus('初回のみAIモデル（約44〜88MB）をダウンロードします。画像は外部に送信されません。');

    // ドロップ画面から、左に画像・右に設定の編集画面へ
    $('step-input').classList.add('hidden');
    workspace.classList.remove('hidden');
    $('side').classList.remove('hidden');
    document.body.classList.add('has-side');
    window.scrollTo(0, 0);

    session = null;
    pickedColor = null;
    renderSwatches();
    guideStep = 'start';
    setView('edit');
    updateUI();
  }

  // 全体を「残す」状態にする
  function fillMask() {
    const ctx = mask.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, mask.width, mask.height);
  }

  // ================= 表示 =================
  const backgroundFill = () => (bgMode.value === 'white' ? '#ffffff' : bgMode.value === 'color' ? bgColor.value : null);

  // 元画像を「残す範囲」で切り抜き、背景色の指定があれば下に敷く（透明の部分は市松模様が見える）
  function compose(ctx, withBackground) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mask, 0, 0, view.width, view.height);
    const fill = withBackground && backgroundFill();
    if (fill) {
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, view.width, view.height);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function redraw() {
    saving.schedule();
    const ctx = view.getContext('2d');
    if (showOriginal) {
      ctx.clearRect(0, 0, view.width, view.height);
      ctx.drawImage(src, 0, 0);
      return;
    }
    compose(ctx, true);
  }

  const requestRedraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      redraw();
    });
  };

  bgMode.addEventListener('change', () => {
    $('bg-color-row').classList.toggle('hidden', bgMode.value !== 'color');
    if (src) redraw();
  });
  bgColor.addEventListener('input', () => { if (src) redraw(); });

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
    showGuide();
  }
  viewButtons.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  // ================= AI で自動削除 =================
  // AI の本体。Web Worker の中（画面を止めない）と、Worker が使えないときの画面側の両方で同じコードを使う。
  // post(message, transfer) で進み具合と結果を知らせる
  function aiCore(post, libUrl, modelId) {
    let lib = null;
    let seg = null;
    let device = null;

    async function load() {
      if (seg) return;
      post({ type: 'phase', phase: 'import', step: 'AIのプログラムを読み込んでいます…' });
      // 読み込みが返ってこないまま待ち続けないよう、60秒で打ち切る
      lib = lib || (await Promise.race([
        import(libUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('AIのプログラムを60秒以内に読み込めませんでした')), 60000)),
      ]));
      // progress_total は、読み込むファイル全体の合計量を最初から知らせてくれる
      const progress_callback = (p) => {
        if (p.status === 'progress_total' && p.total) post({ type: 'download', loaded: p.loaded, total: p.total });
        // 設定ファイルなど小さいものも done を出すので、モデル本体（.onnx）の完了で「起動中」に進める
        else if (p.status === 'done' && /\.onnx$/.test(p.file || '')) post({ type: 'phase', phase: 'init' });
      };
      // GPU（WebGPU）が使えれば速い版、使えなければ軽い版を CPU で動かす。
      // 環境によって確認が返ってこないことがあるので、3秒で打ち切って CPU にする
      post({ type: 'phase', phase: 'import', step: 'GPUが使えるか確認しています…' });
      const gpu = typeof navigator !== 'undefined' && navigator.gpu;
      const hasGpu = !!(gpu && (await Promise.race([
        gpu.requestAdapter().catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 3000)),
      ])));
      const tries = hasGpu
        ? [{ device: 'webgpu', dtype: 'fp16' }, { device: 'wasm', dtype: 'q8' }]
        : [{ device: 'wasm', dtype: 'q8' }];
      let lastError = null;
      for (const opts of tries) {
        try {
          post({ type: 'phase', phase: 'download', device: opts.device, step: opts.device === 'webgpu' ? 'AIモデル（約88MB）を読み込んでいます…（2回目以降は保存済みのものを使います）' : 'AIモデル（約44MB）を読み込んでいます…（2回目以降は保存済みのものを使います）' });
          seg = await lib.pipeline('background-removal', modelId, { ...opts, progress_callback });
          device = opts.device;
          return;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    }

    return async function handle({ data, width, height }) {
      try {
        await load();
        post({ type: 'phase', phase: 'infer', device, step: device === 'webgpu' ? '背景を削除しています…' : 'GPUが使えないため、数秒〜十数秒かかります…' });
        const out = await seg(new lib.RawImage(data, width, height, 4));
        // 透明度だけを取り出して返す
        const alpha = new Uint8ClampedArray(out.width * out.height);
        for (let i = 0, j = out.channels - 1; i < alpha.length; i++, j += out.channels) alpha[i] = out.data[j];
        post({ type: 'done', alpha, width: out.width, height: out.height }, [alpha.buffer]);
      } catch (err) {
        post({ type: 'error', message: String((err && err.message) || err) });
      }
    };
  }

  // Worker を作る（ローカルファイルで開いていても動くよう、コードを Blob にして渡す）。作れなければ画面側で動かす
  let aiRunner = null;
  function getRunner(onMessage) {
    if (aiRunner) {
      aiRunner.onMessage = onMessage;
      return aiRunner;
    }
    const runner = { onMessage };
    try {
      const code = `const handle = (${aiCore})((m, t) => self.postMessage(m, t || []), ${JSON.stringify(TRANSFORMERS_URL)}, ${JSON.stringify(MODEL_ID)});
self.onmessage = (e) => handle(e.data);`;
      // ローカルファイルで開いたページからは module 型の Worker を作れないため、通常の Worker にする（import() は使える）
      const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      const fallback = () => {
        clearTimeout(runner.watchdog);
        worker.terminate();
        const job = runner.pending;
        runner.run = inPage(runner);
        if (job) runner.run(job);
      };
      worker.onmessage = (e) => {
        clearTimeout(runner.watchdog);
        if (e.data.type === 'done' || e.data.type === 'error') runner.pending = null;
        else if (e.data.phase === 'import') runner.watchdog = setTimeout(fallback, WORKER_SILENCE_LIMIT);
        runner.onMessage(e.data);
      };
      // Worker の起動自体に失敗したときは画面側に切り替える
      worker.onerror = (e) => {
        e.preventDefault();
        fallback();
      };
      runner.run = (job) => {
        // Worker がうまく動かなければ同じ画像を画面側で処理し直すので、転送せずコピーで渡す
        runner.pending = job;
        runner.watchdog = setTimeout(fallback, WORKER_SILENCE_LIMIT);
        worker.postMessage(job);
      };
    } catch {
      runner.run = inPage(runner);
    }
    aiRunner = runner;
    return runner;
  }
  function inPage(runner) {
    const handle = aiCore((m) => runner.onMessage(m), TRANSFORMERS_URL, MODEL_ID);
    return (job) => setTimeout(() => handle(job), 0);
  }

  const setAiStatus = (text, isError) => {
    aiStatus.textContent = text;
    aiStatus.classList.toggle('error-text', !!isError);
  };

  // Safari では AI の部品をうまく読み込めないため、先に Chrome を案内する
  const isSafari = /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent);
  const SAFARI_MESSAGE = 'Safari ではAIが動きません。Chrome で開いてください。ブラシで手動で消すことはできます。';
  const aiBlocked = isSafari;

  // ---- ボタンを進捗バーにする ----
  // ダウンロードは実際の量で、それ以外は目安の時間で進める（終わるまで 100% にはしない）
  const AI_LABEL = 'AIで背景を自動削除';
  const PHASES = {
    import: { from: 0, to: 0.05, label: '準備中', est: 1.5 },
    download: { from: 0.05, to: 0.8, label: 'ダウンロード中', est: 3 },
    init: { from: 0.8, to: 0.88, label: '起動中', est: 2 },
    infer: { from: 0.88, to: 0.99, label: '背景を削除中', est: 1.5 },
  };
  const aiLabel = aiBtn.querySelector('.ai-label');
  const aiFill = aiBtn.querySelector('.ai-fill');
  let ticker = 0;
  const progress = { phase: null, phaseStart: 0, start: 0, ratio: 0, downloaded: 0, total: 0, est: 1 };

  function setPhase(phase, est) {
    progress.phase = phase;
    progress.phaseStart = performance.now();
    progress.est = est || PHASES[phase].est;
    renderProgress();
  }

  function renderProgress() {
    const ph = PHASES[progress.phase];
    if (!ph) return;
    const t = (performance.now() - progress.phaseStart) / 1000;
    let within;
    if (progress.phase === 'download') within = progress.total ? progress.downloaded / progress.total : 0;
    else within = 1 - Math.exp(-t / progress.est); // 目安の時間で約6割、その後はゆっくり近づく
    progress.ratio = Math.max(progress.ratio, ph.from + (ph.to - ph.from) * within);
    const pct = Math.floor(progress.ratio * 100);
    const sec = Math.floor((performance.now() - progress.start) / 1000);
    let text = `${ph.label} ${pct}%・${sec}秒`;
    if (progress.phase === 'download' && progress.total) {
      text = `${ph.label} ${(progress.downloaded / 1e6).toFixed(0)}/${(progress.total / 1e6).toFixed(0)}MB・${sec}秒`;
    }
    aiLabel.textContent = text;
    aiFill.style.width = `${progress.ratio * 100}%`;
  }

  function startProgress() {
    Object.assign(progress, { phase: null, start: performance.now(), ratio: 0, downloaded: 0, total: 0 });
    aiBtn.classList.add('running');
    setPhase('import');
    ticker = setInterval(renderProgress, 200);
  }

  function stopProgress(done) {
    clearInterval(ticker);
    if (done) aiFill.style.width = '100%';
    // 塗りつぶしを一瞬見せてから元のボタンに戻す
    setTimeout(() => {
      aiBtn.classList.remove('running');
      aiFill.style.width = '0';
      aiLabel.textContent = AI_LABEL;
    }, done ? 600 : 0);
  }

  function runAI() {
    if (!src || aiRunning) return;
    if (aiBlocked) {
      setAiStatus(SAFARI_MESSAGE, true);
      return;
    }
    aiRunning = true;
    aiBtn.disabled = true;
    startProgress();
    setAiStatus('初回のみAIモデルをダウンロードします。画像は外部に送信されません。');

    // マスクと同じ大きさの画像を渡す（大きな写真でもメモリを使いすぎない）
    const input = makeCanvas(mask.width, mask.height);
    const ictx = input.getContext('2d');
    ictx.drawImage(src, 0, 0, input.width, input.height);
    const pixels = ictx.getImageData(0, 0, input.width, input.height).data;

    const finish = () => {
      aiRunning = false;
      aiBtn.disabled = false;
    };

    getRunner((m) => {
      if (m.type === 'phase') {
        if (m.step) setAiStatus(m.step);
        if (m.phase === 'infer') {
          // GPU なしは時間がかかるので目安を長くする
          setPhase('infer', m.device === 'webgpu' ? 1.5 : 10);
        } else if (m.phase !== progress.phase) {
          setPhase(m.phase);
        }
      } else if (m.type === 'download') {
        if (progress.phase !== 'download') setPhase('download');
        progress.downloaded = m.loaded;
        progress.total = m.total;
        renderProgress();
      } else if (m.type === 'done') {
        applyAlpha(m.alpha, m.width, m.height);
        const sec = ((performance.now() - progress.start) / 1000).toFixed(1);
        stopProgress(true);
        setAiStatus(`完了しました（${sec}秒）。消し残しや消えすぎは、下のブラシで直せます。`);
        finish();
      } else if (m.type === 'error') {
        console.error(m.message);
        stopProgress(false);
        setAiStatus(navigator.onLine === false
          ? 'AIモデルを読み込めませんでした。初回はインターネット接続が必要です。'
          : `AIでの処理に失敗しました（${m.message}）。ブラシで手動で消すことはできます。`, true);
        finish();
      }
    }).run({ data: pixels, width: input.width, height: input.height });
  }
  aiBtn.addEventListener('click', runAI);

  // AI の結果を「残す範囲」にする（ほぼ透明・ほぼ不透明はそろえる）
  function applyAlpha(alpha, width, height) {
    const img = new ImageData(width, height);
    for (let i = 0; i < alpha.length; i++) {
      const a = alpha[i];
      img.data[i * 4 + 3] = a <= ALPHA_CLEAN_LOW ? 0 : a >= ALPHA_CLEAN_HIGH ? 255 : a;
    }
    const result = makeCanvas(width, height);
    result.getContext('2d').putImageData(img, 0, 0);

    beginAction();
    const mctx = mask.getContext('2d');
    mctx.globalCompositeOperation = 'source-over';
    mctx.clearRect(0, 0, mask.width, mask.height);
    mctx.drawImage(result, 0, 0, mask.width, mask.height);
    commitAction({ x: 0, y: 0, w: mask.width, h: mask.height });
    setView('edit');
  }

  // ================= 色で消す（AI未使用） =================
  // クリックした所とつながっていて、色が近い範囲を消す（単色に近い背景向け）

  // ---- 「AI」「AI未使用」のタブ ----
  const getMethod = () => document.querySelector('input[name="method"]:checked').value;
  function updateMethodUI() {
    const color = getMethod() === 'color';
    $('ai-fields').classList.toggle('hidden', color);
    $('color-fields').classList.toggle('hidden', !color);
    // 画像のクリックで消すのは「AI未使用」のときだけ
    stage.classList.toggle('pick-color', color);
    toolHint.textContent = color
      ? '「ふちの色で背景を消す」を押すと、画像のふちの色を背景とみなして消します。画像の背景をクリックしても消せます。'
      : '「AIで背景を自動削除」を押すと、写っている主役以外を自動で消します。';
    showGuide();
  }
  document.querySelectorAll('input[name="method"]').forEach((r) => r.addEventListener('change', updateMethodUI));
  updateMethodUI();

  function pointerToMask(e) {
    const r = view.getBoundingClientRect();
    return {
      x: clamp(Math.floor(((e.clientX - r.left) / r.width) * mask.width), 0, mask.width - 1),
      y: clamp(Math.floor(((e.clientY - r.top) / r.height) * mask.height), 0, mask.height - 1),
    };
  }

  // 基準の色に近いかどうか（各色の差が許容範囲以内）
  function nearTest(ref, tolerance) {
    const limit = tolerance * 2.55; // 0〜100 → 各色の差の上限
    const [r0, g0, b0, a0] = ref;
    return (i) => {
      const k = i * 4;
      return Math.abs(colors[k] - r0) <= limit && Math.abs(colors[k + 1] - g0) <= limit &&
        Math.abs(colors[k + 2] - b0) <= limit && Math.abs(colors[k + 3] - a0) <= limit;
    };
  }

  // 塗りつぶし（スキャンライン方式）。始点（複数可）からつながっていて基準の色に近い範囲と、その外接矩形を返す
  function floodRegion(seeds, near) {
    const w = mask.width;
    const h = mask.height;
    const hit = new Uint8Array(w * h);
    const stack = [];
    seeds.forEach(([x, y]) => stack.push(x, y));
    let x1 = w, y1 = h, x2 = -1, y2 = -1;
    while (stack.length) {
      const y = stack.pop();
      let x = stack.pop();
      let i = y * w + x;
      if (hit[i] || !near(i)) continue;
      while (x > 0 && !hit[i - 1] && near(i - 1)) { x--; i--; }
      let up = false;
      let down = false;
      for (; x < w && !hit[i] && near(i); x++, i++) {
        hit[i] = 1;
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y > 0) {
          const n = near(i - w) && !hit[i - w];
          if (n && !up) stack.push(x, y - 1);
          up = n;
        }
        if (y < h - 1) {
          const n = near(i + w) && !hit[i + w];
          if (n && !down) stack.push(x, y + 1);
          down = n;
        }
      }
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
    return x2 < 0 ? null : { hit, box: { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 } };
  }

  const colorAt = (x, y) => {
    const i = (y * mask.width + x) * 4;
    return [colors[i], colors[i + 1], colors[i + 2], colors[i + 3]];
  };

  // 画像のふち（四辺）の画素
  function borderPixels() {
    const w = mask.width;
    const h = mask.height;
    const out = [];
    for (let x = 0; x < w; x++) out.push([x, 0], [x, h - 1]);
    for (let y = 1; y < h - 1; y++) out.push([0, y], [w - 1, y]);
    return out;
  }

  // ふちで一番多い色を背景の色とみなす（似た色をまとめて数え、その平均を使う）
  function dominantBorderColor() {
    const groups = new Map();
    for (const [x, y] of borderPixels()) {
      const c = colorAt(x, y);
      const key = (c[0] >> 4) * 256 + (c[1] >> 4) * 16 + (c[2] >> 4);
      const g = groups.get(key) || { n: 0, sum: [0, 0, 0, 0] };
      g.n++;
      c.forEach((v, k) => { g.sum[k] += v; });
      groups.set(key, g);
    }
    let best = null;
    groups.forEach((g) => { if (!best || g.n > best.n) best = g; });
    return best.sum.map((v) => Math.round(v / best.n));
  }

  // 消し方：point はクリックした所から、edges は画像のふちの背景色の所から。
  // 他の操作をするまでの一連の消し方（セッション）を覚えておき、つまみを動かしたら
  // セッション開始時の状態に戻して、全部を新しい範囲で消し直す（右へ動かしたあと左へ戻すと、ちゃんと戻る）
  let session = null; // { base, count（このセッションが積んだ履歴の数）, picks, lastEntry, collapsed }

  // 1回分の消し方で消える範囲を求めてマスクから消す（履歴には積まない）。消えた範囲の外接矩形を返す
  function applyPick(pick) {
    const near = nearTest(pick.ref, Number(toleranceInput.value));
    const seeds = pick.kind === 'point'
      ? [[pick.p.x, pick.p.y]]
      : borderPixels().filter(([x, y]) => near(y * mask.width + x));
    const region = floodRegion(seeds, near);
    if (!region) return null; // 範囲が狭すぎて一致する色がない
    const { hit, box } = region;
    const ctx = mask.getContext('2d');
    const img = ctx.getImageData(box.x, box.y, box.w, box.h);
    for (let y = 0; y < box.h; y++) {
      for (let x = 0; x < box.w; x++) {
        if (hit[(box.y + y) * mask.width + box.x + x]) img.data[(y * box.w + x) * 4 + 3] = 0;
      }
    }
    ctx.putImageData(img, box.x, box.y);
    return box;
  }

  // 直前の操作がこのセッションの消し方なら続きとして扱う（元に戻す・AI などをしたら別のセッション）
  const sessionActive = () => !!session && undoStack[undoStack.length - 1] === session.lastEntry;

  function startPick(pick) {
    if (!sessionActive()) {
      const base = makeCanvas(mask.width, mask.height);
      base.getContext('2d').drawImage(mask, 0, 0);
      session = { base, count: 0, picks: [], lastEntry: null, collapsed: false };
    }
    beginAction();
    const box = applyPick(pick);
    session.picks.push(pick);
    if (box) {
      commitAction(box);
      session.count++;
      session.lastEntry = undoStack[undoStack.length - 1];
      session.collapsed = false;
    } else {
      action = null;
    }
    redraw();
    renderSwatches(pick.ref.slice(0, 3), pick.kind === 'edges' ? 'ふちの色' : 'クリックした色');
    showGuide('adjust');
  }

  stage.addEventListener('click', (e) => {
    if (!src || showOriginal || aiRunning || getMethod() !== 'color') return;
    const p = pointerToMask(e);
    startPick({ kind: 'point', p, ref: colorAt(p.x, p.y) });
  });

  $('btn-edges').addEventListener('click', () => {
    if (!src || aiRunning) return;
    if (showOriginal) setView('edit');
    startPick({ kind: 'edges', ref: dominantBorderColor() });
  });

  let retryFrame = 0;
  toleranceInput.addEventListener('input', () => {
    renderSwatches();
    if (!sessionActive()) return;
    cancelAnimationFrame(retryFrame);
    retryFrame = requestAnimationFrame(() => {
      if (!sessionActive()) return;
      // つまみで調整したら、セッションの履歴を「セッション開始前に戻す」1項目にまとめる
      if (!session.collapsed) {
        undoStack.splice(Math.max(0, undoStack.length - session.count));
        session.count = 1;
        const entry = { region: { x: 0, y: 0, w: mask.width, h: mask.height }, image: session.base };
        undoStack.push(entry);
        redoStack = [];
        session.lastEntry = entry;
        session.collapsed = true;
        updateUI();
      }
      const ctx = mask.getContext('2d');
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, mask.width, mask.height);
      ctx.drawImage(session.base, 0, 0);
      session.picks.forEach(applyPick);
      redraw();
    });
  });

  // ---- 画像の上の手順案内 ----
  // 「AI未使用」で、まだ何も消していなければ ①、消したあとは ② を少しのあいだ出す
  function showGuide(step) {
    if (step) guideStep = step;
    clearTimeout(guideTimer);
    const guide = $('guide');
    const visible = !!src && getMethod() === 'color' && !showOriginal && guideStep !== 'done';
    guide.classList.toggle('hidden', !visible);
    if (!visible) return;
    // 画面が狭いと設定は画像の下に並ぶ
    const where = getComputedStyle($('side')).position === 'fixed' ? '右' : '下';
    guide.querySelector('span').textContent = guideStep === 'start'
      ? `① ${where}の「ふちの色で背景を消す」を押すか、消したい背景をクリック`
      : `② ${where}の帯のつまみで、消える範囲を調整できます`;
    if (guideStep === 'adjust') guideTimer = setTimeout(() => showGuide('done'), 5000);
  }

  // ---- 色の帯のスライダー ----
  // 左端がクリックした色、右へ行くほど違う色。明るい色は暗い方へ、暗い色は明るい方へずらして並べる。
  // つまみより左（＝消える範囲）は色のまま、右（＝残る範囲）は薄く覆う
  let pickedColor = null;
  let pickedLabel = '';
  function renderSwatches(rgb, label) {
    if (rgb) pickedColor = rgb;
    if (label) pickedLabel = label;
    const seed = pickedColor || [255, 255, 255];
    const bright = (seed[0] * 299 + seed[1] * 587 + seed[2] * 114) / 1000 > 128;
    const sign = bright ? -1 : 1;
    const min = Number(toleranceInput.min);
    const max = Number(toleranceInput.max);
    const stops = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const shift = sign * (min + (max - min) * t) * 2.55;
      const c = seed.map((v) => clamp(Math.round(v + shift), 0, 255));
      stops.push(`rgb(${c.join(',')}) ${t * 100}%`);
    }
    $('tol-strip').style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    const p = (Number(toleranceInput.value) - min) / (max - min);
    $('tol-keep').style.setProperty('--p', p);
    $('tol-erase').style.setProperty('--p', p);
    // 「消える」の文字が収まらないほど狭いときは出さない
    $('tol-erase').firstElementChild.style.visibility = p < 0.22 ? 'hidden' : '';
    $('tol-seed-label').textContent = pickedColor ? pickedLabel : '例：白をクリックした場合';
  }
  renderSwatches();

  // ================= 履歴 =================
  // マスクは変更された範囲だけを保存してメモリを抑える
  const crop = (canvas, r) => {
    const c = makeCanvas(r.w, r.h);
    c.getContext('2d').drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return c;
  };

  function beginAction() {
    const ctx = before.getContext('2d');
    ctx.clearRect(0, 0, before.width, before.height);
    ctx.drawImage(mask, 0, 0);
    action = true;
  }

  function commitAction(region) {
    if (!action || !region) {
      action = null;
      return;
    }
    action = null;
    undoStack.push({ region, image: crop(before, region) });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateUI();
  }

  function swap(from, to) {
    const entry = from.pop();
    if (!entry) return;
    const r = entry.region;
    to.push({ region: r, image: crop(mask, r) });
    const ctx = mask.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(entry.image, r.x, r.y);
    redraw();
    updateUI();
  }
  const undo = () => swap(undoStack, redoStack);
  const redo = () => swap(redoStack, undoStack);

  function updateUI() {
    $('btn-undo').disabled = !undoStack.length;
    $('btn-redo').disabled = !redoStack.length;
  }

  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-reset').addEventListener('click', () => {
    beginAction();
    fillMask();
    commitAction({ x: 0, y: 0, w: mask.width, h: mask.height });
    redraw();
  });
  window.addEventListener('keydown', (e) => {
    if (!src || !(e.metaKey || e.ctrlKey) || e.target.matches('input[type="text"], input[type="number"]')) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
  });

  // ================= 出力 =================
  // 背景が透明なら PNG。背景色を付けたときは元の画像の形式に合わせる
  const JPEG_QUALITY = 0.92;
  function outputFormat() {
    if (!backgroundFill()) return { type: 'image/png', ext: 'png' };
    if (sourceType === 'image/jpeg' || /^image\/(hei[cf]|avif)$/.test(sourceType)) return { type: 'image/jpeg', ext: 'jpg' };
    return { type: 'image/png', ext: 'png' };
  }

  // 保存される画像（ダウンロードとほかの道具への受け渡しで共通）
  function makeBlob() {
    const { type, ext } = outputFormat();
    const canvas = makeCanvas(view.width, view.height);
    compose(canvas.getContext('2d'), true);
    return new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY))
      .then((blob) => ({ blob, name: `${fileName}_nobg.${ext}` }));
  }

  $('btn-download').addEventListener('click', async () => {
    if (!src) return;
    const { blob, name } = await makeBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  const confirmDiscard = () => !undoStack.length || confirm('いまの編集内容は破棄されます。別の写真に入れ替えますか？');

  $('btn-new').addEventListener('click', () => {
    if (confirmDiscard()) fileInput.click();
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
    const file = e.dataTransfer.files[0];
    if (file && confirmDiscard()) loadFile(file);
  });

  // ================= 作業の保存・復元と、ほかの道具との受け渡し（store.js） =================
  const PAGE = 'bg-remove/index.html';
  const store = window.ToolStore;
  // 自動保存（「色で消す」の一連の操作を表す session とは別もの）
  const saving = store
    ? store.autosave(PAGE, async () => {
      if (!currentFile || !mask) return undefined;
      const maskBlob = await new Promise((resolve) => mask.toBlob(resolve, 'image/png'));
      return {
        files: [{ blob: currentFile, name: currentFile.name, key: 'image' }, { blob: maskBlob, name: 'mask.png', key: 'mask' }],
        data: { method: getMethod(), tolerance: toleranceInput.value, bgMode: bgMode.value, bgColor: bgColor.value },
      };
    })
    : { schedule() {} };

  // 保存しておいた残す範囲と設定を戻す
  async function restoreWork({ files, data }) {
    const m = files.find((f) => f.key === 'mask');
    if (m) {
      const bmp = await createImageBitmap(m);
      const ctx = mask.getContext('2d');
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, mask.width, mask.height);
      ctx.drawImage(bmp, 0, 0, mask.width, mask.height);
    }
    const method = document.querySelector(`input[name="method"][value="${data.method}"]`);
    if (method) {
      method.checked = true;
      updateMethodUI();
    }
    toleranceInput.value = data.tolerance;
    renderSwatches();
    bgColor.value = data.bgColor;
    bgMode.value = data.bgMode;
    bgMode.dispatchEvent(new Event('input')); // ボタンの表示を合わせる
    $('bg-color-row').classList.toggle('hidden', bgMode.value !== 'color');
    redraw();
  }

  // サイドバーの設定を変えたら保存する（画像の上の操作は redraw で保存する）
  ['input', 'change'].forEach((ev) => $('side').addEventListener(ev, () => saving.schedule()));

  if (store) {
    store.mountSendTo($('send-slot'), PAGE, async () => (src ? [await makeBlob()] : null));
    (async () => {
      // ほかの道具から送られた画像があればそれを開き、なければ前回の作業を復元する
      const handed = await store.takeHandoff(PAGE);
      if (handed && handed.length) return loadFile(handed[0]);
      const saved = await store.load(PAGE);
      const image = saved && saved.files.find((f) => f.key === 'image');
      if (image) loadFile(image, saved);
    })();
  }
})();
