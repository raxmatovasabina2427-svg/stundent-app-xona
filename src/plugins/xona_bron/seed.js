// Demo xonalar (faqat lokal/staging). Ishga tushirish: npm run seed:xona
// Avval `npm run seed` (demo bo'limlar) bajarilgan bo'lishi kerak.
const env = require('../../config/env');
const { pool } = require('../../db/pool');

async function seed({ log = console.log } = {}) {
  if (env.isProd) throw new Error('Production bazaga demo ma\'lumot yozilmaydi');
  const { rows } = await pool.query('SELECT id, nomi FROM bolimlar');
  const id = (nomi) => rows.find((r) => r.nomi === nomi)?.id ?? null;
  const atDekanat = id('AT dekanati');
  const atKafedra = id('Dasturiy injiniring kafedrasi');
  const iqDekanat = id('Iqtisodiyot dekanati');

  const xonalar = [
    ['Kompyuter xonasi 1', 'kompyuter', 'A bino', 2, '201', 25, '25 ta kompyuter, proyektor', '08:00', '20:00', atDekanat],
    ['Kompyuter xonasi 2', 'kompyuter', 'A bino', 2, '202', 20, '20 ta kompyuter, interaktiv doska', '08:00', '20:00', atDekanat],
    ['Dasturlash laboratoriyasi', 'laboratoriya', 'B bino', 3, '305', 15, 'Serverlar, tarmoq jihozlari', '09:00', '18:00', atKafedra],
    ['Ma\'ruza zali 1', 'maruza', 'A bino', 1, '101', 120, 'Proyektor, mikrofon', '08:00', '19:00', atDekanat],
    ['Iqtisodiyot ma\'ruza xonasi', 'maruza', 'C bino', 1, '110', 60, 'Proyektor', '08:00', '18:00', iqDekanat],
  ];
  let n = 0;
  for (const x of xonalar) {
    const r = await pool.query(
      `INSERT INTO xona_bron_resurslar (nomi,turi,bino,qavat,xona_raqami,sigim,jihozlar,ish_boshlanish,ish_tugash,masul_bolim_id)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE NOT EXISTS (SELECT 1 FROM xona_bron_resurslar WHERE nomi = $1)`, x);
    n += r.rowCount;
  }
  log(n ? `✓ ${n} ta demo xona qo'shildi.` : 'Demo xonalar allaqachon bor — o\'tkazib yuborildi.');
}

module.exports = { seed };

if (require.main === module) {
  seed().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
}
