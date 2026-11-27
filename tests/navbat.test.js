// Faza 3–4: qabul jadvali, slotlar, band qilish, holatlar (TC-09…TC-30, ilova E)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { request, pool, createApp, resetDb, login, userId } = require('./helpers');
const { today, addDays, isoDow, nowTime, toMin, fromMin } = require('../src/lib/time');
const qabul = require('../src/modules/qabul/service');
const { daySlots } = require('../src/modules/navbat/slots');
const { bandQilish } = require('../src/modules/navbat/booking');
const st = require('../src/modules/navbat/status');

let app; let admin; let X; let B; let MT; let HASH;
const fakeReq = {};

/** Bugundan keyingi (ertadan boshlab) berilgan hafta kunidagi sana */
const nextDow = (dow, minOffset = 1) => {
  let d = addDays(today(), minOffset);
  while (isoDow(d) !== dow) d = addDays(d, 1);
  return d;
};

async function newStudent(login) {
  const { rows: [u] } = await pool.query(
    "INSERT INTO users (login, familiya, ism, role, parol) VALUES ($1, 'Test', $1, 'student', $2) RETURNING id", [login, HASH]);
  await pool.query("INSERT INTO student_info (user_id, guruh, kurs) VALUES ($1, 'AT-22-02', 2)", [u.id]);
  return u.id;
}

/** Yangi xodim + bo'limga biriktirish */
async function newXodim(login, bolimId) {
  const { rows: [u] } = await pool.query(
    "INSERT INTO users (login, familiya, ism, role, parol) VALUES ($1, 'Xodim', $1, 'teacher', $2) RETURNING id", [login, HASH]);
  await pool.query('INSERT INTO xodim_bolim (user_id, bolim_id, asosiy) VALUES ($1, $2, TRUE)', [u.id, bolimId]);
  return { id: u.id, role: 'teacher', familiya: 'Xodim', ism: login };
}

before(async () => {
  await resetDb();
  app = createApp();
  HASH = await bcrypt.hash('parol123', 4);
  admin = (await pool.query("SELECT * FROM users WHERE login = 'admin'")).rows[0];
  B = (await pool.query("SELECT id FROM bolimlar WHERE nomi = 'AT dekanati'")).rows[0].id;
  MT = (await pool.query('SELECT id FROM murojaat_turlari WHERE bolim_id = $1 LIMIT 1', [B])).rows[0].id;
  X = await newXodim('xodim_test', B);
});
after(() => pool.end());

const shablon = (over) => ({ xodim_id: X.id, bolim_id: B, hafta_kuni: 1, start_time: '09:00', end_time: '11:00', slot_min: 15, max_navbat: 6, ...over });

test('TC-09/TC-10: ustma-ust shablon va biriktirilmagan bo\'lim rad etiladi', async () => {
  await qabul.createShablon(admin, shablon({ hafta_kuni: 6, start_time: '09:00', end_time: '10:00' }), fakeReq);
  await assert.rejects(
    qabul.createShablon(admin, shablon({ hafta_kuni: 6, start_time: '09:30', end_time: '11:00' }), fakeReq),
    /\(Sh 09:00–10:00, AT dekanati\) bilan kesishadi/);
  // chegaradosh vaqt — ruxsat
  await qabul.createShablon(admin, shablon({ hafta_kuni: 6, start_time: '10:00', end_time: '10:30' }), fakeReq);
  const reg = (await pool.query("SELECT id FROM bolimlar WHERE nomi = 'Registrator ofisi'")).rows[0].id;
  await assert.rejects(qabul.createShablon(admin, shablon({ hafta_kuni: 7, bolim_id: reg }), fakeReq), /biriktirilmagan/);
  await pool.query('DELETE FROM qabul_vaqti WHERE xodim_id = $1', [X.id]);
});

test('TC-11: 09:00–11:00, 15 daq, max 6 → 6 slot (09:00…10:15)', async () => {
  const sana = nextDow(1);
  const id = await qabul.createShablon(admin, shablon(), fakeReq);
  const [g] = await daySlots({ xodimId: X.id, sana });
  assert.equal(g.qabul_vaqti_id, id);
  assert.equal(g.slots.length, 6);
  assert.equal(g.slots[0].boshlanish, '09:00');
  assert.equal(g.slots[5].boshlanish, '10:15');
  assert.equal(g.slots[5].tugash, '10:30');
  // boshqa kunda yo'q
  assert.equal((await daySlots({ xodimId: X.id, sana: addDays(sana, 1) })).length, 0);
});

