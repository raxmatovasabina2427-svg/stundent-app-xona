// 6.2: mavjud slotlarni hisoblash (server tomonida, ilova C1)
const db = require('../../db/pool');
const { getSettings } = require('../../lib/settings');
const { today, nowTime, addDays, toMin } = require('../../lib/time');

const OCCUPYING = ['kutilmoqda', 'tasdiqlandi', 'qabul_qilindi', 'kelmadi'];

/** Sig'im SQL ifodasi */
const SIGIM_SQL = `CASE WHEN q.slot_min IS NULL THEN q.max_navbat
  ELSE LEAST(q.max_navbat, (EXTRACT(EPOCH FROM q.end_time - q.start_time) / 60)::int / q.slot_min) END`;

/**
 * Berilgan sana uchun qabullar va ularning slotlari.
 * @returns {Promise<Array<{qabul_vaqti_id, xodim_id, familiya, ism, bolim_id, xona, start_time, end_time, slot_min, sigim, slots:[]}>>}
 */
async function daySlots({ bolimId = null, xodimId = null, sana }) {
  const s = await getSettings();
  const { rows } = await db.query(
    `WITH qv AS (
       SELECT q.*, ${SIGIM_SQL} AS sigim, u.familiya, u.ism, u.ochestva, b.xona, b.nomi AS bolim, xb.lavozim
         FROM qabul_vaqti q
         JOIN users u     ON u.id = q.xodim_id AND u.status
         JOIN bolimlar b  ON b.id = q.bolim_id AND b.status
         LEFT JOIN xodim_bolim xb ON xb.user_id = q.xodim_id AND xb.bolim_id = q.bolim_id
        WHERE q.status
          AND ($1::bigint IS NULL OR q.bolim_id = $1)
          AND ($2::bigint IS NULL OR q.xodim_id = $2)
          AND q.hafta_kuni = EXTRACT(ISODOW FROM $3::date)
          AND NOT EXISTS (SELECT 1 FROM qabul_istisno i WHERE i.xodim_id = q.xodim_id AND i.sana = $3)
          AND NOT EXISTS (SELECT 1 FROM bayramlar h WHERE h.sana = $3)
     )
     SELECT qv.id AS qabul_vaqti_id, qv.xodim_id, qv.familiya, qv.ism, qv.ochestva, qv.lavozim,
            qv.bolim_id, qv.bolim, qv.xona, qv.start_time, qv.end_time, qv.slot_min, qv.sigim,
            g.n AS navbat_raqami,
            CASE WHEN qv.slot_min IS NOT NULL THEN qv.start_time + (g.n - 1) * make_interval(mins => qv.slot_min) END AS boshlanish,
            CASE WHEN qv.slot_min IS NOT NULL THEN qv.start_time + g.n * make_interval(mins => qv.slot_min) END AS tugash,
            (n.id IS NOT NULL) AS band
       FROM qv
       CROSS JOIN LATERAL generate_series(1, qv.sigim) AS g(n)
       LEFT JOIN navbatlar n ON n.qabul_vaqti_id = qv.id AND n.sana = $3 AND n.navbat_raqami = g.n
                            AND n.status = ANY($4)
      ORDER BY qv.start_time, qv.familiya, g.n`,
    [bolimId, xodimId, sana, OCCUPYING]);

  const isToday = sana === today();
  const nowMin = toMin(nowTime());
  const yopilish = Number(s.bugun_yopilish_daq);
  const byQv = new Map();
  for (const r of rows) {
    if (!byQv.has(r.qabul_vaqti_id)) {
      byQv.set(r.qabul_vaqti_id, {
        qabul_vaqti_id: r.qabul_vaqti_id, xodim_id: r.xodim_id, familiya: r.familiya, ism: r.ism, ochestva: r.ochestva,
        lavozim: r.lavozim, bolim_id: r.bolim_id, bolim: r.bolim, xona: r.xona, start_time: r.start_time,
        end_time: r.end_time, slot_min: r.slot_min, jonli: r.slot_min === null, sigim: r.sigim, slots: [], bosh: 0,
      });
    }
    const g = byQv.get(r.qabul_vaqti_id);
    // BR-02: bugungi slot boshlanishidan M daqiqa oldin yopiladi (jonli rejimda — qabul tugashidan)
    const deadline = toMin(r.boshlanish || r.end_time) - yopilish;
    const yopiq = isToday && nowMin > deadline;
    const slot = { navbat_raqami: r.navbat_raqami, boshlanish: r.boshlanish, tugash: r.tugash, band: r.band, yopiq, mavjud: !r.band && !yopiq };
    g.slots.push(slot);
    if (slot.mavjud) g.bosh++;
  }
  // Jonli rejimda talabaga faqat keyingi bo'sh raqam kerak
  for (const g of byQv.values()) {
    if (g.jonli) g.keyingi = g.slots.find((x) => x.mavjud)?.navbat_raqami ?? null;
  }
  return [...byQv.values()];
}

/** Yozilish oynasidagi kunlar: har kunda nechta bo'sh joy (FR M9 4-qadam) */
async function availability({ bolimId = null, xodimId = null }) {
  const s = await getSettings();
  const dan = today();
  const gacha = addDays(dan, Number(s.yozilish_oynasi_kun));
  const { rows } = await db.query(
    `WITH kunlar AS (SELECT d::date AS sana FROM generate_series($3::date, $4::date, interval '1 day') d),
     qv AS (
       SELECT k.sana, q.id, q.xodim_id, ${SIGIM_SQL} AS sigim
         FROM kunlar k
         JOIN qabul_vaqti q ON q.hafta_kuni = EXTRACT(ISODOW FROM k.sana) AND q.status
         JOIN users u ON u.id = q.xodim_id AND u.status
         JOIN bolimlar b ON b.id = q.bolim_id AND b.status
        WHERE ($1::bigint IS NULL OR q.bolim_id = $1) AND ($2::bigint IS NULL OR q.xodim_id = $2)
          AND NOT EXISTS (SELECT 1 FROM qabul_istisno i WHERE i.xodim_id = q.xodim_id AND i.sana = k.sana)
          AND NOT EXISTS (SELECT 1 FROM bayramlar h WHERE h.sana = k.sana)
     )
     SELECT qv.sana, sum(qv.sigim)::int AS sigim,
            sum(qv.sigim - (SELECT count(*) FROM navbatlar n WHERE n.qabul_vaqti_id = qv.id AND n.sana = qv.sana AND n.status = ANY($5)))::int AS bosh
       FROM qv GROUP BY qv.sana ORDER BY qv.sana`,
    [bolimId, xodimId, dan, gacha, OCCUPYING]);
  const map = new Map(rows.map((r) => [r.sana, r]));
  const days = [];
  for (let d = dan; d <= gacha; d = addDays(d, 1)) {
    const r = map.get(d);
    days.push({ sana: d, sigim: r?.sigim || 0, bosh: r?.bosh || 0, qabul: !!r });
  }
  // Bugun uchun yopilgan slotlarni aniq hisoblash
  if (days[0]?.qabul) {
    const groups = await daySlots({ bolimId, xodimId, sana: dan });
    days[0].bosh = groups.reduce((a, g) => a + g.bosh, 0);
  }
  return days;
}

module.exports = { daySlots, availability, OCCUPYING, SIGIM_SQL };
