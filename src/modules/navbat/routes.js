// M9–M11: navbatga yozilish (talaba), mening navbatlarim, xodim paneli
const express = require('express');
const db = require('../../db/pool');
const { ah, flash, idParam, notFound, forbidden, AppError } = require('../../lib/http');
const { requireRole, navbatAccess, isStaff, canManageXodim } = require('../../middleware/rbac');
const { userScope, subtree } = require('../../lib/scope');
const { today, addDays, isYmd, isoDow, KUN_QISQA } = require('../../lib/time');
const { getSettings } = require('../../lib/settings');
const { daySlots, availability } = require('./slots');
const { bandQilish } = require('./booking');
const st = require('./status');

const router = express.Router();
const STAFF = ['dekanat', 'teacher', 'tyutor', 'xodim'];

// ============ Talaba: yozilish ustasi (M9) ===============================

/** Navbatga yozish mumkin bo'lgan bo'limlar (faol shablonlari bor) */
async function bookableBolimlar(student) {
  const { rows } = await db.query(
    `SELECT b.id, b.nomi, b.turi, b.xona, p.nomi AS parent, count(DISTINCT q.xodim_id)::int AS xodimlar
       FROM bolimlar b
       JOIN qabul_vaqti q ON q.bolim_id = b.id AND q.status
       JOIN users u ON u.id = q.xodim_id AND u.status
       LEFT JOIN bolimlar p ON p.id = b.parent_id
      WHERE b.status
      GROUP BY b.id, p.nomi ORDER BY b.nomi`);
  // O'z fakulteti bo'limlari (avval dekanat) yuqorida
  const { rows: [g] } = await db.query(
    'SELECT g.fakultet_id FROM student_info s JOIN guruhlar g ON g.nomi = s.guruh WHERE s.user_id = $1', [student.id]);
  const mine = g ? new Set(await subtree(g.fakultet_id)) : new Set();
  const rank = (b) => (mine.has(b.id) ? (b.turi === 'dekanat' ? 0 : 1) : 2);
  return rows.map((b) => ({ ...b, meniki: mine.has(b.id) })).sort((a, b) => rank(a) - rank(b) || a.nomi.localeCompare(b.nomi));
}

async function wizardState(req) {
  const q = req.query;
  const state = { step: 1 };
  const bolimId = q.bolim ? Number(q.bolim) : null;
  if (!bolimId) return state;
  const { rows: [bolim] } = await db.query('SELECT * FROM bolimlar WHERE id = $1 AND status', [bolimId]);
  if (!bolim) throw notFound('Bo\'lim topilmadi');
  Object.assign(state, { bolim, step: 2 });

  const turId = q.tur ? Number(q.tur) : null;
  if (!turId) return state;
  const { rows: [tur] } = await db.query('SELECT * FROM murojaat_turlari WHERE id = $1 AND bolim_id = $2 AND status', [turId, bolimId]);
  if (!tur) throw notFound('Murojaat turi topilmadi');
  Object.assign(state, { tur, step: 3 });

  if (q.xodim === undefined || q.xodim === '') return state;
  const xodimId = Number(q.xodim) || null;   // 0 = "Farqi yo'q"
  let xodim = null;
  if (xodimId) {
    ({ rows: [xodim] } = await db.query(
      `SELECT u.id, u.familiya, u.ism, u.ochestva, xb.lavozim FROM users u
         JOIN xodim_bolim xb ON xb.user_id = u.id AND xb.bolim_id = $2 WHERE u.id = $1 AND u.status`, [xodimId, bolimId]));
    if (!xodim) throw notFound('Xodim topilmadi');
  }
  Object.assign(state, { xodim, xodimId: xodimId || 0, step: 4 });

  if (!q.sana) return state;
  if (!isYmd(q.sana)) throw notFound('Sana noto\'g\'ri');
  Object.assign(state, { sana: q.sana, step: 5 });
  return state;
}

