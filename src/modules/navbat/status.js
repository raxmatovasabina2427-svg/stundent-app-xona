// 6.5: navbat holatlari mashinasi
const db = require('../../db/pool');
const { AppError, forbidden, notFound } = require('../../lib/http');
const { navbatAccess } = require('../../middleware/rbac');
const { getSettings } = require('../../lib/settings');
const { today, nowTime, toMin, tashkentMs, fmtDate } = require('../../lib/time');
const { notify } = require('./notify');
const { audit } = require('../../lib/audit');

const FAOL = ['kutilmoqda', 'tasdiqlandi'];

/** Ruxsat etilgan o'tishlar (xodim/dekanat/admin uchun) */
const TRANSITIONS = {
  kutilmoqda: ['tasdiqlandi', 'rad_etildi', 'bekor_qilindi', 'kelmadi'],
  tasdiqlandi: ['qabul_qilindi', 'kelmadi', 'bekor_qilindi'],
  kelmadi: ['qabul_qilindi'],
  qabul_qilindi: [],
  rad_etildi: [],
  bekor_qilindi: [],
};

const NAV_SQL = `
  SELECT n.*, q.xodim_id, q.bolim_id, q.start_time, q.end_time, q.slot_min, q.hafta_kuni,
         s.guruh, b.nomi AS bolim, b.xona, x.familiya AS x_familiya, x.ism AS x_ism
    FROM navbatlar n
    JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id
    JOIN bolimlar b    ON b.id = q.bolim_id
    JOIN users x       ON x.id = q.xodim_id
    LEFT JOIN student_info s ON s.user_id = n.student_id`;

async function load(id, client = db, lock = false) {
  const { rows: [n] } = await client.query(`${NAV_SQL} WHERE n.id = $1 ${lock ? 'FOR UPDATE OF n' : ''}`, [id]);
  return n || null;
}

/** Qabul (yoki slot) boshlandimi — "kelmadi" faqat shundan keyin */
function started(n) {
  const b = today();
  if (n.sana < b) return true;
  if (n.sana > b) return false;
  return toMin(nowTime()) >= toMin(n.boshlanish || n.start_time);
}

async function writeHistory(client, navbatId, eski, yangi, userId, izoh) {
  await client.query(
    'INSERT INTO navbat_tarix (navbat_id, eski_status, yangi_status, user_id, izoh) VALUES ($1,$2,$3,$4,$5)',
    [navbatId, eski, yangi, userId, izoh || null]);
}

const XABAR = {
  tasdiqlandi: (n) => `✅ Navbatingiz tasdiqlandi: №${n.navbat_raqami}, ${fmtDate(n.sana)}${n.boshlanish ? ` ${n.boshlanish}` : ''}, ${n.bolim}`,
  rad_etildi: (n, izoh) => `❌ Navbatingiz rad etildi (${fmtDate(n.sana)}, ${n.bolim}): ${izoh}`,
  bekor_qilindi: (n, izoh) => `Navbatingiz bekor qilindi (${fmtDate(n.sana)}, ${n.bolim}): ${izoh}`,
  qabul_qilindi: null,
  kelmadi: null,
};

/** Xodim / dekanat / admin holatni o'zgartiradi (FR-XP-02, BR-17…BR-20) */
async function changeStatus({ actor, navbatId, yangi, izoh, req }) {
  izoh = String(izoh || '').trim().slice(0, 2000);
  return db.tx(async (c) => {
    const n = await load(navbatId, c, true);
    if (!n) throw notFound('Navbat topilmadi');
    if (!(await navbatAccess(actor, n, 'manage', req))) throw forbidden();
    if (!(TRANSITIONS[n.status] || []).includes(yangi)) {
      throw new AppError(`"${n.status}" holatidan "${yangi}" ga o'tib bo'lmaydi`, 409);         // FR-XP-07
    }
    const bugun = today();
    if (yangi === 'tasdiqlandi' && n.sana < bugun) throw new AppError('O\'tgan navbatni tasdiqlab bo\'lmaydi', 409);
    if (yangi === 'qabul_qilindi' && n.sana > bugun) throw new AppError('Kelgusi navbatni "qabul qilindi" qilib bo\'lmaydi', 409); // BR-20
    if (yangi === 'kelmadi' && !started(n)) throw new AppError('Qabul hali boshlanmagan', 409);
    if (['rad_etildi', 'bekor_qilindi'].includes(yangi) && !izoh) throw new AppError('Sababni (izohni) yozing');        // BR-18
    if (n.status === 'kelmadi' && yangi === 'qabul_qilindi') {
      const tugadi = tashkentMs(n.sana, n.tugash || n.end_time);
      if (Date.now() - tugadi > 24 * 3600 * 1000) throw new AppError('Tuzatish muddati (24 soat) o\'tgan', 409);
    }

    await c.query(
      `UPDATE navbatlar SET status = $1, javob_izoh = COALESCE(NULLIF($2, ''), javob_izoh), ozgartirgan_id = $3 WHERE id = $4`,
      [yangi, izoh, actor.id, n.id]);
    await writeHistory(c, n.id, n.status, yangi, actor.id, izoh);
    const msg = XABAR[yangi]?.(n, izoh);
    if (msg) await notify(c, n.student_id, msg);
    await audit({ client: c, req, amal: 'navbat.status', obyekt: 'navbatlar', obyektId: n.id, eski: { status: n.status }, yangi: { status: yangi, izoh } });
    return { ...n, status: yangi, javob_izoh: izoh || n.javob_izoh };
  });
}

