// Toshkent vaqti bo'yicha sana/vaqt yordamchilari (BR-14)
const TZ = 'Asia/Tashkent';

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

/** Bugungi sana 'YYYY-MM-DD' (Toshkent) */
const today = (d = new Date()) => dateFmt.format(d);
/** Hozirgi vaqt 'HH:MM' (Toshkent) */
const nowTime = (d = new Date()) => timeFmt.format(d).replace(/^24/, '00');

/** 'YYYY-MM-DD' + n kun */
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** ISO hafta kuni: 1=Du ... 7=Ya */
function isoDow(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const fromMin = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Sana + vaqt (Toshkent) -> epoch ms. Toshkent doimiy UTC+5, yozgi vaqt yo'q. */
function tashkentMs(ymd, hhmm = '00:00') {
  return Date.parse(`${ymd}T${hhmm}:00+05:00`);
}

const KUNLAR = ['', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba', 'Yakshanba'];
const KUN_QISQA = ['', 'Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];

/** '2026-10-19' -> '19.10.2026' */
const fmtDate = (ymd) => (ymd ? ymd.split('-').reverse().join('.') : '');

/** Sig'im: slot rejimida min(max, davomiylik/slot), jonli rejimda max */
function sigim({ start_time, end_time, slot_min, max_navbat }) {
  if (!slot_min) return max_navbat;
  return Math.min(max_navbat, Math.floor((toMin(end_time) - toMin(start_time)) / slot_min));
}

module.exports = { TZ, today, nowTime, addDays, isoDow, isYmd, toMin, fromMin, tashkentMs, KUNLAR, KUN_QISQA, fmtDate, sigim };
