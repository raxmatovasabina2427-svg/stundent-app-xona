// Kichik interaktivlik (CSP: inline skript yo'q)
(function () {
  // Mobil menyu
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.menu-btn');
    if (btn) document.querySelector('.top').classList.toggle('open');
  });

  // data-confirm — tasdiqlash oynasi
  document.addEventListener('submit', function (e) {
    var f = e.target;
    var msg = f.getAttribute('data-confirm');
    if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
    // Ikki marta yuborishdan himoya (FR-NAV-06)
    if (f.hasAttribute('data-once')) {
      if (f.dataset.sent) { e.preventDefault(); return; }
      f.dataset.sent = '1';
      f.querySelectorAll('button[type=submit]').forEach(function (b) { b.disabled = true; });
    }
  });

  // Rolga qarab maydonlarni ko'rsatish (foydalanuvchi formasi)
  function syncRole() {
    var sel = document.querySelector('select[name=role]');
    if (!sel) return;
    document.querySelectorAll('[data-for]').forEach(function (el) {
      var on = el.getAttribute('data-for').split(' ').indexOf(sel.value) !== -1;
      el.hidden = !on;
      el.querySelectorAll('input, select, textarea').forEach(function (i) { i.disabled = !on; });
    });
  }
  document.addEventListener('change', function (e) {
    if (e.target.matches('select[name=role]')) syncRole();
    if (e.target.closest('[data-capacity]')) capacity();
  });
  document.addEventListener('input', function (e) {
    if (e.target.closest('[data-capacity]')) capacity();
  });

  // Qabul vaqti formasi: rejim va sig'im hisoblagichi (FR-QV-03)
  function toMin(v) { var p = String(v || '').split(':'); return p.length === 2 ? (+p[0]) * 60 + (+p[1]) : NaN; }
  function capacity() {
    var f = document.querySelector('[data-capacity]');
    if (!f) return;
    var jonli = f.querySelector('input[name=rejim][value=jonli]').checked;
    var slotField = f.querySelector('[data-slot-field]');
    slotField.hidden = jonli;
    slotField.querySelector('input').disabled = jonli;
    var s = toMin(f.querySelector('[name=start_time]').value);
    var t = toMin(f.querySelector('[name=end_time]').value);
    var slot = +f.querySelector('[name=slot_min]').value;
    var max = +f.querySelector('[name=max_navbat]').value;
    var out = f.querySelector('[data-capacity-out]');
    if (isNaN(s) || isNaN(t) || t <= s || !max) { out.textContent = '—'; return; }
    if (jonli) { out.textContent = max + ' ta navbat (vaqtsiz, tartib raqami bilan)'; return; }
    if (!slot) { out.textContent = '—'; return; }
    var fit = Math.floor((t - s) / slot);
    out.textContent = Math.min(max, fit) + ' ta navbat (oraliqqa sig\'adi: ' + fit + ')';
  }

  // htmx: server yuborgan toast xabari
  document.body.addEventListener('toast', function (e) { showToast(e.detail.value); });
  document.body.addEventListener('htmx:responseError', function (e) {
    var t = e.detail.xhr && e.detail.xhr.getResponseHeader('HX-Trigger');
    if (!t) showToast('Xatolik yuz berdi');
  });
  function showToast(text) {
    var el = document.getElementById('toast');
    if (!el || !text) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 3500);
  }
  syncRole();
  capacity();
})();
