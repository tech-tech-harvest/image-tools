// サイト共通のヘッダのナビ。ページを追加するときは PAGES に1行足す。
// 各ページの <header> の直後で読み込む（どの階層のページからでも正しいリンクになる）
(() => {
  'use strict';

  const PAGES = [
    ['index.html', '形式変換'],
    ['resize/index.html', 'トリミング＆リサイズ'],
    ['mosaic/index.html', 'モザイク'],
    ['bg-remove/index.html', '背景削除'],
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
})();