router.get('/navbat/yangi', requireRole('student'), ah(async (req, res) => {
  const s = await wizardState(req);
  const view = { title: 'Navbatga yozilish', s, steps: [1, 2, 3, 4, 5].map((n) => ({ n, done: n < s.step, active: n === s.step })) };
  if (s.step === 1) {
    const all = await bookableBolimlar(req.user);
    const q = String(req.query.q || '').trim().toLowerCase();
    view.bolimlar = q ? all.filter((b) => b.nomi.toLowerCase().includes(q)) : all;
    view.q = req.query.q;
  } else if (s.step === 2) {
    view.turlar = (await db.query('SELECT * FROM murojaat_turlari WHERE bolim_id = $1 AND status ORDER BY nomi', [s.bolim.id])).rows;
  } else if (s.step === 3) {
    view.xodimlar = (await db.query(
      `SELECT u.id, u.familiya, u.ism, u.ochestva, xb.lavozim,
              string_agg(DISTINCT q.hafta_kuni::text, ',' ORDER BY q.hafta_kuni::text) AS kunlar
         FROM qabul_vaqti q JOIN users u ON u.id = q.xodim_id AND u.status
         JOIN xodim_bolim xb ON xb.user_id = u.id AND xb.bolim_id = q.bolim_id
        WHERE q.bolim_id = $1 AND q.status GROUP BY u.id, xb.lavozim ORDER BY u.familiya`, [s.bolim.id])).rows
      .map((x) => ({ ...x, kunlar: x.kunlar.split(',').map(Number) }));
  } else if (s.step === 4) {
    view.kunlar = (await availability({ bolimId: s.bolim.id, xodimId: s.xodimId || null }))
      .map((d) => ({ ...d, hafta: KUN_QISQA[isoDow(d.sana)] }));
  } else {
    view.groups = await daySlots({ bolimId: s.bolim.id, xodimId: s.xodimId || null, sana: s.sana });
    view.hech = !view.groups.some((g) => g.bosh > 0);
  }
  res.render('navbat/yangi', view);
}));

// htmx fragment: bo'sh slotlar (FR-NAV-01)
router.get('/navbat/slotlar', ah(async (req, res) => {
  const bolimId = Number(req.query.bolim) || null;
  const xodimId = Number(req.query.xodim) || null;
  const sana = String(req.query.sana || '');
  if (!isYmd(sana) || (!bolimId && !xodimId)) throw new AppError('bolim/xodim va sana kerak');
  const groups = await daySlots({ bolimId, xodimId, sana });
  res.render('partials/slots', { layout: false, groups, sana, hech: !groups.some((g) => g.bosh > 0) });
}));

router.post('/navbat', requireRole('student'), ah(async (req, res) => {
  const b = req.body;
  const params = { bolim: b.bolim, tur: b.tur, xodim: b.xodim || '0', sana: b.sana };
  const back = `/navbat/yangi?${new URLSearchParams(params)}`;
  const [qvId, raqam] = String(b.slot || '').split(':').map(Number);
  if (!qvId) { flash(req, 'err', 'Vaqtni tanlang'); return res.redirect(back); }
  try {
    const nav = await bandQilish({
      studentId: req.user.id, qabulVaqtiId: qvId, sana: b.sana,
      navbatRaqami: Number.isInteger(raqam) && raqam > 0 ? raqam : null,
      murojaatTuriId: Number(b.tur), mavzu: String(b.mavzu || '').trim() || null, req,
    });
    flash(req, 'ok', 'Navbatga yozildingiz!');
    res.redirect(`/navbat/${nav.id}`);
  } catch (e) {
    if (!e.expose) throw e;
    flash(req, 'err', e.message);       // FR-NAV-04: slotlar yangilangan holda qaytadi
    res.redirect(back);
  }
}));

// ============ Mening navbatlarim (M10) =====================================
router.get('/navbatlarim', requireRole('student'), ah(async (req, res) => {
  const tab = req.query.tab === 'tarix' ? 'tarix' : 'kelgusi';
  const bugun = today();
  const { rows } = await db.query(
    `${st.NAV_SQL.replace('SELECT n.*,', 'SELECT n.*, mt.nomi AS murojaat,')}
       LEFT JOIN murojaat_turlari mt ON mt.id = n.murojaat_turi_id
      WHERE n.student_id = $1 AND ${tab === 'kelgusi'
        ? "n.sana >= $2 AND n.status IN ('kutilmoqda','tasdiqlandi')"
        : "(n.sana < $2 OR n.status NOT IN ('kutilmoqda','tasdiqlandi'))"}
      ORDER BY n.sana ${tab === 'kelgusi' ? 'ASC' : 'DESC'}, n.boshlanish NULLS LAST, n.navbat_raqami
      LIMIT 100`, [req.user.id, bugun]);
  res.render('navbat/mening', { title: 'Mening navbatlarim', rows, tab });
}));

