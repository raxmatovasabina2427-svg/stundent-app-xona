// Handlebars yordamchilari
const { KUNLAR, KUN_QISQA, fmtDate, sigim } = require('./time');

const ROLLAR = {
  admin: 'Administrator', dekanat: 'Dekanat', teacher: "O'qituvchi",
  tyutor: 'Tyutor', xodim: "Bo'lim xodimi", student: 'Talaba',
};
const TURLAR = { fakultet: 'Fakultet', dekanat: 'Dekanat', kafedra: 'Kafedra', bolim: "Bo'lim", markaz: 'Markaz' };
const HOLATLAR = {
  kutilmoqda: 'Kutilmoqda', tasdiqlandi: 'Tasdiqlandi', qabul_qilindi: 'Qabul qilindi',
  kelmadi: 'Kelmadi', rad_etildi: 'Rad etildi', bekor_qilindi: 'Bekor qilindi',
};

module.exports = {
  eq: (a, b) => a == b,
  ne: (a, b) => a != b,
  or: (...a) => a.slice(0, -1).some(Boolean),
  and: (...a) => a.slice(0, -1).every(Boolean),
  not: (a) => !a,
  gt: (a, b) => Number(a) > Number(b),
  includes: (arr, v) => Array.isArray(arr) && arr.map(String).includes(String(v)),
  kun: (n) => KUNLAR[n] || '',
  kunQisqa: (n) => KUN_QISQA[n] || '',
  rol: (r) => ROLLAR[r] || r,
  turi: (t) => TURLAR[t] || t,
  holat: (s) => HOLATLAR[s] || s,
  sana: (d) => fmtDate(d),
  sigim: (q) => sigim(q),
  fio: (u) => (u ? [u.familiya, u.ism, u.ochestva].filter(Boolean).join(' ') : ''),
  qisqaFio: (u) => (u ? `${u.familiya} ${(u.ism || '')[0] || ''}.` : ''),
  vaqt: (bosh, tug) => (bosh ? `${bosh}–${tug}` : 'Jonli navbat'),
  sel: (a, b) => (String(a) === String(b) ? 'selected' : ''),
  chk: (v) => (v ? 'checked' : ''),
  json: (o) => JSON.stringify(o),
  add: (a, b) => Number(a) + Number(b),
  range: (a, b) => Array.from({ length: Number(b) - Number(a) + 1 }, (_, i) => Number(a) + i),
  qs: (base, opts) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.hash)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  },
};

Object.defineProperty(module.exports, 'LABELS', { value: { ROLLAR, TURLAR, HOLATLAR }, enumerable: false });
