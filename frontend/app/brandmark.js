/* brandmark.js — paints the fork's product name from brand.js (Art Studio Phase 0: fork hygiene).

   index.html carries the placeholder name as literal text so the first paint is right before any script runs.
   This fills the same spots from Brand.PRODUCT_NAME, so renaming the app (plan Phase 7) is one constant in
   brand.js: the window title and every element marked [data-brand-name]. It reads no state and asserts nothing
   about the station — a name, never a status. */
'use strict';
(function () {
  if (typeof document === 'undefined' || typeof Brand === 'undefined' || !Brand.PRODUCT_NAME) return;
  const name = Brand.PRODUCT_NAME;
  function paint() {
    try { if (document.title !== name) document.title = name; } catch (_) {}
    let marks = [];
    try { marks = document.querySelectorAll('[data-brand-name]'); } catch (_) { marks = []; }
    for (const el of marks) { if (el.textContent !== name) el.textContent = name; }
  }
  paint();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint, { once: true });
})();
