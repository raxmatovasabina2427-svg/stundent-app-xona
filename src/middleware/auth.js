// Autentifikatsiya: har so'rovda foydalanuvchi bazadan qayta yuklanadi (K-02)
const db = require('../db/pool');

async function loadUser(req, res, next) {
  const id = req.session?.userId;
  if (!id) return next();
  try {
    const { rows: [u] } = await db.query(
      `SELECT id, ism, familiya, ochestva, login, role, phone, status, parol_almashtirish
         FROM users WHERE id = $1`, [id]);
    if (!u || !u.status) {
      // Bloklangan yoki o'chirilgan — sessiya darhol tugaydi
      return req.session.destroy(() => {
        res.clearCookie('sid');
        if (req.headers['hx-request']) { res.set('HX-Redirect', '/login'); return res.status(401).end(); }
        res.redirect('/login');
      });
    }
    req.user = u;
    res.locals.me = u;
    next();
  } catch (e) {
    next(e);
  }
}

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.headers['hx-request']) { res.set('HX-Redirect', '/login'); return res.status(401).end(); }
    return res.redirect('/login');
  }
  // Vaqtinchalik parol bilan kirgan — avval parolni almashtirsin (FR-AUTH-09)
  if (req.user.parol_almashtirish && !['/profil/parol', '/logout'].includes(req.path)) {
    return res.redirect('/profil/parol');
  }
  next();
}

module.exports = { loadUser, requireLogin };
