// M7–M8: qabul shablonlari, istisnolar, bayramlar
const db = require('../../db/pool');
const { AppError, forbidden, notFound } = require('../../lib/http');
const { canManageXodim, canUseBolim } = require('../../middleware/rbac');
const { userScope, STAFF_ROLES } = require('../../lib/scope');
const { audit } = require('../../lib/audit');
const { today, addDays, isYmd, toMin, sigim, KUN_QISQA, fmtDate } = require('../../lib/time');
const { cancelMany, countMany } = require('../navbat/status');

/** Foydalanuvchi boshqara oladigan xodimlar ro'yxati */
async function managedXodimlar(actor, req) {
  if (actor.role === 'admin') {
    return (await db.query(`SELECT id, familiya, ism, role FROM users WHERE role = ANY($1) AND status ORDER BY familiya, ism`, [STAFF_ROLES])).rows;
  }
  if (actor.role === 'dekanat') {
    const scope = await userScope(actor, req);
    return (await db.query(
      `SELECT DISTINCT u.id, u.familiya, u.ism, u.role FROM users u JOIN xodim_bolim xb ON xb.user_id = u.id
        WHERE u.role = ANY($1) AND u.status AND xb.bolim_id = ANY($2::bigint[]) ORDER BY u.familiya, u.ism`,
      [STAFF_ROLES, scope.bolimIds])).rows;
  }
  return STAFF_ROLES.includes(actor.role) ? [{ id: actor.id, familiya: actor.familiya, ism: actor.ism, role: actor.role }] : [];
}

async function xodimBolimlari(xodimId) {
  return (await db.query(
    `SELECT b.id, b.nomi, xb.asosiy FROM xodim_bolim xb JOIN bolimlar b ON b.id = xb.bolim_id
      WHERE xb.user_id = $1 ORDER BY xb.asosiy DESC, b.nomi`, [xodimId])).rows;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseShablon(body) {
  const errors = {};
  const d = {
    xodim_id: Number(body.xodim_id),
    bolim_id: Number(body.bolim_id),
    hafta_kuni: Number(body.hafta_kuni),
    start_time: String(body.start_time || ''),
    end_time: String(body.end_time || ''),
    slot_min: body.rejim === 'jonli' ? null : Number(body.slot_min),
    max_navbat: Number(body.max_navbat),
  };
  if (!Number.isSafeInteger(d.bolim_id) || d.bolim_id <= 0) errors.bolim_id = 'Bo\'limni tanlang';
  if (!(d.hafta_kuni >= 1 && d.hafta_kuni <= 7)) errors.hafta_kuni = 'Hafta kunini tanlang';
  if (!TIME_RE.test(d.start_time)) errors.start_time = 'Vaqt formati HH:MM';
  if (!TIME_RE.test(d.end_time)) errors.end_time = 'Vaqt formati HH:MM';
  if (!errors.start_time && !errors.end_time && toMin(d.end_time) <= toMin(d.start_time)) errors.end_time = 'Tugash boshlanishdan keyin bo\'lsin';
  if (d.slot_min !== null && !(Number.isInteger(d.slot_min) && d.slot_min >= 5 && d.slot_min <= 240)) errors.slot_min = 'Slot 5–240 daqiqa';
  if (!(Number.isInteger(d.max_navbat) && d.max_navbat >= 1 && d.max_navbat <= 500)) errors.max_navbat = 'Maksimal navbat 1–500';
  if (!Object.keys(errors).length && d.slot_min && sigim(d) < 1) errors.slot_min = 'Bu oraliqqa birorta ham slot sig\'maydi';
  return { d, errors };
}

/** EXCLUDE (ustma-ust) xatosini tushunarli qilish — FR-QV-02 */
async function overlapMessage(d, exceptId) {
  const { rows: [o] } = await db.query(
    `SELECT q.hafta_kuni, q.start_time, q.end_time, b.nomi FROM qabul_vaqti q JOIN bolimlar b ON b.id = q.bolim_id
      WHERE q.xodim_id = $1 AND q.hafta_kuni = $2 AND q.status AND q.id <> $5
        AND timerange(q.start_time, q.end_time) && timerange($3::time, $4::time) LIMIT 1`,
    [d.xodim_id, d.hafta_kuni, d.start_time, d.end_time, exceptId || 0]);
  return o
    ? `Bu vaqt boshqa qabul (${KUN_QISQA[o.hafta_kuni]} ${o.start_time}–${o.end_time}, ${o.nomi}) bilan kesishadi`
    : 'Bu vaqt boshqa qabul bilan kesishadi';
}

async function mapErr(e, d, id) {
  if (e.code === '23P01') return new AppError(await overlapMessage(d, id));
  if (e.code === '23503' && /xodim_id_bolim_id|xodim_bolim/.test(e.constraint || e.detail || '')) return new AppError('Xodim bu bo\'limga biriktirilmagan');
  if (e.code === '23503') return new AppError('Xodim yoki bo\'lim topilmadi');
  return e;
}

async function getShablon(id) {
  const { rows: [q] } = await db.query(
    `SELECT q.*, b.nomi AS bolim, u.familiya, u.ism FROM qabul_vaqti q
       JOIN bolimlar b ON b.id = q.bolim_id JOIN users u ON u.id = q.xodim_id WHERE q.id = $1`, [id]);
  return q || null;
}

async function futureActive(qvId) {
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM navbatlar WHERE qabul_vaqti_id = $1 AND sana >= $2 AND status IN ('kutilmoqda','tasdiqlandi')`,
    [qvId, today()]);
  return r.n;
}

async function checkBolim(actor, d, req) {
  // Dekanat boshqa fakultet bo'limi nomidan jadval kirita olmaydi
  if (actor.role === 'dekanat' && actor.id !== d.xodim_id && !(await canUseBolim(actor, d.bolim_id, req))) {
    throw forbidden('Bo\'lim sizning fakultetingizga tegishli emas');
  }
}

async function createShablon(actor, d, req) {
  if (!(await canManageXodim(actor, d.xodim_id, req))) throw forbidden();
  await checkBolim(actor, d, req);
  try {
    const { rows: [q] } = await db.query(
      `INSERT INTO qabul_vaqti (xodim_id, bolim_id, hafta_kuni, start_time, end_time, slot_min, max_navbat)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [d.xodim_id, d.bolim_id, d.hafta_kuni, d.start_time, d.end_time, d.slot_min, d.max_navbat]);
    await audit({ req, amal: 'shablon.create', obyekt: 'qabul_vaqti', obyektId: q.id, yangi: d });
    return q.id;
  } catch (e) { throw await mapErr(e, d, 0); }
}

