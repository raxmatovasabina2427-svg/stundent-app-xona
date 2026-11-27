// Guruhlar ma'lumotnomasi (T-07): guruh -> fakultet
const express = require('express');
const db = require('../../db/pool');
const { ah, flash, idParam, notFound, forbidden, AppError } = require('../../lib/http');
const { requireRole, canUseFakultet } = require('../../middleware/rbac');
const { audit } = require('../../lib/audit');
const opts = require('../../lib/options');

const router = express.Router();
router.use('/admin/guruhlar', requireRole('admin', 'dekanat'));

function parse(body) {
  const errors = {};
  const nomi = String(body.nomi || '').trim();
  const kurs = body.kurs ? Number(body.kurs) : null;
  const fakultet_id = Number(body.fakultet_id);
  if (!nomi) errors.nomi = 'Guruh nomini kiriting';
  else if (nomi.length > 30) errors.nomi = 'Ko\'pi bilan 30 belgi';
  if (kurs !== null && !(Number.isInteger(kurs) && kurs >= 1 && kurs <= 6)) errors.kurs = 'Kurs 1–6';
  if (!Number.isSafeInteger(fakultet_id) || fakultet_id <= 0) errors.fakultet_id = 'Fakultetni tanlang';
  return { data: { nomi, kurs, fakultet_id }, errors };
}

router.get('/admin/guruhlar', ah(async (req, res) => {
  const guruhlar = await opts.managedGuruhlar(req.user, req);
  const { rows: counts } = await db.query('SELECT guruh, count(*)::int AS n FROM student_info GROUP BY guruh');
  const m = Object.fromEntries(counts.map((r) => [r.guruh, r.n]));
  for (const g of guruhlar) g.talabalar = m[g.nomi] || 0;
  res.render('guruhlar/list', { title: 'Guruhlar', guruhlar, fakultetlar: await opts.fakultetlar(req.user, req) });
}));

router.post('/admin/guruhlar', ah(async (req, res) => {
  const { data, errors } = parse(req.body);
  if (Object.keys(errors).length) { flash(req, 'err', Object.values(errors).join('. ')); return res.redirect('/admin/guruhlar'); }
  if (!(await canUseFakultet(req.user, data.fakultet_id, req))) throw forbidden();
  const { rows: [f] } = await db.query("SELECT 1 FROM bolimlar WHERE id = $1 AND turi = 'fakultet'", [data.fakultet_id]);
  if (!f) throw new AppError('Fakultet topilmadi');
  try {
    const { rows: [g] } = await db.query('INSERT INTO guruhlar (nomi, kurs, fakultet_id) VALUES ($1, $2, $3) RETURNING id', [data.nomi, data.kurs, data.fakultet_id]);
    await audit({ req, amal: 'guruh.create', obyekt: 'guruhlar', obyektId: g.id, yangi: data });
    flash(req, 'ok', `${data.nomi} guruhi qo'shildi`);
  } catch (e) {
    if (e.code === '23505') flash(req, 'err', 'Bunday nomli guruh bor');
    else throw e;
  }
  res.redirect('/admin/guruhlar');
}));

router.post('/admin/guruhlar/:id', ah(async (req, res) => {
  const id = idParam(req.params.id);
  const { rows: [old] } = await db.query('SELECT * FROM guruhlar WHERE id = $1', [id]);
  if (!old) throw notFound();
  const { data, errors } = parse(req.body);
  if (Object.keys(errors).length) { flash(req, 'err', Object.values(errors).join('. ')); return res.redirect('/admin/guruhlar'); }
  if (!(await canUseFakultet(req.user, old.fakultet_id, req)) || !(await canUseFakultet(req.user, data.fakultet_id, req))) throw forbidden();
  try {
    // nomi o'zgarsa student_info/tyutor_guruh ON UPDATE CASCADE bilan yangilanadi
    await db.query('UPDATE guruhlar SET nomi = $1, kurs = $2, fakultet_id = $3 WHERE id = $4', [data.nomi, data.kurs, data.fakultet_id, id]);
    await audit({ req, amal: 'guruh.update', obyekt: 'guruhlar', obyektId: id, eski: old, yangi: data });
    flash(req, 'ok', 'Saqlandi');
  } catch (e) {
    if (e.code === '23505') flash(req, 'err', 'Bunday nomli guruh bor');
    else throw e;
  }
  res.redirect('/admin/guruhlar');
}));

router.post('/admin/guruhlar/:id/delete', ah(async (req, res) => {
  const id = idParam(req.params.id);
  const { rows: [old] } = await db.query('SELECT * FROM guruhlar WHERE id = $1', [id]);
  if (!old) throw notFound();
  if (!(await canUseFakultet(req.user, old.fakultet_id, req))) throw forbidden();
  try {
    await db.query('DELETE FROM guruhlar WHERE id = $1', [id]);
    await audit({ req, amal: 'guruh.delete', obyekt: 'guruhlar', obyektId: id, eski: old });
    flash(req, 'ok', 'O\'chirildi');
  } catch (e) {
    if (e.code === '23503') flash(req, 'err', 'Guruhda talabalar bor — o\'chirib bo\'lmaydi');
    else throw e;
  }
  res.redirect('/admin/guruhlar');
}));

module.exports = router;
