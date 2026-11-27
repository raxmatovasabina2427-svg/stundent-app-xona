// M6: murojaat turlari (admin — hammasi, dekanat — fakultet bo'limlari)
const express = require('express');
const db = require('../../db/pool');
const { ah, flash, idParam, notFound, forbidden } = require('../../lib/http');
const { requireRole, canUseBolim } = require('../../middleware/rbac');
const { audit } = require('../../lib/audit');
const opts = require('../../lib/options');

const router = express.Router();
router.use('/admin/murojaat-turlari', requireRole('admin', 'dekanat'));

function parse(body) {
  const d = {
    bolim_id: Number(body.bolim_id),
    nomi: String(body.nomi || '').trim(),
    tavsif: String(body.tavsif || '').trim() || null,
    kerakli_hujjatlar: String(body.kerakli_hujjatlar || '').trim() || null,
    status: body.status === '1',
  };
  const errors = {};
  if (!Number.isSafeInteger(d.bolim_id) || d.bolim_id <= 0) errors.bolim_id = 'Bo\'limni tanlang';
  if (!d.nomi) errors.nomi = 'Nomini kiriting';
  else if (d.nomi.length > 200) errors.nomi = 'Juda uzun';
  if (d.tavsif && d.tavsif.length > 2000) errors.tavsif = 'Juda uzun';
  if (d.kerakli_hujjatlar && d.kerakli_hujjatlar.length > 2000) errors.kerakli_hujjatlar = 'Juda uzun';
  return { d, errors };
}

router.get('/admin/murojaat-turlari', ah(async (req, res) => {
  const bolimlar = await opts.managedBolimlar(req.user, req);
  const ids = bolimlar.map((b) => b.id);
  const bolim = req.query.bolim ? Number(req.query.bolim) : null;
  const { rows } = await db.query(
    `SELECT mt.*, b.nomi AS bolim,
            (SELECT count(*)::int FROM navbatlar n WHERE n.murojaat_turi_id = mt.id) AS ishlatilgan
       FROM murojaat_turlari mt JOIN bolimlar b ON b.id = mt.bolim_id
      WHERE mt.bolim_id = ANY($1::bigint[]) AND ($2::bigint IS NULL OR mt.bolim_id = $2)
      ORDER BY b.nomi, mt.nomi`, [ids, bolim]);
  res.render('murojaat/list', { title: 'Murojaat turlari', turlar: rows, bolimlar, bolim });
}));

router.get('/admin/murojaat-turlari/new', ah(async (req, res) => {
  res.render('murojaat/form', { title: 'Yangi murojaat turi', isNew: true, t: { status: true, bolim_id: req.query.bolim }, bolimlar: await opts.managedBolimlar(req.user, req) });
}));

router.get('/admin/murojaat-turlari/:id/edit', ah(async (req, res) => {
  const { rows: [t] } = await db.query('SELECT * FROM murojaat_turlari WHERE id = $1', [idParam(req.params.id)]);
  if (!t) throw notFound();
  if (!(await canUseBolim(req.user, t.bolim_id, req))) throw forbidden();
  res.render('murojaat/form', { title: 'Murojaat turini tahrirlash', t, bolimlar: await opts.managedBolimlar(req.user, req) });
}));

async function save(req, res, id) {
  const { d, errors } = parse(req.body);
  const again = async (errs) => res.status(400).render('murojaat/form', {
    title: id ? 'Murojaat turini tahrirlash' : 'Yangi murojaat turi', isNew: !id, t: { ...d, id }, errors: errs,
    bolimlar: await opts.managedBolimlar(req.user, req),
  });
  if (Object.keys(errors).length) return again(errors);
  if (!(await canUseBolim(req.user, d.bolim_id, req))) throw forbidden();
  try {
    if (id) {
      const { rows: [old] } = await db.query('SELECT * FROM murojaat_turlari WHERE id = $1', [id]);
      if (!old) throw notFound();
      if (!(await canUseBolim(req.user, old.bolim_id, req))) throw forbidden();
      await db.query('UPDATE murojaat_turlari SET bolim_id=$1, nomi=$2, tavsif=$3, kerakli_hujjatlar=$4, status=$5 WHERE id=$6',
        [d.bolim_id, d.nomi, d.tavsif, d.kerakli_hujjatlar, d.status, id]);
      await audit({ req, amal: 'murojaat_turi.update', obyekt: 'murojaat_turlari', obyektId: id, eski: old, yangi: d });
    } else {
      const { rows: [t] } = await db.query(
        'INSERT INTO murojaat_turlari (bolim_id, nomi, tavsif, kerakli_hujjatlar, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [d.bolim_id, d.nomi, d.tavsif, d.kerakli_hujjatlar, d.status]);
      await audit({ req, amal: 'murojaat_turi.create', obyekt: 'murojaat_turlari', obyektId: t.id, yangi: d });
    }
  } catch (e) {
    if (e.code === '23505') return again({ nomi: 'Bu bo\'limda bunday murojaat turi bor' });
    throw e;
  }
  flash(req, 'ok', 'Saqlandi');
  res.redirect(`/admin/murojaat-turlari?bolim=${d.bolim_id}`);
}

router.post('/admin/murojaat-turlari', ah((req, res) => save(req, res, null)));
router.post('/admin/murojaat-turlari/:id', ah((req, res) => save(req, res, idParam(req.params.id))));

router.post('/admin/murojaat-turlari/:id/delete', ah(async (req, res) => {
  const id = idParam(req.params.id);
  const { rows: [t] } = await db.query('SELECT * FROM murojaat_turlari WHERE id = $1', [id]);
  if (!t) throw notFound();
  if (!(await canUseBolim(req.user, t.bolim_id, req))) throw forbidden();
  try {
    await db.query('DELETE FROM murojaat_turlari WHERE id = $1', [id]);
    await audit({ req, amal: 'murojaat_turi.delete', obyekt: 'murojaat_turlari', obyektId: id, eski: t });
    flash(req, 'ok', 'O\'chirildi');
  } catch (e) {
    if (e.code !== '23503') throw e;
    // FR-MT-03: ishlatilgan turni o'chirib bo'lmaydi -> nofaol qilinadi
    await db.query('UPDATE murojaat_turlari SET status = FALSE WHERE id = $1', [id]);
    flash(req, 'ok', 'Bu tur navbatlarda ishlatilgan — o\'chirish o\'rniga nofaol qilindi');
  }
  res.redirect(`/admin/murojaat-turlari?bolim=${t.bolim_id}`);
}));

module.exports = router;
