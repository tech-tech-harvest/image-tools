// <select class="seg"> を押しやすいボタン群に置き換える。
// 値は非表示の select が保持するので、各ページのロジックは select をそのまま扱える。
(() => {
  'use strict';

  function build(select) {
    const group = document.createElement('div');
    group.className = 'seg-group';
    group.setAttribute('role', 'radiogroup');

    [...select.options].forEach((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        if (select.value === opt.value) return;
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      group.appendChild(b);
    });

    // 選択状態・無効化・ラベル変更を反映（data-short があれば短い表記を使う）
    const sync = () =>
      group.querySelectorAll('button').forEach((b, i) => {
        const opt = select.options[i];
        b.textContent = opt.dataset.short || opt.textContent;
        b.title = opt.textContent;
        b.disabled = opt.disabled;
        b.classList.toggle('active', opt.selected);
        b.setAttribute('aria-checked', String(opt.selected));
      });

    select.addEventListener('change', sync);
    // スクリプトから value を変えたときは input を発火させて表示だけ合わせる
    select.addEventListener('input', sync);
    new MutationObserver(sync).observe(select, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    select.hidden = true;
    select.after(group);
    sync();
  }

  document.querySelectorAll('select.seg').forEach(build);

  // 「i」ボタンの説明：タップで開閉、外側をタップで閉じる（マウスでは乗せるだけで表示）
  document.querySelectorAll('.info-wrap').forEach((wrap) => {
    const btn = wrap.querySelector('.info-btn');
    const setOpen = (on) => {
      wrap.classList.toggle('open', on);
      btn.setAttribute('aria-expanded', String(on));
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!wrap.classList.contains('open'));
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  });
})();