router.get('/navbat/:id', ah(async (req, res) => {
  const n = await st.load(idParam(req.params.id));
  if (!n) throw notFound('Navbat topilmadi');
  if (!(await navbatAccess(req.user, n, 'view', req))) throw forbidden();
  const [{ rows: [extra] }, { rows: tarix }, s] = await Promise.all([
    db.query(`SELECT mt.nomi AS murojaat, mt.kerakli_hujjatlar, u.familiya, u.ism, u.ochestva, u.phone, si.kurs
                FROM navbatlar n LEFT JOIN murojaat_turlari mt ON mt.id = n.murojaat_turi_id
                JOIN users u ON u.id = n.student_id LEFT JOIN student_info si ON si.user_id = u.id WHERE n.id = $1`, [n.id]),
    db.query(`SELECT t.*, u.familiya, u.ism FROM navbat_tarix t LEFT JOIN users u ON u.id = t.user_id
               WHERE t.navbat_id = $1 ORDER BY t.created_at`, [n.id]),
    getSettings(),
  ]);
  const isOwner = n.student_id === req.user.id;
  const canManage = req.user.role !== 'student' && await navbatAccess(req.user, n, 'manage', req);
  res.render('navbat/show', {
    title: `Navbat №${n.navbat_raqami}`, n: { ...n, ...extra }, tarix, isOwner, canManage,
    canCancel: isOwner && ['kutilmoqda', 'tasdiqlandi'].includes(n.status) && n.sana >= today(),
    bekorSoat: s.bekor_muddati_soat, actions: canManage ? actionsFor(n) : [],
  });
}));

router.post('/navbat/:id/bekor', requireRole('student'), ah(async (req, res) => {
  const id = idParam(req.params.id);
  try {
    await st.cancelByStudent({ student: req.user, navbatId: id, sabab: req.body.sabab, req });
    flash(req, 'ok', 'Navbat bekor qilindi');
  } catch (e) {
    if (!e.expose) throw e;
    flash(req, 'err', e.message);
  }
  res.redirect(`/navbat/${id}`);
}));

// ============ Xodim paneli (M11) ============================================

/** Xodim uchun mumkin bo'lgan amallar (UI tugmalari) */
function actionsFor(n) {
  const a = [];
  const next = st.TRANSITIONS[n.status] || [];
  const bugun = today();
  if (next.includes('tasdiqlandi') && n.sana >= bugun) a.push({ to: 'tasdiqlandi', label: 'Tasdiqlash', cls: 'btn-blue' });
  if (next.includes('qabul_qilindi') && n.sana <= bugun) a.push({ to: 'qabul_qilindi', label: 'Qabul qilindi', cls: 'btn-green' });
  if (next.includes('kelmadi') && st.started(n)) a.push({ to: 'kelmadi', label: 'Kelmadi', cls: 'btn-gray' });
  if (next.includes('rad_etildi')) a.push({ to: 'rad_etildi', label: 'Rad etish', cls: 'btn-red', izoh: true });
  if (next.includes('bekor_qilindi')) a.push({ to: 'bekor_qilindi', label: 'Bekor qilish', cls: 'btn-red', izoh: true });
  return a;
}

const LIST_SQL = `
  SELECT n.*, q.xodim_id, q.bolim_id, q.start_time, q.end_time, q.slot_min,
         s.familiya, s.ism, s.ochestva, s.phone, si.guruh, si.kurs, mt.nomi AS murojaat,
         b.nomi AS bolim, x.familiya AS x_familiya, x.ism AS x_ism
    FROM navbatlar n
    JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id
    JOIN bolimlar b ON b.id = q.bolim_id
    JOIN users s ON s.id = n.student_id
    JOIN users x ON x.id = q.xodim_id
    LEFT JOIN student_info si ON si.user_id = s.id
    LEFT JOIN murojaat_turlari mt ON mt.id = n.murojaat_turi_id`;

const withActions = (rows) => rows.map((r) => ({ ...r, actions: actionsFor(r) }));

