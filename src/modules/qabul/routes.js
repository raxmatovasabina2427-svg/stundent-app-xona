// M7–M8: qabul jadvali (shablonlar), istisnolar, haftalik jadval
const express = require('express');
const db = require('../../db/pool');
const { ah, flash, idParam, notFound, forbidden } = require('../../lib/http');
const { requireRole, canManageXodim, isStaff } = require('../../middleware/rbac');
const { userScope } = require('../../lib/scope');
const { today, sigim } = require('../../lib/time');
const opts = require('../../lib/options');
const svc = require('./service');

const router = express.Router();
const MANAGE_ROLES = ['admin', 'dekanat', 'teacher', 'tyutor', 'xodim'];
router.use(['/qabul', '/istisno'], requireRole(...MANAGE_ROLES));

const KUN_OPTS = [1, 2, 3, 4, 5, 6, 7];

/** ?xodim= paramidan (yoki o'zi) boshqariladigan xodimni aniqlash */
async function pickXodim(req) {
  const xodimlar = await svc.managedXodimlar(req.user, req);
  let id = req.query.xodim || req.body?.xodim_id;
  if (!id && isStaff(req.user)) id = req.user.id;
  id = id ? Number(id) : null;
  if (id && !(await canManageXodim(req.user, id, req))) throw forbidden();
  const xodim = id ? (await db.query('SELECT id, familiya, ism, role FROM users WHERE id = $1', [id])).rows[0] : null;
  return { xodimlar, xodim };
}

router.get('/qabul', ah(async (req, res) => {
  const { xodimlar, xodim } = await pickXodim(req);
  let shablonlar = [];
  if (xodim) {
    shablonlar = (await db.query(
      `SELECT q.*, b.nomi AS bolim,
              (SELECT count(*)::int FROM navbatlar n WHERE n.qabul_vaqti_id = q.id AND n.sana >= $2
                 AND n.status IN ('kutilmoqda','tasdiqlandi')) AS kelgusi
         FROM qabul_vaqti q JOIN bolimlar b ON b.id = q.bolim_id
        WHERE q.xodim_id = $1 ORDER BY q.status DESC, q.hafta_kuni, q.start_time`, [xodim.id, today()])).rows;
    for (const q of shablonlar) q.joylar = sigim(q);
  }
  res.render('qabul/list', { title: 'Qabul jadvali', xodimlar, xodim, shablonlar, isSelf: xodim?.id === req.user.id, canPick: xodimlar.length > 1 || !isStaff(req.user) });
}));

router.get('/qabul/new', ah(async (req, res) => {
  const { xodim } = await pickXodim(req);
  if (!xodim) return res.redirect('/qabul');
  const bolimlar = await svc.xodimBolimlari(xodim.id);
  res.render('qabul/form', {
    title: 'Yangi qabul vaqti', isNew: true, xodim, bolimlar, kunlar: KUN_OPTS,
    q: { bolim_id: bolimlar[0]?.id, hafta_kuni: 1, start_time: '09:00', end_time: '11:00', slot_min: 15, max_navbat: 8, rejim: 'slot' },
  });
}));

router.post('/qabul', ah(async (req, res) => {
  const { d, errors } = svc.parseShablon(req.body);
  const { xodim } = await pickXodim(req);
  if (!xodim) throw notFound('Xodim topilmadi');
  d.xodim_id = xodim.id;
  const again = async (errs) => res.status(400).render('qabul/form', {
    title: 'Yangi qabul vaqti', isNew: true, xodim, bolimlar: await svc.xodimBolimlari(xodim.id), kunlar: KUN_OPTS,
    q: { ...req.body, rejim: req.body.rejim }, errors: errs,
  });
  if (Object.keys(errors).length) return again(errors);
  try {
    await svc.createShablon(req.user, d, req);
  } catch (e) {
    if (e.expose && e.status === 400) return again({ _: e.message });
    throw e;
  }
  flash(req, 'ok', 'Qabul vaqti qo\'shildi');
  res.redirect(`/qabul?xodim=${xodim.id}`);
}));

async function loadShablon(req) {
  const q = await svc.getShablon(idParam(req.params.id));
  if (!q) throw notFound('Qabul vaqti topilmadi');
  if (!(await canManageXodim(req.user, q.xodim_id, req))) throw forbidden();
  return q;
}

router.get('/qabul/:id/edit', ah(async (req, res) => {
  const q = await loadShablon(req);
  res.render('qabul/form', {
    title: 'Qabul vaqtini tahrirlash', q: { ...q, rejim: q.slot_min ? 'slot' : 'jonli' },
    xodim: { id: q.xodim_id, familiya: q.familiya, ism: q.ism }, bolimlar: await svc.xodimBolimlari(q.xodim_id),
    kunlar: KUN_OPTS, kelgusi: await svc.futureActive(q.id),
  });
}));

router.post('/qabul/:id', ah(async (req, res) => {
  const old = await loadShablon(req);
  const { d, errors } = svc.parseShablon({ ...req.body, xodim_id: old.xodim_id });
  const again = async (errs) => res.status(400).render('qabul/form', {
    title: 'Qabul vaqtini tahrirlash', q: { ...req.body, id: old.id }, xodim: { id: old.xodim_id, familiya: old.familiya, ism: old.ism },
    bolimlar: await svc.xodimBolimlari(old.xodim_id), kunlar: KUN_OPTS, errors: errs, kelgusi: await svc.futureActive(old.id),
  });
  if (Object.keys(errors).length) return again(errors);
  try {
    await svc.updateShablon(req.user, old, d, req);
  } catch (e) {
    if (e.expose && e.status === 400) return again({ _: e.message });
    throw e;
  }
  flash(req, 'ok', 'Saqlandi');
  res.redirect(`/qabul?xodim=${old.xodim_id}`);
}));

