'use strict';

// Qo‘shimcha interaktivlik uchun ajratilgan modul fayli.
// Formadagi validatsiyaning asosiy qismi serverda bajariladi.
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-xona-bron-date]')) {
    const form = event.target.form;
    if (form) form.requestSubmit();
  }
});