/** BR-10: kelgusi faol bronlari bor shablonda faqat max_navbat oshirilishi mumkin */
async function updateShablon(actor, old, d, req) {
  if (!(await canManageXodim(actor, old.xodim_id, req))) throw forbidden();
  d.xodim_id = old.xodim_id;
  await checkBolim(actor, d, req);
  const n = await futureActive(old.id);
  if (n > 0) {
    const changed = d.bolim_id !== old.bolim_id || d.hafta_kuni !== old.hafta_kuni || d.start_time !== old.start_time
      || d.end_time !== old.end_time || d.slot_min !== old.slot_min;
    if (changed || d.max_navbat < old.max_navbat) {
      throw new AppError(`Bu qabulga ${n} ta kelgusi navbat bor: kun, vaqt va slotni o'zgartirib bo'lmaydi, maksimal navbatni faqat oshirish mumkin. Yangi jadval uchun bu qabulni nofaol qilib, yangisini yarating.`);
    }
  }
  try {
    await db.query(
      `UPDATE qabul_vaqti SET bolim_id=$1, hafta_kuni=$2, start_time=$3, end_time=$4, slot_min=$5, max_navbat=$6 WHERE id=$7`,
      [d.bolim_id, d.hafta_kuni, d.start_time, d.end_time, d.slot_min, d.max_navbat, old.id]);
    await audit({ req, amal: 'shablon.update', obyekt: 'qabul_vaqti', obyektId: old.id, eski: old, yangi: d });
  } catch (e) { throw await mapErr(e, d, old.id); }
}

/** Faol/nofaol. Nofaol qilinganda kelgusi faol bronlar bekor qilinadi (6.5, tizim) */
async function setShablonStatus(actor, q, status, req) {
  if (!(await canManageXodim(actor, q.xodim_id, req))) throw forbidden();
  try {
    return await db.tx(async (c) => {
      await c.query('UPDATE qabul_vaqti SET status = $1 WHERE id = $2', [status, q.id]);
      let bekor = [];
      if (!status) {
        bekor = await cancelMany(c, { filterSql: 'n.qabul_vaqti_id = $1', params: [q.id], izoh: 'Qabul vaqti bekor qilindi', actorId: actor.id });
      }
      await audit({ client: c, req, amal: status ? 'shablon.on' : 'shablon.off', obyekt: 'qabul_vaqti', obyektId: q.id, yangi: { bekor: bekor.length } });
      return bekor.length;
    });
  } catch (e) { throw await mapErr(e, q, q.id); }
}

/** O'chirish: navbat tarixi bo'lsa — faqat nofaol (FR-QV-06, BR-11) */
async function deleteShablon(actor, q, req) {
  if (!(await canManageXodim(actor, q.xodim_id, req))) throw forbidden();
  const { rows: [r] } = await db.query('SELECT EXISTS (SELECT 1 FROM navbatlar WHERE qabul_vaqti_id = $1) AS bor', [q.id]);
  if (r.bor) {
    const n = await setShablonStatus(actor, q, false, req);
    return { deleted: false, bekor: n };
  }
  await db.query('DELETE FROM qabul_vaqti WHERE id = $1', [q.id]);
  await audit({ req, amal: 'shablon.delete', obyekt: 'qabul_vaqti', obyektId: q.id, eski: q });
  return { deleted: true };
}

