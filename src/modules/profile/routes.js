// M2: profil, parolni o'zgartirish, telefon
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db/pool');
const { ah, flash } = require('../../lib/http');
const { audit } = require('../../lib/audit');
const users = require('../users/service');

const router = express.Router();

router.get('/profil', ah(async (req, res) => {
  const profile = await users.profile(req.user.id);
  res.render('profile/show', { title: 'Profil', u: profile });
}));

router.get('/profil/parol', (req, res) => {
  res.render('profile/parol', { title: 'Parolni o\'zgartirish', majburiy: req.user.parol_almashtirish });
});

router.post('/profil/parol', ah(async (req, res) => {
  const { eski = '', yangi = '', yangi2 = '' } = req.body;
  const errors = {};
  const { rows: [u] } = await db.query('SELECT parol FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(eski, u.parol))) errors.eski = 'Joriy parol noto\'g\'ri';
  if (yangi.length < 8) errors.yangi = 'Yangi parol kamida 8 belgi bo\'lsin';
  else if (yangi.length > 72) errors.yangi = 'Parol juda uzun (ko\'pi bilan 72 belgi)';
  else if (yangi === eski) errors.yangi = 'Yangi parol eskisidan farq qilsin';
  if (yangi !== yangi2) errors.yangi2 = 'Parollar mos emas';
  if (Object.keys(errors).length) {
    return res.status(400).render('profile/parol', { title: 'Parolni o\'zgartirish', errors, majburiy: req.user.parol_almashtirish });
  }
  await db.query('UPDATE users SET parol = $1, parol_almashtirish = FALSE WHERE id = $2', [await bcrypt.hash(yangi, 10), req.user.id]);
  // Boshqa barcha sessiyalar yopiladi (FR-AUTH-08)
  await db.query(`DELETE FROM "session" WHERE (sess->>'userId')::bigint = $1 AND sid <> $2`, [req.user.id, req.sessionID]);
  await audit({ req, amal: 'user.parol', obyekt: 'users', obyektId: req.user.id });
  flash(req, 'ok', 'Parol o\'zgartirildi');
  res.redirect('/');
}));

router.post('/profil/telefon', ah(async (req, res) => {
  const phone = users.normalizePhone(req.body.phone);
  if (phone === false) {
    flash(req, 'err', 'Telefon formati: +998XXXXXXXXX');
  } else {
    await db.query('UPDATE users SET phone = $1 WHERE id = $2', [phone, req.user.id]);
    flash(req, 'ok', 'Telefon saqlandi');
  }
  res.redirect('/profil');
}));

module.exports = router;
