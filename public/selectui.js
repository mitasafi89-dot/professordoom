'use strict';
/* Branded dropdown: replaces the OS-rendered <select> popup (whose highlight
   uses the system accent colour, not our teal) with a themed menu. Progressive
   enhancement -- the native <select> stays in the DOM as the source of truth,
   so existing change handlers and .value reads keep working untouched. A
   MutationObserver rebuilds the menu whenever the options change. */
(function () {
  const CHEV = '<svg class="bk-select-chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  function enhance(sel) {
    if (!sel || sel.dataset.bkEnhanced || sel.multiple) return;
    sel.dataset.bkEnhanced = '1';

    const wrap = document.createElement('div');
    wrap.className = 'bk-select';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('bk-native');
    sel.setAttribute('tabindex', '-1');
    sel.setAttribute('aria-hidden', 'true');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bk-select-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'bk-select-label';
    btn.appendChild(label);
    btn.insertAdjacentHTML('beforeend', CHEV);

    const menu = document.createElement('div');
    menu.className = 'bk-menu';
    menu.setAttribute('role', 'listbox');

    wrap.appendChild(btn);
    wrap.appendChild(menu);

    const close = () => { menu.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
    const open = () => { build(); menu.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); };

    function refresh() {
      const o = sel.options[sel.selectedIndex];
      label.textContent = o ? o.textContent : '';
    }

    function build() {
      menu.innerHTML = '';
      Array.from(sel.options).forEach((o, idx) => {
        const it = document.createElement('button');
        it.type = 'button';
        it.className = 'bk-opt' + (idx === sel.selectedIndex ? ' selected' : '');
        it.setAttribute('role', 'option');
        it.textContent = o.textContent;
        it.addEventListener('click', () => {
          if (sel.selectedIndex !== idx) {
            sel.selectedIndex = idx;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
          refresh();
          close();
        });
        menu.appendChild(it);
      });
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.contains('open') ? close() : open();
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    sel.addEventListener('change', refresh);
    // Options are often populated/replaced async (loadSkills, detectAgents);
    // rebuild + relabel when that happens (runs after any same-tick .value set).
    new MutationObserver(() => { refresh(); if (menu.classList.contains('open')) build(); })
      .observe(sel, { childList: true });

    refresh();
  }

  function enhanceAll(root) { (root || document).querySelectorAll('select').forEach(enhance); }

  window.BrandSelect = { enhance, enhanceAll };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => enhanceAll());
  else enhanceAll();
})();
