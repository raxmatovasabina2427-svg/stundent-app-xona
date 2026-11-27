// M4: bo'limlar daraxti (ko'rish — hamma, CRUD — admin)
const express = require('express');
const db = require('../../db/pool');
const { ah, flash, idParam, notFound } = require('../../lib/http');
const { requireRole } = require('../../middleware/rbac');
const { audit } = require('../../lib/audit');
const { subtree } = require('../../lib/scope');
const opts = require('../../lib/options');

const router = express.Router();
const TURLAR = ['fakultet', 'dekanat', 'kafedra', 'bolim', 'markaz'];

router.get('/bolimlar', ah(async (req, res) => {
  const onlyActive = !['admin', 'dekanat'].includes(req.user.role);
  res.render('bolimlar/tree', { title: 'Bo\'limlar', bolimlar: await opts.bolimTree({ onlyActive }) });
}));

router.get('/bolimlar/:id', ah(async (req, res) => {
  const id = idParam(req.params.id);
  const { rows: [b] } = await db.query(
    'SELECT b.*, p.nomi AS parent_nomi FROM bolimlar b LEFT JOIN bolimlar p ON p.id = b.parent_id WHERE b.id = $1', [id]);
  if (!b || (!b.status && !['admin', 'dekanat'].includes(req.user.role))) throw notFound('Bo\'lim topilmadi');
  const [{ rows: xodimlar }, { rows: turlar }, { rows: jadval }, { rows: bolalar }] = await Promise.all([
    db.query(`SELECT u.id, u.familiya, u.ism, u.ochestva, u.role, xb.lavozim, xb.asosiy
                FROM xodim_bolim xb JOIN users u ON u.id = xb.user_id
               WHERE xb.bolim_id = $1 AND u.status ORDER BY u.familiya, u.ism`, [id]),
    db.query('SELECT * FROM murojaat_turlari WHERE bolim_id = $1 AND status ORDER BY nomi', [id]),
    db.query(`SELECT q.*, u.familiya, u.ism FROM qabul_vaqti q JOIN users u ON u.id = q.xodim_id AND u.status
               WHERE q.bolim_id = $1 AND q.status ORDER BY q.hafta_kuni, q.start_time`, [id]),
    db.query('SELECT id, nomi, turi FROM bolimlar WHERE parent_id = $1 AND status ORDER BY nomi', [id]),
  ]);
  res.render('bolimlar/show', { title: b.nomi, b, xodimlar, turlar, jadval, bolalar, canBook: req.user.role === 'student' && b.status && jadval.length > 0 });
}));

// ---- admin CRUD ---------------------------------------------------------
router.use('/admin/bolimlar', requireRole('admin'));

function parse(body) {
  const errors = {};
  const d = {
    nomi: String(body.nomi || '').trim(),
    turi: String(body.turi || ''),
    parent_id: body.parent_id ? Number(body.parent_id) : null,
    xona: String(body.xona || '').trim() || null,
    status: body.status === '1',
  };
  if (!d.nomi) errors.nomi = 'Nomini kiriting';
  else if (d.nomi.length > 200) errors.nomi = 'Juda uzun';
  if (!TURLAR.includes(d.turi)) errors.turi = 'Turini tanlang';
  if (d.parent_id !== null && !(Number.isSafeInteger(d.parent_id) && d.parent_id > 0)) errors.parent_id = 'Noto\'g\'ri';
  if (d.xona && d.xona.length > 50) errors.xona = 'Juda uzun';
  return { d, errors };
}

function mapErr(e) {
  if (e.code === '23505') return 'Shu ota bo\'lim ichida bunday nomli bo\'lim bor';
  if (e.code === '23503') return 'Ota bo\'lim topilmadi';
  return null;
}

router.get('/admin/bolimlar/new', ah(async (req, res) => {
  res.render('bolimlar/form', { title: 'Yangi bo\'lim', isNew: true, b: { status: true, parent_id: req.query.parent || '' }, all: await opts.bolimTree(), turlar: TURLAR });
}));

