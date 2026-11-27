// 6.3: navbat band qilish (ilova D) + barcha biznes-qoidalar (6.6)
const db = require('../../db/pool');
const { AppError } = require('../../lib/http');
const { getSettings } = require('../../lib/settings');
const { today, nowTime, addDays, isYmd, toMin, fmtDate, KUN_QISQA, isoDow } = require('../../lib/time');
const { OCCUPYING, SIGIM_SQL } = require('./slots');
const { notify } = require('./notify');
const { audit } = require('../../lib/audit');

class BronXato extends AppError {}

/**
 * @param {object} p
 * @param {number} p.studentId
 * @param {number} p.qabulVaqtiId
 * @param {string} p.sana 'YYYY-MM-DD'
 * @param {number|null} p.navbatRaqami slot rejimida tanlangan raqam; null — birinchi bo'sh
 * @param {number} p.murojaatTuriId
 * @param {string|null} p.mavzu
 */
async function bandQilish({ studentId, qabulVaqtiId, sana, navbatRaqami = null, murojaatTuriId, mavzu = null, req = null }) {
  if (!isYmd(sana)) throw new BronXato('Sana noto\'g\'ri');
  if (mavzu && mavzu.length > 1000) throw new BronXato('Mavzu 1000 belgidan oshmasin');
  const s = await getSettings();
  const bugun = today();

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Shablonni qulflaymiz — shu qabul bo'yicha bronlar ketma-ket bajariladi
    const { rows: [qv] } = await client.query(
      `SELECT q.*, ${SIGIM_SQL} AS sigim, u.status AS xodim_faol, u.familiya, u.ism,
              b.status AS bolim_faol, b.nomi AS bolim, b.xona
         FROM qabul_vaqti q JOIN users u ON u.id = q.xodim_id JOIN bolimlar b ON b.id = q.bolim_id
        WHERE q.id = $1 FOR UPDATE OF q`, [qabulVaqtiId]);
    if (!qv || !qv.status || !qv.xodim_faol || !qv.bolim_faol) throw new BronXato('Qabul vaqti faol emas');

    // Talabani ham qulflaymiz: limit (BR-03) va kesishuv (BR-04b) parallel so'rovlarda ham to'g'ri bo'lsin
    const { rows: [st] } = await client.query(
      "SELECT id, status, role FROM users WHERE id = $1 FOR UPDATE", [studentId]);
    if (!st || st.role !== 'student') throw new BronXato('Navbatga faqat talaba yozila oladi');
    if (!st.status) throw new BronXato('Hisobingiz bloklangan');                                  // BR-13

    // 2) Sana qoidalari
    if (sana < bugun) throw new BronXato('O\'tgan sanaga yozilib bo\'lmaydi');                       // BR-21
    if (sana > addDays(bugun, Number(s.yozilish_oynasi_kun))) {
      throw new BronXato(`Faqat ${s.yozilish_oynasi_kun} kun oldinga yozilish mumkin`);               // BR-01
    }
    if (isoDow(sana) !== qv.hafta_kuni) throw new BronXato('Bu sanada xodim qabul qilmaydi');
    const { rows: [k] } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM qabul_istisno WHERE xodim_id = $2 AND sana = $1) AS istisno,
              EXISTS (SELECT 1 FROM bayramlar WHERE sana = $1) AS bayram`, [sana, qv.xodim_id]);
    if (k.istisno) throw new BronXato('Xodim bu sanada qabul qilmaydi (istisno)');
    if (k.bayram) throw new BronXato('Bu sana bayram kuni');                                        // BR-15

    // 3) Murojaat turi (BR-16)
    const { rows: [mt] } = await client.query('SELECT * FROM murojaat_turlari WHERE id = $1', [murojaatTuriId]);
    if (!mt || !mt.status || mt.bolim_id !== qv.bolim_id) throw new BronXato('Murojaat turini tanlang');

    // 4) Talaba limitlari
    const { rows: [lim] } = await client.query(
      `SELECT count(*)::int AS n FROM navbatlar
        WHERE student_id = $1 AND sana >= $2 AND status IN ('kutilmoqda','tasdiqlandi')`, [studentId, bugun]);
    if (lim.n >= Number(s.max_faol_bron)) {
      throw new BronXato(`Bir vaqtda ko'pi bilan ${s.max_faol_bron} ta faol navbat bo'lishi mumkin`);  // BR-03
    }
    if (s.kelmadi_jazo === true) {                                                                    // BR-08
      const { rows: [j] } = await client.query(
        `SELECT count(*)::int AS n, max(sana) AS oxirgi FROM navbatlar
          WHERE student_id = $1 AND status = 'kelmadi' AND sana >= $2`,
        [studentId, addDays(bugun, -Number(s.kelmadi_davr_kun))]);
      if (j.n >= Number(s.kelmadi_chegara) && addDays(j.oxirgi, Number(s.kelmadi_taqiq_kun)) >= bugun) {
        throw new BronXato(`Ko'p marta kelmaganingiz uchun ${fmtDate(addDays(j.oxirgi, Number(s.kelmadi_taqiq_kun)))} gacha yozilish cheklangan`);
      }
    }

    // 5) Band raqamlar va tanlash
    const { rows } = await client.query(
      'SELECT navbat_raqami FROM navbatlar WHERE qabul_vaqti_id = $1 AND sana = $2 AND status = ANY($3)',
      [qabulVaqtiId, sana, OCCUPYING]);
    const band = new Set(rows.map((r) => r.navbat_raqami));
    const jonli = qv.slot_min === null;
    let n = jonli ? null : navbatRaqami;
    if (n === null || n === undefined) { n = 1; while (band.has(n)) n++; }
    if (!Number.isInteger(n) || n < 1) throw new BronXato('Slot noto\'g\'ri');
    if (n > qv.sigim) throw new BronXato('Bo\'sh joy qolmadi');
    if (band.has(n)) throw new BronXato('Bu vaqt hozirgina band bo\'ldi, boshqa vaqtni tanlang');

    // 6) Vaqtni server hisoblaydi (mijozdan olinmaydi)
    const bosh = jonli ? null : toMin(qv.start_time) + (n - 1) * qv.slot_min;
    const tug = jonli ? null : bosh + qv.slot_min;

    // BR-02: bugungi yozilish slot boshlanishidan M daqiqa oldin yopiladi
    if (sana === bugun) {
      const deadline = (jonli ? toMin(qv.end_time) : bosh) - Number(s.bugun_yopilish_daq);
      if (toMin(nowTime()) > deadline) throw new BronXato('Bu vaqtga yozilish yopilgan');
    }

    // BR-04b: talabaning shu kundagi boshqa bronlari bilan vaqt kesishmasin
    // Jonli navbat butun qabul oralig'ini band qilmaydi — faqat aniq vaqtli slotlar o'zaro tekshiriladi
    const { rows: boshqa } = jonli ? { rows: [] } : await client.query(
      `SELECT boshlanish AS b, tugash AS t FROM navbatlar
        WHERE student_id = $1 AND sana = $2 AND status IN ('kutilmoqda','tasdiqlandi')
          AND qabul_vaqti_id <> $3 AND boshlanish IS NOT NULL`,
      [studentId, sana, qabulVaqtiId]);
    if (boshqa.some((o) => toMin(o.b) < tug && bosh < toMin(o.t))) {
      throw new BronXato('Bu vaqtda sizning boshqa navbatingiz bor');
    }

    const status = s.tasdiqlash_rejimi === 'qolda' ? 'kutilmoqda' : 'tasdiqlandi';                    // BR-06
    const { rows: [nav] } = await client.query(
      `INSERT INTO navbatlar (student_id, qabul_vaqti_id, murojaat_turi_id, sana, boshlanish, tugash, navbat_raqami, mavzu, status)
       VALUES ($1, $2, $3, $4,
               CASE WHEN $5::int IS NULL THEN NULL ELSE make_time($5::int / 60, $5::int % 60, 0) END,
               CASE WHEN $6::int IS NULL THEN NULL ELSE make_time($6::int / 60, $6::int % 60, 0) END,
               $7, $8, $9)
       RETURNING id, navbat_raqami, boshlanish, tugash, status, sana`,
      [studentId, qabulVaqtiId, murojaatTuriId, sana, bosh, tug, n, mavzu || null, status]);
    await client.query(
      'INSERT INTO navbat_tarix (navbat_id, eski_status, yangi_status, user_id) VALUES ($1, NULL, $2, $3)',
      [nav.id, status, studentId]);

    const vaqt = jonli ? `qabul ${qv.start_time}–${qv.end_time}` : `${nav.boshlanish}–${nav.tugash}`;
    await notify(client, studentId,
      `✅ Navbatingiz: №${n}, ${fmtDate(sana)} (${KUN_QISQA[qv.hafta_kuni]}) ${vaqt}, ${qv.familiya} ${qv.ism[0]}., ${qv.bolim}${qv.xona ? `, ${qv.xona}-xona` : ''}`);
    await audit({ client, req, userId: studentId, amal: 'navbat.create', obyekt: 'navbatlar', obyektId: nav.id, yangi: { qabulVaqtiId, sana, n } });

    await client.query('COMMIT');
    return nav;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') {
      throw new BronXato(e.constraint === 'ux_navbat_student_kun'
        ? 'Sizda bu qabulga shu kunga allaqachon navbat bor'
        : 'Bu vaqt hozirgina band bo\'ldi, boshqa vaqtni tanlang');
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { bandQilish, BronXato };