// ---- Istisnolar (M8) ----------------------------------------------------
function parseIstisno(body) {
  const errors = {};
  const d = {
    xodim_id: Number(body.xodim_id),
    dan: String(body.dan || ''),
    gacha: String(body.gacha || body.dan || ''),
    sabab: String(body.sabab || '').trim().slice(0, 255),
  };
  if (!isYmd(d.dan)) errors.dan = 'Sanani tanlang';
  if (!isYmd(d.gacha)) errors.gacha = 'Sanani tanlang';
  if (!errors.dan && !errors.gacha) {
    if (d.gacha < d.dan) errors.gacha = '"Gacha" sanasi "dan" dan oldin';
    else if (d.dan < today()) errors.dan = 'O\'tgan sanaga istisno kiritib bo\'lmaydi';          // FR-IST-04
    else if (addDays(d.dan, 92) < d.gacha) errors.gacha = 'Bir martada ko\'pi bilan 3 oy';
  }
  if (!d.sabab) errors.sabab = 'Sababni yozing';
  return { d, errors };
}

function sanalar(dan, gacha) {
  const out = [];
  for (let x = dan; x <= gacha; x = addDays(x, 1)) out.push(x);
  return out;
}

/** Oldindan ko'rish: nechta navbat bekor qilinadi (FR-IST-02) */
async function previewIstisno(actor, d, req) {
  if (!(await canManageXodim(actor, d.xodim_id, req))) throw forbidden();
  const days = sanalar(d.dan, d.gacha);
  const n = await countMany({ filterSql: 'q.xodim_id = $1 AND n.sana = ANY($2::date[])', params: [d.xodim_id, days] });
  const { rows } = await db.query(
    `SELECT n.sana, n.navbat_raqami, n.boshlanish, u.familiya, u.ism FROM navbatlar n
       JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id JOIN users u ON u.id = n.student_id
      WHERE q.xodim_id = $1 AND n.sana = ANY($2::date[]) AND n.status IN ('kutilmoqda','tasdiqlandi')
      ORDER BY n.sana, n.navbat_raqami LIMIT 50`, [d.xodim_id, days]);
  return { n, rows, days: days.length };
}

async function createIstisno(actor, d, req) {
  if (!(await canManageXodim(actor, d.xodim_id, req))) throw forbidden();
  const days = sanalar(d.dan, d.gacha);
  return db.tx(async (c) => {
    for (const s of days) {
      await c.query(
        `INSERT INTO qabul_istisno (xodim_id, sana, sabab) VALUES ($1, $2, $3)
         ON CONFLICT (xodim_id, sana) DO UPDATE SET sabab = EXCLUDED.sabab`, [d.xodim_id, s, d.sabab]);
    }
    const bekor = await cancelMany(c, {
      filterSql: 'q.xodim_id = $1 AND n.sana = ANY($2::date[])', params: [d.xodim_id, days],
      izoh: `Xodim qabul qilmaydi: ${d.sabab}`, actorId: actor.id,
    });
    await audit({ client: c, req, amal: 'istisno.create', obyekt: 'users', obyektId: d.xodim_id, yangi: { ...d, bekor: bekor.length } });
    return bekor.length;
  });
}

async function deleteIstisno(actor, id, req) {
  const { rows: [i] } = await db.query('SELECT * FROM qabul_istisno WHERE id = $1', [id]);
  if (!i) throw notFound();
  if (!(await canManageXodim(actor, i.xodim_id, req))) throw forbidden();
  if (i.sana < today()) throw new AppError('O\'tgan istisnoni o\'chirib bo\'lmaydi');
  await db.query('DELETE FROM qabul_istisno WHERE id = $1', [id]);
  await audit({ req, amal: 'istisno.delete', obyekt: 'users', obyektId: i.xodim_id, eski: i });
}

// ---- Bayramlar (T-08) -------------------------------------------------
async function addBayram(actor, { sana, nomi }, req) {
  if (!isYmd(sana)) throw new AppError('Sanani tanlang');
  if (sana < today()) throw new AppError('O\'tgan sanani kiritib bo\'lmaydi');
  nomi = String(nomi || '').trim().slice(0, 150);
  if (!nomi) throw new AppError('Bayram nomini yozing');
  return db.tx(async (c) => {
    await c.query('INSERT INTO bayramlar (sana, nomi) VALUES ($1, $2) ON CONFLICT (sana) DO UPDATE SET nomi = EXCLUDED.nomi', [sana, nomi]);
    const bekor = await cancelMany(c, { filterSql: 'n.sana = $1', params: [sana], izoh: `${fmtDate(sana)} — ${nomi} (dam olish kuni)`, actorId: actor.id });
    await audit({ client: c, req, amal: 'bayram.create', obyekt: 'bayramlar', yangi: { sana, nomi, bekor: bekor.length } });
    return bekor.length;
  });
}

module.exports = {
  managedXodimlar, xodimBolimlari, parseShablon, getShablon, futureActive, createShablon, updateShablon,
  setShablonStatus, deleteShablon, parseIstisno, previewIstisno, createIstisno, deleteIstisno, addBayram,
};
