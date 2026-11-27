// HTTP yordamchilari: async xatolarni ushlash, foydalanuvchiga tushunarli xatolar

/** Biznes-qoida xatosi — foydalanuvchiga matni ko'rsatiladi */
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const forbidden = (msg = 'Bu amal uchun ruxsatingiz yo\'q') => new AppError(msg, 403);
const notFound = (msg = 'Topilmadi') => new AppError(msg, 404);

/** Express 4 da async handler xatosini next() ga uzatish */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Flash xabar (sessiyada, keyingi sahifada bir marta ko'rsatiladi) */
function flash(req, type, text) {
  req.session.flash = { type, text };
}

/** Faqat ichki yo'llarga qaytish (K-16) */
function safeBack(req, fallback = '/') {
  const ref = req.get('Referer');
  if (!ref) return fallback;
  try {
    const u = new URL(ref, `http://${req.get('host')}`);
    if (u.host !== req.get('host')) return fallback;
    return u.pathname + u.search;
  } catch {
    return fallback;
  }
}

/** URL dan musbat butun ID */
function idParam(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw notFound();
  return n;
}

/** zod xatolarini { maydon: matn } ko'rinishiga */
function zodErrors(err) {
  const out = {};
  for (const i of err.issues) {
    const k = i.path.join('.') || '_';
    if (!out[k]) out[k] = i.message;
  }
  return out;
}

module.exports = { AppError, forbidden, notFound, ah, flash, safeBack, idParam, zodErrors };