test('TC-13 (ilova E-A): 15 parallel so\'rov bitta slotga → aynan 1 tasi oladi', async () => {
  const sana = nextDow(1);
  const qv = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1', [X.id])).rows[0].id;
  const studs = [];
  for (let i = 0; i < 15; i++) studs.push(await newStudent(`par_a${i}`));
  const res = await Promise.allSettled(studs.map((s) => bandQilish({ studentId: s, qabulVaqtiId: qv, sana, navbatRaqami: 3, murojaatTuriId: MT })));
  const ok = res.filter((r) => r.status === 'fulfilled');
  assert.equal(ok.length, 1, res.map((r) => r.reason?.message).join(' | '));
  assert.equal(ok[0].value.boshlanish, '09:30');
  assert.ok(res.filter((r) => r.status === 'rejected').every((r) => /band/.test(r.reason.message)));
});

test('ilova E-B: 10 talaba "birinchi bo\'sh" → 5 ta (1,2,4,5,6), qolgani "joy qolmadi"', async () => {
  const sana = nextDow(1);
  const qv = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1', [X.id])).rows[0].id;
  const studs = [];
  for (let i = 0; i < 10; i++) studs.push(await newStudent(`par_b${i}`));
  const res = await Promise.allSettled(studs.map((s) => bandQilish({ studentId: s, qabulVaqtiId: qv, sana, navbatRaqami: null, murojaatTuriId: MT })));
  const nums = res.filter((r) => r.status === 'fulfilled').map((r) => r.value.navbat_raqami).sort((a, b) => a - b);
  assert.deepEqual(nums, [1, 2, 4, 5, 6]);
  assert.ok(res.filter((r) => r.status === 'rejected').every((r) => /Bo'sh joy qolmadi/.test(r.reason.message)));
});

test('TC-14 (ilova E-C): jonli navbat (max 20) ga 30 parallel → aynan 20, raqamlar takrorlanmas', async () => {
  const sana = nextDow(2);
  const qv = await qabul.createShablon(admin, shablon({ hafta_kuni: 2, slot_min: null, max_navbat: 20 }), fakeReq);
  const studs = [];
  for (let i = 0; i < 30; i++) studs.push(await newStudent(`par_c${i}`));
  const res = await Promise.allSettled(studs.map((s) => bandQilish({ studentId: s, qabulVaqtiId: qv, sana, murojaatTuriId: MT })));
  const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.equal(ok.length, 20);
  assert.deepEqual(ok.map((n) => n.navbat_raqami).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(ok.every((n) => n.boshlanish === null));
});

test('TC-15 (ilova E-D): bir talaba bitta qabulga ikki marta (parallel) → 1 OK', async () => {
  const sana = nextDow(1, 8);
  const qv = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni = 1', [X.id])).rows[0].id;
  const s = await newStudent('ikki_tab');
  const res = await Promise.allSettled([1, 2].map((n) => bandQilish({ studentId: s, qabulVaqtiId: qv, sana, navbatRaqami: n, murojaatTuriId: MT })));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(res.find((r) => r.status === 'rejected').reason.message, /allaqachon navbat bor/);
});

test('TC-16 (ilova E-E): Dushanba shabloniga Seshanba sanasi rad etiladi', async () => {
  const qv = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni = 1', [X.id])).rows[0].id;
  const s = await newStudent('notogri_kun');
  await assert.rejects(bandQilish({ studentId: s, qabulVaqtiId: qv, sana: nextDow(2), murojaatTuriId: MT }), /qabul qilmaydi/);
});

test('BR-01/BR-21: o\'tgan sana va oynadan tashqari sana rad etiladi; murojaat turi majburiy', async () => {
  const qv = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni = 1', [X.id])).rows[0].id;
  const s = await newStudent('oyna');
  let past = addDays(today(), -1); while (isoDow(past) !== 1) past = addDays(past, -1);
  await assert.rejects(bandQilish({ studentId: s, qabulVaqtiId: qv, sana: past, murojaatTuriId: MT }), /O'tgan sanaga/);
  await assert.rejects(bandQilish({ studentId: s, qabulVaqtiId: qv, sana: nextDow(1, 15), murojaatTuriId: MT }), /14 kun oldinga/);
  const regMt = (await pool.query("SELECT mt.id FROM murojaat_turlari mt JOIN bolimlar b ON b.id = mt.bolim_id WHERE b.nomi = 'Registrator ofisi' LIMIT 1")).rows[0].id;
  await assert.rejects(bandQilish({ studentId: s, qabulVaqtiId: qv, sana: nextDow(1), murojaatTuriId: regMt }), /Murojaat turini tanlang/);
});

test('TC-18 (BR-03): 4-faol bron rad etiladi', async () => {
  const s = await newStudent('limit3');
  for (const kun of [3, 4, 5]) await qabul.createShablon(admin, shablon({ hafta_kuni: kun }), fakeReq);
  const ids = (await pool.query('SELECT id, hafta_kuni FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni IN (1,3,4,5) AND status ORDER BY hafta_kuni', [X.id])).rows;
  for (const q of ids.slice(1)) await bandQilish({ studentId: s, qabulVaqtiId: q.id, sana: nextDow(q.hafta_kuni), murojaatTuriId: MT });
  await assert.rejects(bandQilish({ studentId: s, qabulVaqtiId: ids[0].id, sana: nextDow(1, 8), murojaatTuriId: MT }), /ko'pi bilan 3 ta/);
});

test('BR-04b: talabaning bir kundagi ikki xodimdagi bronlari vaqt bo\'yicha kesishmaydi', async () => {
  const X2 = await newXodim('xodim_test2', B);
  const sana = nextDow(3);
  const q2 = await qabul.createShablon(admin, shablon({ xodim_id: X2.id, hafta_kuni: 3, slot_min: 30, max_navbat: 4 }), fakeReq);
  const q1 = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni = 3', [X.id])).rows[0].id;
  const s = await newStudent('kesishuv');
  await bandQilish({ studentId: s, qabulVaqtiId: q1, sana, navbatRaqami: 2, murojaatTuriId: MT });           // 09:15–09:30
  await assert.rejects(bandQilish({ studentId: s, qabulVaqtiId: q2, sana, navbatRaqami: 1, murojaatTuriId: MT }), /boshqa navbatingiz bor/); // 09:00–09:30
  const ok = await bandQilish({ studentId: s, qabulVaqtiId: q2, sana, navbatRaqami: 2, murojaatTuriId: MT });            // 09:30–10:00
  assert.equal(ok.boshlanish, '09:30');
});

test('TC-17 (ilova E-G): bekor qilingan slot qayta beriladi', async () => {
  const sana = nextDow(4);
  const q = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni = 4', [X.id])).rows[0].id;
  const a = await newStudent('bekor_a'); const b = await newStudent('bekor_b');
  const na = await bandQilish({ studentId: a, qabulVaqtiId: q, sana, navbatRaqami: 2, murojaatTuriId: MT });
  await assert.rejects(bandQilish({ studentId: b, qabulVaqtiId: q, sana, navbatRaqami: 2, murojaatTuriId: MT }), /band/);
  await st.cancelByStudent({ student: { id: a }, navbatId: na.id, sabab: 'Rejalar o\'zgardi' });
  const nb = await bandQilish({ studentId: b, qabulVaqtiId: q, sana, navbatRaqami: 2, murojaatTuriId: MT });
  assert.equal(nb.navbat_raqami, 2);
  const g = (await daySlots({ xodimId: X.id, sana }))[0];
  assert.equal(g.slots[1].band, true);
});

test('TC-12/TC-24: istisno kunida slot yo\'q; kiritilganda faol bronlar bekor bo\'ladi + outbox', async () => {
  const sana = nextDow(5);
  const q = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni = 5', [X.id])).rows[0].id;
  const studs = [await newStudent('ist_a'), await newStudent('ist_b'), await newStudent('ist_c')];
  for (const s of studs) await bandQilish({ studentId: s, qabulVaqtiId: q, sana, murojaatTuriId: MT });
  const before1 = (await pool.query('SELECT count(*)::int AS n FROM bildirishnomalar')).rows[0].n;
  const p = await qabul.previewIstisno(admin, { xodim_id: X.id, dan: sana, gacha: sana, sabab: 'Xizmat safari' }, fakeReq);
  assert.ok(p.n >= 3);
  const n = await qabul.createIstisno(admin, { xodim_id: X.id, dan: sana, gacha: sana, sabab: 'Xizmat safari' }, fakeReq);
  assert.equal(n, p.n);
  const { rows } = await pool.query('SELECT status, javob_izoh FROM navbatlar WHERE qabul_vaqti_id = $1 AND sana = $2', [q, sana]);
  assert.ok(rows.every((r) => r.status === 'bekor_qilindi' && /Xizmat safari/.test(r.javob_izoh)));
  const after1 = (await pool.query('SELECT count(*)::int AS n FROM bildirishnomalar')).rows[0].n;
  assert.equal(after1 - before1, p.n);
  assert.equal((await daySlots({ xodimId: X.id, sana })).length, 0);
  await assert.rejects(bandQilish({ studentId: await newStudent('ist_d'), qabulVaqtiId: q, sana, murojaatTuriId: MT }), /istisno/);
  // O'tgan sanaga istisno kiritib bo'lmaydi (FR-IST-04)
  const { errors } = qabul.parseIstisno({ xodim_id: X.id, dan: addDays(today(), -1), sabab: 'x' });
  assert.ok(errors.dan);
});

test('Bayram kuni slot ko\'rsatilmaydi va bron qilinmaydi (BR-15)', async () => {
  const sana = nextDow(3, 8);
  await qabul.addBayram(admin, { sana, nomi: 'Test bayrami' }, fakeReq);
  assert.equal((await daySlots({ xodimId: X.id, sana })).length, 0);
  const q = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni = 3', [X.id])).rows[0].id;
  await assert.rejects(bandQilish({ studentId: await newStudent('bayram'), qabulVaqtiId: q, sana, murojaatTuriId: MT }), /bayram/);
});

test('Holatlar mashinasi: TC-21, TC-22, TC-25, FR-XP-07 + htmx qatori', async () => {
  const sana = nextDow(1);
  const nav = (await pool.query(
    "SELECT n.id FROM navbatlar n JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id WHERE q.xodim_id = $1 AND n.sana = $2 AND n.status = 'tasdiqlandi' LIMIT 1",
    [X.id, sana])).rows[0].id;
  const xodim = await login(app, 'xodim_test');
  // TC-22: kelgusi navbat "qabul qilindi" bo'lmaydi
  let r = await xodim.form(`/navbat/${nav}/holat`, { status: 'qabul_qilindi' });
  assert.equal(r.status, 409);
  // "kelmadi" — qabul boshlanmagan
  r = await xodim.form(`/navbat/${nav}/holat`, { status: 'kelmadi' });
  assert.equal(r.status, 409);
  // TC-21: izohsiz bekor qilish
  r = await xodim.form(`/navbat/${nav}/holat`, { status: 'bekor_qilindi' });
  assert.equal(r.status, 400);
  // TC-25: boshqa xodim o'zgartira olmaydi
  const other = await login(app, 'karimova');
  r = await other.form(`/navbat/${nav}/holat`, { status: 'bekor_qilindi', izoh: 'x' });
  assert.equal(r.status, 403);
  // Javob yozish (htmx) — qator qaytadi
  r = await xodim.post(`/navbat/${nav}/javob`).set('HX-Request', 'true').type('form').send({ _csrf: xodim.csrf, javob: 'Pasportingizni olib keling' });
  assert.equal(r.status, 200);
  assert.match(r.text, /<tr id="nav-/);
  assert.match(r.text, /Pasportingizni olib keling/);
  // Izoh bilan bekor qilish (htmx)
  r = await xodim.post(`/navbat/${nav}/holat`).set('HX-Request', 'true').type('form').send({ _csrf: xodim.csrf, status: 'bekor_qilindi', izoh: 'Kasal bo\'lib qoldim' });
  assert.equal(r.status, 200);
  assert.match(r.text, /Bekor qilindi/);
  // Yakuniy holatdan o'tish yo'q
  r = await xodim.form(`/navbat/${nav}/holat`, { status: 'tasdiqlandi' });
  assert.equal(r.status, 409);
  const tarix = (await pool.query('SELECT yangi_status FROM navbat_tarix WHERE navbat_id = $1 ORDER BY id', [nav])).rows.map((x) => x.yangi_status);
  assert.deepEqual(tarix, ['tasdiqlandi', 'bekor_qilindi']);
});

test('TC-23 (BR-07): cron qabul tugagan faol bronlarni "kelmadi" qiladi; xodim 24 soatda tuzatadi', async () => {
  const q = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni = 1', [X.id])).rows[0].id;
  const s = await newStudent('cron_t');
  const kecha = addDays(today(), -1);
  const { rows: [n] } = await pool.query(
    `INSERT INTO navbatlar (student_id, qabul_vaqti_id, murojaat_turi_id, sana, boshlanish, tugash, navbat_raqami, status)
     VALUES ($1, $2, $3, $4, '09:00', '09:15', 1, 'tasdiqlandi') RETURNING id`, [s, q, MT, kecha]);
  const r = await request(app).post('/internal/cron/kelmadi').set('X-Cron-Secret', 'test-cron');
  assert.equal(r.status, 200);
  assert.ok(r.body.yangilandi >= 1);
  assert.equal((await pool.query('SELECT status FROM navbatlar WHERE id = $1', [n.id])).rows[0].status, 'kelmadi');
  // 24 soatdan o'tgan (kecha 09:15) — tuzatib bo'lmaydi, agar hozir 09:15 dan keyin bo'lsa
  const xodim = await login(app, 'xodim_test');
  const fix = await xodim.form(`/navbat/${n.id}/holat`, { status: 'qabul_qilindi' });
  if (toMin(nowTime()) > toMin('09:15')) assert.equal(fix.status, 409);
  else assert.equal(fix.status, 302);
});

test('TC-30 / BR-10 / BR-11: navbatli shablonni tahrirlash va o\'chirish', async () => {
  const q = (await pool.query('SELECT * FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni = 1', [X.id])).rows[0];
  // vaqtni o'zgartirib bo'lmaydi
  await assert.rejects(qabul.updateShablon(admin, q, { ...q, start_time: '08:00' }, fakeReq), /o'zgartirib bo'lmaydi/);
  // max_navbat ni kamaytirib bo'lmaydi, oshirish mumkin
  await assert.rejects(qabul.updateShablon(admin, q, { ...q, max_navbat: 5 }, fakeReq), /faqat oshirish/);
  await qabul.updateShablon(admin, q, { ...q, max_navbat: 8 }, fakeReq);
  // o'chirish -> nofaol + kelgusi bronlar bekor
  const r = await qabul.deleteShablon(admin, { ...q, max_navbat: 8 }, fakeReq);
  assert.equal(r.deleted, false);
  assert.ok(r.bekor > 0);
  assert.equal((await pool.query('SELECT status FROM qabul_vaqti WHERE id = $1', [q.id])).rows[0].status, false);
  assert.equal((await pool.query(
    "SELECT count(*)::int AS n FROM navbatlar WHERE qabul_vaqti_id = $1 AND sana >= $2 AND status IN ('kutilmoqda','tasdiqlandi')", [q.id, today()])).rows[0].n, 0);
  // navbatsiz shablon haqiqatan o'chadi
  const id = await qabul.createShablon(admin, shablon({ hafta_kuni: 7, start_time: '18:00', end_time: '19:00' }), fakeReq);
  assert.equal((await qabul.deleteShablon(admin, { id, xodim_id: X.id }, fakeReq)).deleted, true);
});

test('FR-USR-06: talaba bloklanganda kelgusi navbatlari bekor qilinadi', async () => {
  const s = await newStudent('blok_t');
  const q = (await pool.query('SELECT id FROM qabul_vaqti WHERE xodim_id = $1 AND hafta_kuni = 2', [X.id])).rows[0];
  if (!q) return;
  const X3 = await newXodim('xodim_test3', B);
  const q3 = await qabul.createShablon(admin, shablon({ xodim_id: X3.id, hafta_kuni: 4, max_navbat: 4 }), fakeReq);
  const n = await bandQilish({ studentId: s, qabulVaqtiId: q3, sana: nextDow(4), murojaatTuriId: MT });
  const adm = await login(app, 'admin', 'admin12345');
  await adm.form(`/admin/users/${s}/status`);
  assert.equal((await pool.query('SELECT status FROM navbatlar WHERE id = $1', [n.id])).rows[0].status, 'bekor_qilindi');
  await assert.rejects(bandQilish({ studentId: s, qabulVaqtiId: q3, sana: nextDow(4), murojaatTuriId: MT }), /bloklangan/);
});

test('Ko\'rish huquqi: tyutor o\'z guruhi navbatini ko\'radi, boshqa talaba ko\'rmaydi', async () => {
  const t1 = await userId('talaba1');   // AT-21-01 — tyutor_at guruhi
  const q = (await pool.query("SELECT q.id, q.hafta_kuni FROM qabul_vaqti q JOIN users u ON u.id = q.xodim_id WHERE u.login = 'registrator' AND q.hafta_kuni = 2")).rows[0];
  const regMt = (await pool.query("SELECT mt.id FROM murojaat_turlari mt JOIN bolimlar b ON b.id = mt.bolim_id WHERE b.nomi = 'Registrator ofisi' LIMIT 1")).rows[0].id;
  const n = await bandQilish({ studentId: t1, qabulVaqtiId: q.id, sana: nextDow(2), murojaatTuriId: regMt });
  assert.equal((await (await login(app, 'tyutor_at')).get(`/navbat/${n.id}`)).status, 200);
  assert.equal((await (await login(app, 'talaba2')).get(`/navbat/${n.id}`)).status, 403);
  assert.equal((await (await login(app, 'registrator')).get(`/navbat/${n.id}`)).status, 200);
  assert.equal((await (await login(app, 'dekan_iq')).get(`/navbat/${n.id}`)).status, 403);
});

test('HTTP: talaba ustasi orqali navbat oladi va chiptani ko\'radi (≤6 bosish)', async () => {
  const agent = await login(app, 'talaba3');
  const reg = (await pool.query("SELECT id FROM bolimlar WHERE nomi = 'Registrator ofisi'")).rows[0].id;
  const tur = (await pool.query("SELECT id FROM murojaat_turlari WHERE bolim_id = $1 AND nomi = 'Transkript olish'", [reg])).rows[0].id;
  const xid = await userId('registrator');
  const sana = nextDow(3);
  const page = await agent.get(`/navbat/yangi?bolim=${reg}&tur=${tur}&xodim=${xid}&sana=${sana}`);
  const slot = page.text.match(/name="slot" value="(\d+:\d+)"/)[1];
  const r = await agent.form('/navbat', { bolim: reg, tur, xodim: xid, sana, slot, mavzu: 'Transkript kerak' });
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /^\/navbat\/\d+$/);
  const ticket = await agent.get(r.headers.location);
  assert.match(ticket.text, /№1/);
  assert.match(ticket.text, /101-xona/);
  assert.match(ticket.text, /Pasport nusxasi/);
  // Shu slotni boshqa talaba ololmaydi — xabar bilan qaytadi (FR-NAV-04)
  const other = await login(app, 'talaba4');
  const r2 = await other.form('/navbat', { bolim: reg, tur, xodim: xid, sana, slot });
  assert.equal(r2.status, 302);
  const back = await other.get(r2.headers.location);
  assert.match(back.text, /hozirgina band bo&#x27;ldi|hozirgina band bo'ldi/);
  // Mening navbatlarim
  assert.match((await agent.get('/navbatlarim')).text, /Registrator ofisi/);
});

test('TC-19/TC-20 (BR-02, BR-05): bugungi yozilish yopilishi va bekor qilish muddati', async (t) => {
  const now = toMin(nowTime());
  if (now < 60 || now > 22 * 60) return t.skip('vaqt kun chegarasiga yaqin');
  const start = Math.ceil((now + 20) / 5) * 5;                 // ~20–24 daqiqadan keyin
  const X4 = await newXodim('xodim_bugun', B);
  const q = await qabul.createShablon(admin, shablon({
    xodim_id: X4.id, hafta_kuni: isoDow(today()), start_time: fromMin(start), end_time: fromMin(start + 60), slot_min: 30, max_navbat: 2,
  }), fakeReq);
  const s = await newStudent('bugun_t');
  await assert.rejects(bandQilish({ studentId: s, qabulVaqtiId: q, sana: today(), navbatRaqami: 1, murojaatTuriId: MT }), /yopilgan/);
  const slots = (await daySlots({ xodimId: X4.id, sana: today() }))[0].slots;
  assert.equal(slots[0].yopiq, true);
  assert.equal(slots[1].mavjud, true);
  const n = await bandQilish({ studentId: s, qabulVaqtiId: q, sana: today(), navbatRaqami: 2, murojaatTuriId: MT });
  // slot ~50 daqiqadan keyin boshlanadi — 1 soatdan kam: talaba bekor qila olmaydi
  await assert.rejects(st.cancelByStudent({ student: { id: s }, navbatId: n.id }), /1 soat oldin/);
});

test('Yakuniy tekshiruv: hech bir shablon/sanada faol raqam takrorlanmagan', async () => {
  const { rows } = await pool.query(
    `SELECT qabul_vaqti_id, sana, count(*) AS jami, count(DISTINCT navbat_raqami) AS noyob FROM navbatlar
      WHERE status IN ('kutilmoqda','tasdiqlandi','qabul_qilindi','kelmadi') GROUP BY 1, 2`);
  assert.ok(rows.length > 0);
  for (const r of rows) assert.equal(r.jami, r.noyob);
});
