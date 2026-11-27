// M1: kirish / chiqish
const express = require('express');
const bcrypt = require('bcryptjs');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../../db/pool');
const { ah } = require('../../lib/http');
const { audit } = require('../../lib/audit');

const router = express.Router();

// K-17: login topilmasa ham bcrypt bajariladi (javob vaqti bir xil)
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

// K-06 / FR-AUTH-03: IP + login bo'yicha 15 daqiqada 10 ta muvaffaqiyatsiz urinish
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.login || '').trim().toLowerCase()}`,
  handler: (req, res) => res.status(429).render('login', {
    layout: 'bare', login: req.body?.login,
    error: 'Juda ko\'p urinish. 15 daqiqadan keyin qayta urinib ko\'ring.',
  }),
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { layout: 'bare' });
});

router.post('/login', loginLimiter, ah(async (req, res) => {
  const login = String(req.body.login || '').trim();
  const parol = String(req.body.parol || '');
  const { rows: [u] } = await db.query(
    'SELECT id, parol, status FROM users WHERE lower(login) = lower($1)', [login]);
  const ok = await bcrypt.compare(parol, u ? u.parol : DUMMY_HASH);

  if (!u || !ok || !u.status) {
    await audit({ req, userId: u?.id ?? null, amal: 'login.fail', yangi: { login } });
    return res.status(401).render('login', { layout: 'bare', login, error: 'Login yoki parol noto\'g\'ri' });
  }

  // Session fixation'dan himoya
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('error', { status: 500, message: 'Sessiya xatosi' });
    req.session.userId = u.id;
    audit({ req, userId: u.id, amal: 'login' });
    req.session.save(() => res.redirect('/'));
  });
}));

router.post('/logout', (req, res) => {
  const uid = req.user?.id;
  req.session.destroy(() => {
    if (uid) audit({ req, userId: uid, amal: 'logout' });
    res.clearCookie('sid');
    res.redirect('/login');
  });
});

module.exports = router;