router.get('/xodim/bugun', requireRole(...STAFF), ah(async (req, res) => {
  const bugun = today();
  const { rows } = await db.query(
    `${LIST_SQL} WHERE q.xodim_id = $1 AND n.sana = $2 AND n.status <> 'bekor_qilindi'
      ORDER BY q.start_time, n.navbat_raqami`, [req.user.id, bugun]);
  const stat = { jami: rows.length, qabul: 0, kelmadi: 0, kutilmoqda: 0, rad: 0 };
  for (const r of rows) {
    if (r.status === 'qabul_qilindi') stat.qabul++;
    else if (r.status === 'kelmadi') stat.kelmadi++;
    else if (r.status === 'rad_etildi') stat.rad++;
    else stat.kutilmoqda++;
  }
  // FR-XP-03: navbatdagi birinchi kutayotgan talaba
  const keyingi = rows.find((r) => ['kutilmoqda', 'tasdiqlandi'].includes(r.status)) || null;
  res.render('xodim/bugun', { title: 'Bugungi navbat', rows: withActions(rows), stat, keyingi, bugun });
}));

router.get('/xodim/navbatlar', requireRole('admin', ...STAFF), ah(async (req, res) => {
  const bugun = today();
  const f = {
    dan: isYmd(req.query.dan) ? req.query.dan : bugun,
    gacha: isYmd(req.query.gacha) ? req.query.gacha : addDays(bugun, 14),
    status: req.query.status || '',
    xodim: req.query.xodim || '',
    hammasi: req.query.hammasi === '1',
  };
  const where = ['n.sana BETWEEN $1 AND $2'];
  const p = [f.dan, f.gacha];
  const manager = ['admin', 'dekanat'].includes(req.user.role);
  if (f.xodim) {
    if (!(await canManageXodim(req.user, Number(f.xodim), req))) throw forbidden();
    p.push(Number(f.xodim)); where.push(`q.xodim_id = $${p.length}`);
  } else if (manager && (f.hammasi || req.user.role === 'admin')) {
    if (req.user.role === 'dekanat') { p.push((await userScope(req.user, req)).bolimIds); where.push(`q.bolim_id = ANY($${p.length}::bigint[])`); }
  } else {
    p.push(req.user.id); where.push(`q.xodim_id = $${p.length}`);
  }
  if (f.status) { p.push(f.status); where.push(`n.status = $${p.length}`); }
  const { rows } = await db.query(`${LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY n.sana, q.start_time, n.navbat_raqami LIMIT 500`, p);
  const xodimlar = manager ? await require('../qabul/service').managedXodimlar(req.user, req) : [];
  res.render('xodim/navbatlar', { title: 'Navbatlar', rows: withActions(rows), f, manager, xodimlar, isStaffUser: isStaff(req.user), ozgarish: rows.length });
}));

/** Holat o'zgartirish — htmx bo'lsa qator qayta chiziladi (FR-XP-02) */
router.post('/navbat/:id/holat', requireRole('admin', ...STAFF), ah(async (req, res) => {
  const id = idParam(req.params.id);
  const yangi = String(req.body.status || '');
  if (!Object.hasOwn(st.TRANSITIONS, yangi)) throw new AppError('Holat noto\'g\'ri');
  await st.changeStatus({ actor: req.user, navbatId: id, yangi, izoh: req.body.izoh, req });
  if (req.headers['hx-request']) return renderRow(req, res, id);
  flash(req, 'ok', 'Holat o\'zgartirildi');
  res.redirect(req.body.back && String(req.body.back).startsWith('/') && !String(req.body.back).startsWith('//') ? req.body.back : `/navbat/${id}`);
}));

router.post('/navbat/:id/javob', requireRole('admin', ...STAFF), ah(async (req, res) => {
  const id = idParam(req.params.id);
  await st.setJavob({ actor: req.user, navbatId: id, javob: req.body.javob, req });
  if (req.headers['hx-request']) return renderRow(req, res, id);
  flash(req, 'ok', 'Javob saqlandi');
  res.redirect(`/navbat/${id}`);
}));

async function renderRow(req, res, id) {
  const { rows: [r] } = await db.query(`${LIST_SQL} WHERE n.id = $1`, [id]);
  res.set('HX-Trigger', JSON.stringify({ toast: 'Saqlandi', statsChanged: true }));
  res.render('partials/navbat-row', { layout: false, ...withActions([r])[0], csrfToken: res.locals.csrfToken, showSana: req.body.showSana === '1' });
}

module.exports = router;