router.post('/admin/bolimlar', ah(async (req, res) => {
  const { d, errors } = parse(req.body);
  const again = async (errs) => res.status(400).render('bolimlar/form', { title: 'Yangi bo\'lim', isNew: true, b: d, errors: errs, all: await opts.bolimTree(), turlar: TURLAR });
  if (Object.keys(errors).length) return again(errors);
  try {
    const { rows: [b] } = await db.query(
      'INSERT INTO bolimlar (nomi, turi, parent_id, xona, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [d.nomi, d.turi, d.parent_id, d.xona, d.status]);
    await audit({ req, amal: 'bolim.create', obyekt: 'bolimlar', obyektId: b.id, yangi: d });
    flash(req, 'ok', 'Bo\'lim yaratildi');
    res.redirect('/bolimlar');
  } catch (e) {
    const m = mapErr(e);
    if (m) return again({ _: m });
    throw e;
  }
}));

router.get('/admin/bolimlar/:id/edit', ah(async (req, res) => {
  const { rows: [b] } = await db.query('SELECT * FROM bolimlar WHERE id = $1', [idParam(req.params.id)]);
  if (!b) throw notFound();
  const avlod = await subtree(b.id);
  const all = (await opts.bolimTree()).filter((x) => !avlod.includes(x.id));   // sikl taqiqlangan (FR-BOL-03)
  res.render('bolimlar/form', { title: 'Bo\'limni tahrirlash', b, all, turlar: TURLAR });
}));

router.post('/admin/bolimlar/:id', ah(async (req, res) => {
  const id = idParam(req.params.id);
  const { rows: [old] } = await db.query('SELECT * FROM bolimlar WHERE id = $1', [id]);
  if (!old) throw notFound();
  const { d, errors } = parse(req.body);
  const avlod = await subtree(id);
  if (d.parent_id && avlod.includes(d.parent_id)) errors.parent_id = 'Bo\'limni o\'z avlodiga bo\'ysundirib bo\'lmaydi';
  const again = async (errs) => res.status(400).render('bolimlar/form', {
    title: 'Bo\'limni tahrirlash', b: { ...d, id }, errors: errs, all: (await opts.bolimTree()).filter((x) => !avlod.includes(x.id)), turlar: TURLAR,
  });
  if (Object.keys(errors).length) return again(errors);
  try {
    await db.query('UPDATE bolimlar SET nomi=$1, turi=$2, parent_id=$3, xona=$4, status=$5 WHERE id=$6',
      [d.nomi, d.turi, d.parent_id, d.xona, d.status, id]);
    await audit({ req, amal: 'bolim.update', obyekt: 'bolimlar', obyektId: id, eski: old, yangi: d });
    flash(req, 'ok', 'Saqlandi');
    res.redirect(`/bolimlar/${id}`);
  } catch (e) {
    const m = mapErr(e);
    if (m) return again({ _: m });
    throw e;
  }
}));

router.post('/admin/bolimlar/:id/delete', ah(async (req, res) => {
  const id = idParam(req.params.id);
  try {
    const { rows: [old] } = await db.query('DELETE FROM bolimlar WHERE id = $1 RETURNING *', [id]);
    if (!old) throw notFound();
    await audit({ req, amal: 'bolim.delete', obyekt: 'bolimlar', obyektId: id, eski: old });
    flash(req, 'ok', 'Bo\'lim o\'chirildi');
    res.redirect('/bolimlar');
  } catch (e) {
    if (e.code !== '23503') throw e;
    // FR-BOL-04: bog'liq yozuvlar bor — nofaol qilish taklif etiladi
    flash(req, 'err', 'Bo\'limda ichki bo\'limlar, xodimlar, guruhlar yoki qabul vaqtlari bor. O\'chirish o\'rniga "Nofaol" qiling.');
    res.redirect(`/admin/bolimlar/${id}/edit`);
  }
}));

module.exports = router;