/** Xodimning javobi (holat o'zgarmaydi) */
async function setJavob({ actor, navbatId, javob, req }) {
  javob = String(javob || '').trim().slice(0, 2000);
  if (!javob) throw new AppError('Javob matnini yozing');
  return db.tx(async (c) => {
    const n = await load(navbatId, c, true);
    if (!n) throw notFound();
    if (!(await navbatAccess(actor, n, 'manage', req))) throw forbidden();
    await c.query('UPDATE navbatlar SET javob_izoh = $1, ozgartirgan_id = $2 WHERE id = $3', [javob, actor.id, n.id]);
    await notify(c, n.student_id, `💬 ${n.x_familiya} ${n.x_ism[0]}. javob yozdi (${fmtDate(n.sana)}): ${javob}`);
    await audit({ client: c, req, amal: 'navbat.javob', obyekt: 'navbatlar', obyektId: n.id });
    return { ...n, javob_izoh: javob };
  });
}

/** Talaba o'z navbatini bekor qiladi (BR-05) */
async function cancelByStudent({ student, navbatId, sabab, req }) {
  const s = await getSettings();
  return db.tx(async (c) => {
    const n = await load(navbatId, c, true);
    if (!n || n.student_id !== student.id) throw notFound('Navbat topilmadi');
    if (!FAOL.includes(n.status)) throw new AppError('Bu navbatni bekor qilib bo\'lmaydi', 409);
    const boshlanish = tashkentMs(n.sana, n.boshlanish || n.start_time);
    if (boshlanish - Date.now() < Number(s.bekor_muddati_soat) * 3600 * 1000) {
      throw new AppError(`Navbatni qabuldan kamida ${s.bekor_muddati_soat} soat oldin bekor qilish mumkin`, 409);
    }
    const izoh = String(sabab || '').trim().slice(0, 500) || 'Talaba bekor qildi';
    await c.query("UPDATE navbatlar SET status = 'bekor_qilindi', javob_izoh = $1, ozgartirgan_id = $2 WHERE id = $3",
      [`Talaba: ${izoh}`, student.id, n.id]);
    await writeHistory(c, n.id, n.status, 'bekor_qilindi', student.id, izoh);
    await notify(c, n.xodim_id, `Talaba navbatni bekor qildi: ${fmtDate(n.sana)} №${n.navbat_raqami}`);
    await audit({ client: c, req, userId: student.id, amal: 'navbat.bekor', obyekt: 'navbatlar', obyektId: n.id });
  });
}

/**
 * Tizim tomonidan ommaviy bekor qilish (istisno, bayram, shablon nofaol, bloklash) — BR-09.
 * filterSql: navbatlar n va qabul_vaqti q bo'yicha WHERE qismi ($1 dan boshlab parametrlar).
 */
async function cancelMany(client, { filterSql, params, izoh, actorId }) {
  const p = [...params];
  p.push(izoh, actorId ?? null, today());
  const i = params.length;
  const { rows } = await client.query(
    `UPDATE navbatlar n SET status = 'bekor_qilindi', javob_izoh = $${i + 1}, ozgartirgan_id = $${i + 2}
       FROM qabul_vaqti q
      WHERE q.id = n.qabul_vaqti_id AND n.status IN ('kutilmoqda','tasdiqlandi') AND n.sana >= $${i + 3}
        AND (${filterSql})
    RETURNING n.id, n.student_id, n.sana, n.navbat_raqami`, p);
  for (const r of rows) {
    await writeHistory(client, r.id, null, 'bekor_qilindi', actorId ?? null, izoh);
    await notify(client, r.student_id, `Navbatingiz bekor qilindi (${fmtDate(r.sana)}, №${r.navbat_raqami}): ${izoh}. Boshqa vaqtga yozilishingiz mumkin.`);
  }
  return rows;
}

/** Faol bronlar soni — oldindan ko'rsatish uchun */
async function countMany({ filterSql, params }) {
  const p = [...params, today()];
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM navbatlar n JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id
      WHERE n.status IN ('kutilmoqda','tasdiqlandi') AND n.sana >= $${p.length} AND (${filterSql})`, p);
  return r.n;
}

/** BR-07: qabul tugagach hali faol bo'lgan bronlar -> "kelmadi" (cron) */
async function autoKelmadi() {
  return db.tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE navbatlar n SET status = 'kelmadi', ozgartirgan_id = NULL
         FROM qabul_vaqti q
        WHERE q.id = n.qabul_vaqti_id AND n.status IN ('kutilmoqda','tasdiqlandi')
          AND (n.sana < $1 OR (n.sana = $1 AND q.end_time <= $2::time))
      RETURNING n.id, n.status`, [today(), nowTime()]);
    for (const r of rows) await writeHistory(c, r.id, null, 'kelmadi', null, 'Avtomatik: qabul tugadi');
    return rows.length;
  });
}

module.exports = { TRANSITIONS, NAV_SQL, load, changeStatus, setJavob, cancelByStudent, cancelMany, countMany, autoKelmadi, started };
