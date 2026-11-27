// Demo ma'lumotlar (faqat lokal/staging uchun!). Barcha demo parollar: parol123
// Ishga tushirish: npm run seed
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const { pool, tx } = require('./pool');

async function seed() {
  if (env.isProd) throw new Error('Production bazaga demo ma\'lumot yozilmaydi');
  const { rows: [has] } = await pool.query("SELECT 1 FROM users WHERE login = 'dekan_at'");
  if (has) { console.log('Demo ma\'lumotlar allaqachon bor — o\'tkazib yuborildi.'); return; }
  const hash = await bcrypt.hash('parol123', 10);

  await tx(async (c) => {
    const ins = async (sql, p) => (await c.query(sql, p)).rows[0];
    const bolim = (nomi, turi, parent = null, xona = null) =>
      ins('INSERT INTO bolimlar (nomi, turi, parent_id, xona) VALUES ($1,$2,$3,$4) RETURNING id', [nomi, turi, parent, xona]).then((r) => r.id);
    const user = (login, familiya, ism, ochestva, role, phone) =>
      ins('INSERT INTO users (login, familiya, ism, ochestva, role, phone, parol) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [login, familiya, ism, ochestva, role, phone, hash]).then((r) => r.id);
    const xb = (u, b, lavozim, asosiy = false) =>
      c.query('INSERT INTO xodim_bolim (user_id, bolim_id, lavozim, asosiy) VALUES ($1,$2,$3,$4)', [u, b, lavozim, asosiy]);
    const qv = (x, b, kun, s, e, slot, max) =>
      c.query('INSERT INTO qabul_vaqti (xodim_id, bolim_id, hafta_kuni, start_time, end_time, slot_min, max_navbat) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [x, b, kun, s, e, slot, max]);
    const mt = (b, nomi, hujjat = null) =>
      c.query('INSERT INTO murojaat_turlari (bolim_id, nomi, kerakli_hujjatlar) VALUES ($1,$2,$3)', [b, nomi, hujjat]);

    // Tashkiliy tuzilma
    const at = await bolim('Axborot texnologiyalari fakulteti', 'fakultet');
    const atDek = await bolim('AT dekanati', 'dekanat', at, '204');
    const atKaf = await bolim('Dasturiy injiniring kafedrasi', 'kafedra', at, '312');
    const iq = await bolim('Iqtisodiyot fakulteti', 'fakultet');
    const iqDek = await bolim('Iqtisodiyot dekanati', 'dekanat', iq, '110');
    const reg = await bolim('Registrator ofisi', 'markaz', null, '101');

    for (const [g, k, f] of [['AT-21-01', 3, at], ['AT-22-02', 2, at], ['IQ-21-01', 3, iq]]) {
      await c.query('INSERT INTO guruhlar (nomi, kurs, fakultet_id) VALUES ($1,$2,$3)', [g, k, f]);
    }

    // Xodimlar
    const dekan = await user('dekan_at', 'Rahimov', 'Anvar', 'Karimovich', 'dekanat', '+998901110001');
    await c.query('INSERT INTO dekanat_user_info (user_id, lavozim) VALUES ($1, $2)', [dekan, 'Dekan']);
    await xb(dekan, atDek, 'Dekan', true);
    const zam = await user('zamdekan_at', 'Yusupova', 'Malika', 'Akmalovna', 'dekanat', '+998901110002');
    await c.query('INSERT INTO dekanat_user_info (user_id, lavozim) VALUES ($1, $2)', [zam, "Dekan o'rinbosari"]);
    await xb(zam, atDek, "O'quv ishlari bo'yicha dekan o'rinbosari", true);
    const teacher = await user('karimova', 'Karimova', 'Dilnoza', 'Botirovna', 'teacher', '+998901110003');
    await c.query('INSERT INTO teacher_info (user_id) VALUES ($1)', [teacher]);
    await xb(teacher, atKaf, 'Dotsent', true);
    await xb(teacher, atDek, 'Fakultet maslahatchisi');
    const tyutor = await user('tyutor_at', 'Olimov', 'Sardor', null, 'tyutor', '+998901110004');
    await xb(tyutor, atKaf, 'Katta o\'qituvchi, tyutor', true);
    await c.query("INSERT INTO tyutor_guruh (tyutor_id, guruh) VALUES ($1, 'AT-21-01')", [tyutor]);
    const regx = await user('registrator', 'Tursunova', 'Nigora', null, 'xodim', '+998901110005');
    await xb(regx, reg, 'Registrator', true);
    const iqDekan = await user('dekan_iq', 'Saidov', 'Bobur', null, 'dekanat', '+998901110006');
    await c.query('INSERT INTO dekanat_user_info (user_id, lavozim) VALUES ($1, $2)', [iqDekan, 'Dekan']);
    await xb(iqDekan, iqDek, 'Dekan', true);

    // Talabalar
    const talabalar = [
      ['talaba1', 'Abdullayev', 'Jasur', 'AT-21-01', 3], ['talaba2', 'Ergasheva', 'Madina', 'AT-21-01', 3],
      ['talaba3', 'Xolmatov', 'Sherzod', 'AT-22-02', 2], ['talaba4', 'Qodirova', 'Zarina', 'AT-22-02', 2],
      ['talaba5', 'Nazarov', 'Aziz', 'IQ-21-01', 3],
    ];
    for (const [login, f, i, g, k] of talabalar) {
      const id = await user(login, f, i, null, 'student', null);
      await c.query('INSERT INTO student_info (user_id, guruh, kurs) VALUES ($1,$2,$3)', [id, g, k]);
    }

    // Qabul jadvali
    for (const kun of [1, 3]) await qv(dekan, atDek, kun, '09:00', '11:00', 15, 8);
    for (const kun of [2, 4]) await qv(zam, atDek, kun, '14:00', '16:00', 20, 6);
    await qv(teacher, atDek, 5, '10:00', '12:00', null, 20);          // jonli navbat
    await qv(teacher, atKaf, 1, '14:00', '16:00', 30, 4);
    await qv(tyutor, atKaf, 3, '13:00', '15:00', 20, 6);
    for (const kun of [1, 2, 3, 4, 5]) await qv(regx, reg, kun, '09:00', '12:00', 10, 18);
    await qv(iqDekan, iqDek, 2, '10:00', '12:00', 15, 8);

    // Murojaat turlari
    await mt(atDek, "Ma'lumotnoma olish", 'Talabalik guvohnomasi');
    await mt(atDek, 'Qayta topshirish (qarzdorlik)', 'Qaydnoma nusxasi');
    await mt(atDek, "Akademik ta'til", 'Ariza, tibbiy ma\'lumotnoma (bo\'lsa)');
    await mt(atDek, 'Boshqa masala');
    await mt(atKaf, 'Kurs ishi bo\'yicha maslahat');
    await mt(atKaf, 'Fan bo\'yicha savol');
    await mt(reg, 'Transkript olish', 'Pasport nusxasi');
    await mt(reg, 'Diplom ilovasi');
    await mt(iqDek, "Ma'lumotnoma olish");

    // Kelgusi bayram (namuna)
    await c.query("INSERT INTO bayramlar (sana, nomi) VALUES ('2026-12-08', 'Konstitutsiya kuni') ON CONFLICT DO NOTHING");
  });
  console.log('✓ Demo ma\'lumotlar yozildi. Loginlar: dekan_at, zamdekan_at, karimova, tyutor_at, registrator, dekan_iq, talaba1…talaba5 (parol: parol123)');
}

module.exports = { seed };

if (require.main === module) {
  const { migrate } = require('./migrate');
  migrate(pool)
    .then(seed)
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
