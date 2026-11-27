// M16–M17: sozlamalar, bayramlar, audit jurnali (faqat admin)
const express = require('express');
const db = require('../../db/pool');
const { ah, flash } = require('../../lib/http');
const { requireRole } = require('../../middleware/rbac');
const { getSettings, saveSettings } = require('../../lib/settings');
const { today, isYmd } = require('../../lib/time');
const qabul = require('../qabul/service');

const router = express.Router();
router.use(['/admin/sozlamalar', '/admin/bayramlar', '/admin/audit'], requireRole('admin'));

const INT_KEYS = {
  yozilish_oynasi_kun: [1, 90], bugun_yopilish_daq: [0, 240], max_faol_bron: [1, 20],
  bekor_muddati_soat: [0, 72], kelmadi_chegara: [1, 20], kelmadi_davr_kun: [1, 365], kelmadi_taqiq_kun: [1, 90],
};

router.get('/admin/sozlamalar', ah(async (req, res) => {
  res.render('admin/sozlamalar', { title: 'Sozlamalar', s: await getSettings() });
}));

router.post('/admin/sozlamalar', ah(async (req, res) => {
  const values = {};
  const errors = [];
  for (const [k, [min, max]] of Object.entries(INT_KEYS)) {
    const v = Number(req.body[k]);
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${k}: ${min}–${max}`);
    else values[k] = v;
  }
  values.tasdiqlash_rejimi = req.body.tasdiqlash_rejimi === 'qolda' ? 'qolda' : 'avto';
  values.kelmadi_jazo = req.body.kelmadi_jazo === '1';
  if (errors.length) { flash(req, 'err', `Noto'g'ri qiymatlar — ${errors.join(', ')}`); return res.redirect('/admin/sozlamalar'); }
  const old = await getSettings();
  await saveSettings(values);
  const { audit } = require('../../lib/audit');
  await audit({ req, amal: 'sozlamalar.update', eski: old, yangi: values });
  flash(req, 'ok', 'Sozlamalar saqlandi');
  res.redirect('/admin/sozlamalar');
}));

router.get('/admin/bayramlar', ah(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM bayramlar WHERE sana >= $1::date - 30 ORDER BY sana', [today()]);
  res.render('admin/bayramlar', { title: 'Bayramlar va dam olish kunlari', bayramlar: rows, bugun: today() });
}));

router.post('/admin/bayramlar', ah(async (req, res) => {
  try {
    const n = await qabul.addBayram(req.user, req.body, req);
    flash(req, 'ok', `Saqlandi${n ? `, ${n} ta navbat bekor qilindi` : ''}`);
  } catch (e) {
    if (!e.expose) throw e;
    flash(req, 'err', e.message);
  }
  res.redirect('/admin/bayramlar');
}));

router.post('/admin/bayramlar/:sana/delete', ah(async (req, res) => {
  if (isYmd(req.params.sana)) await db.query('DELETE FROM bayramlar WHERE sana = $1', [req.params.sana]);
  flash(req, 'ok', 'O\'chirildi');
  res.redirect('/admin/bayramlar');
}));

router.get('/admin/audit', ah(async (req, res) => {
  const f = { amal: req.query.amal || '', user: req.query.user || '', obyekt: req.query.obyekt || '' };
  const where = [];
  const p = [];
  if (f.amal) { p.push(`${f.amal}%`); where.push(`a.amal LIKE $${p.length}`); }
  if (f.user) { p.push(`%${f.user}%`); where.push(`(u.login ILIKE $${p.length} OR u.familiya ILIKE $${p.length})`); }
  if (f.obyekt) { p.push(f.obyekt); where.push(`a.obyekt = $${p.length}`); }
  const page = Math.max(1, Number(req.query.page) || 1);
  const { rows } = await db.query(
    `SELECT a.*, u.login, u.familiya, u.ism FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT 100 OFFSET ${(page - 1) * 100}`, p);
  for (const r of rows) {
    r.qachon = new Date(r.created_at).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent' });
    r.tafsilot = JSON.stringify({ ...(r.eski ? { eski: r.eski } : {}), ...(r.yangi ? { yangi: r.yangi } : {}) });
    if (r.tafsilot === '{}') r.tafsilot = '';
  }
  res.render('admin/audit', { title: 'Audit jurnali', rows, f, page, next: rows.length === 100 ? page + 1 : null, prev: page > 1 ? page - 1 : null });
}));

module.exports = router;
