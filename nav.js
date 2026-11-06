// サイト共通のヘッダのナビ。ページを追加するときは PAGES に1行足す。
// 各ページの <header> の直後で読み込む（どの階層のページからでも正しいリンクになる）
(() => {
  'use strict';

  const PAGES = [
    ['index.html', '形式変換'],
    ['edit/index.html', '画像編集'],
    ['resize/index.html', 'トリミング＆リサイズ'],
    ['mosaic/index.html', 'モザイク'],
    ['bg-remove/index.html', '背景削除'],
    ['watermark/index.html', '透かし'],
    ['metadata/index.html', '位置情報の削除'],
  ];

  // このスクリプトの場所＝サイトの一番上のフォルダ
  const root = new URL('.', document.currentScript.src);
  const normalize = (url) => url.pathname.replace(/\/$/, '/index.html');
  const here = normalize(new URL(location.href));

  const nav = document.querySelector('.site-nav');
  PAGES.forEach(([path, label]) => {
    const url = new URL(path, root);
    const a = document.createElement('a');
    a.href = url.href;
    a.textContent = label;
    if (normalize(url) === here) {
      a.className = 'active';
      a.setAttribute('aria-current', 'page');
    }
    nav.appendChild(a);
  });

  const brand = document.querySelector('.brand');
  if (brand) brand.href = new URL('index.html', root).href;

  // 画像の受け渡し（store.js）から使えるようにする
  window.SiteNav = { pages: PAGES, url: (path) => new URL(path, root).href };

  // ナビで別の道具に移る前に、まだ保存していない作業を保存する
  [...nav.querySelectorAll('a'), brand].filter(Boolean).forEach((a) => a.addEventListener('click', async (e) => {
    if (!window.ToolStore || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    await window.ToolStore.flushAll();
    location.href = a.href;
  }));

  // ---- 1行に収まらないときはハンバーガーメニューにする ----
  const header = document.querySelector('.site-header');
  const inner = header.querySelector('.site-inner');
  nav.id = 'site-nav';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nav-toggle';
  toggle.setAttribute('aria-label', 'メニュー');
  toggle.setAttribute('aria-controls', 'site-nav');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<span></span><span></span><span></span>';
  inner.appendChild(toggle);

  const setOpen = (open) => {
    header.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!header.classList.contains('open'));
  });
  document.addEventListener('click', (e) => { if (!header.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  // 幅に応じて 3 段階で切り替える（文字の幅は環境で変わるので実際に測る）
  //   中央に置ける → そのまま ／ ロゴの右なら1行に収まる → .inline ／ 収まらない → .compact（ハンバーガー）
  let neededCenter = 0;
  let neededInline = 0;
  function measure() {
    header.classList.remove('compact', 'inline');
    const pad = parseFloat(getComputedStyle(inner).paddingLeft) * 2;
    const gap = parseFloat(getComputedStyle(inner).columnGap) || 16;
    const brandW = brand ? brand.offsetWidth : 0;
    neededCenter = nav.scrollWidth + 2 * (brandW + gap) + pad;
    header.classList.add('inline'); // 並べたときは項目の間隔が狭くなるので、その状態で測る
    neededInline = nav.scrollWidth + brandW + gap + pad;
    header.classList.remove('inline');
  }
  function fit() {
    const w = inner.clientWidth;
    const compact = w < neededInline;
    header.classList.toggle('compact', compact);
    header.classList.toggle('inline', !compact && w < neededCenter);
    if (!compact) setOpen(false);
  }
  measure();
  fit();
  // 日本語フォントの読み込みで文字の幅が変わることがあるので、読み込み後に測り直す
  if (document.fonts) document.fonts.ready.then(() => { measure(); fit(); });
  new ResizeObserver(fit).observe(header);
})();