router.post('/qabul/:id/holat', ah(async (req, res) => {
  const q = await loadShablon(req);
  const status = req.body.status === '1';
  if (!status) {
    const n = await svc.futureActive(q.id);
    if (n > 0 && req.body.confirm !== '1') {
      return res.render('qabul/confirm-off', { title: 'Tasdiqlash', q, n });
    }
  }
  try {
    const bekor = await svc.setShablonStatus(req.user, q, status, req);
    flash(req, 'ok', status ? 'Faollashtirildi' : `Nofaol qilindi${bekor ? `, ${bekor} ta navbat bekor qilindi` : ''}`);
  } catch (e) {
    if (!(e.expose && e.status === 400)) throw e;
    flash(req, 'err', e.message);
  }
  res.redirect(`/qabul?xodim=${q.xodim_id}`);
}));

router.post('/qabul/:id/delete', ah(async (req, res) => {
  const q = await loadShablon(req);
  const r = await svc.deleteShablon(req.user, q, req);
  flash(req, 'ok', r.deleted ? 'O\'chirildi' : `Bu qabul bo'yicha navbatlar tarixi bor — o'chirish o'rniga nofaol qilindi${r.bekor ? ` (${r.bekor} ta navbat bekor qilindi)` : ''}`);
  res.redirect(`/qabul?xodim=${q.xodim_id}`);
}));

// ---- Haftalik jadval (FR-QV-04, FR-QV-07) --------------------------------
router.get('/jadval', ah(async (req, res) => {
  const bolimlar = await opts.bolimTree({ onlyActive: true });
  let bolim = req.query.bolim ? Number(req.query.bolim) : null;
  const xodimId = req.query.xodim ? Number(req.query.xodim) : null;
  let ids = null;
  if (!bolim && !xodimId && req.user.role === 'dekanat') {
    ids = (await userScope(req.user, req)).bolimIds;   // dekanat — butun fakultet
  }
  const { rows } = await db.query(
    `SELECT q.*, u.familiya, u.ism, b.nomi AS bolim, b.xona FROM qabul_vaqti q
       JOIN users u ON u.id = q.xodim_id AND u.status JOIN bolimlar b ON b.id = q.bolim_id AND b.status
      WHERE q.status AND ($1::bigint IS NULL OR q.bolim_id = $1) AND ($2::bigint IS NULL OR q.xodim_id = $2)
        AND ($3::bigint[] IS NULL OR q.bolim_id = ANY($3))
      ORDER BY q.start_time, u.familiya`, [bolim, xodimId, ids]);
  const kunlar = KUN_OPTS.map((k) => ({ kun: k, items: rows.filter((r) => r.hafta_kuni === k) }));
  const xodim = xodimId ? (await db.query('SELECT id, familiya, ism FROM users WHERE id = $1', [xodimId])).rows[0] : null;
  res.render('qabul/jadval', { title: 'Haftalik qabul jadvali', kunlar, bolimlar, bolim, xodim, bosh: rows.length === 0, fakultet: !!ids });
}));

// ---- Istisnolar (M8) ---------------------------------------------------
router.get('/istisno', ah(async (req, res) => {
  const { xodimlar, xodim } = await pickXodim(req);
  const istisnolar = xodim
    ? (await db.query('SELECT * FROM qabul_istisno WHERE xodim_id = $1 AND sana >= $2 ORDER BY sana', [xodim.id, today()])).rows
    : [];
  res.render('qabul/istisno', { title: 'Qabul istisnolari', xodimlar, xodim, istisnolar, bugun: today(), canPick: xodimlar.length > 1 || !isStaff(req.user) });
}));

router.post('/istisno/preview', ah(async (req, res) => {
  const { xodim, xodimlar } = await pickXodim(req);
  if (!xodim) throw notFound('Xodim topilmadi');
  const { d, errors } = svc.parseIstisno({ ...req.body, xodim_id: xodim.id });
  if (Object.keys(errors).length) {
    const istisnolar = (await db.query('SELECT * FROM qabul_istisno WHERE xodim_id = $1 AND sana >= $2 ORDER BY sana', [xodim.id, today()])).rows;
    return res.status(400).render('qabul/istisno', { title: 'Qabul istisnolari', xodimlar, xodim, istisnolar, errors, form: req.body, bugun: today(), canPick: xodimlar.length > 1 });
  }
  const p = await svc.previewIstisno(req.user, d, req);
  res.render('qabul/istisno-confirm', { title: 'Istisnoni tasdiqlash', d, xodim, ...p });
}));

router.post('/istisno', ah(async (req, res) => {
  const { xodim } = await pickXodim(req);
  if (!xodim) throw notFound('Xodim topilmadi');
  const { d, errors } = svc.parseIstisno({ ...req.body, xodim_id: xodim.id });
  if (Object.keys(errors).length) { flash(req, 'err', Object.values(errors).join('. ')); return res.redirect(`/istisno?xodim=${xodim.id}`); }
  const bekor = await svc.createIstisno(req.user, d, req);
  flash(req, 'ok', `Istisno kiritildi${bekor ? `, ${bekor} ta navbat bekor qilindi va talabalarga xabar yuborildi` : ''}`);
  res.redirect(`/istisno?xodim=${xodim.id}`);
}));

router.post('/istisno/:id/delete', ah(async (req, res) => {
  await svc.deleteIstisno(req.user, idParam(req.params.id), req);
  flash(req, 'ok', 'Istisno o\'chirildi');
  res.redirect(`/istisno${req.body.xodim_id ? `?xodim=${Number(req.body.xodim_id)}` : ''}`);
}));

module.exports = router;
