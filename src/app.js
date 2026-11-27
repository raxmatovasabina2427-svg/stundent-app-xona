const path = require('node:path');
const express = require('express');
const { engine } = require('express-handlebars');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const { csrfSync } = require('csrf-sync');

const env = require('./config/env');
const { pool } = require('./db/pool');
const helpers = require('./lib/hbs');
const { loadUser, requireLogin } = require('./middleware/auth');
const { notFound } = require('./lib/http');
const { pluginLocals, mountPlugins } = require('./lib/plugins');

function createApp() {
  const app = express();

  app.set('trust proxy', 1);                       // Render HTTPS proksi ortida (K-05)
  app.disable('x-powered-by');

  app.engine('hbs', engine({
    extname: '.hbs',
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname, 'views/layouts'),
    partialsDir: path.join(__dirname, 'views/partials'),
    helpers,
  }));
  app.set('view engine', 'hbs');
  app.set('views', path.join(__dirname, 'views'));

  // Xavfsizlik sarlavhalari + CSP (K-07): inline skript/stil yo'q
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: env.isProd ? [] : null,
      },
    },
  }));

  app.use(express.static(path.join(__dirname, '../public'), { maxAge: env.isProd ? '7d' : 0 }));

  // Ochiq marshrutlar (sessiyasiz)
  app.get('/healthz', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false }); }
  });
  app.use('/internal/cron', express.json(), require('./modules/cron/routes'));

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  // Sessiya Postgres'da (K-03), rolling 8 soat (FR-AUTH-06)
  app.use(session({
    name: 'sid',
    store: new PgStore({ pool, tableName: 'session', pruneSessionInterval: env.NODE_ENV === 'test' ? false : 60 * 15 }),
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.isProd,
      maxAge: 8 * 60 * 60 * 1000,
    },
  }));

  // CSRF (K-04): har POST formada yashirin _csrf yoki htmx sarlavhasi
  const { csrfSynchronisedProtection, generateToken } = csrfSync({
    getTokenFromRequest: (req) => req.body?._csrf || req.headers['x-csrf-token'],
  });
  app.use((req, res, next) => {
    res.locals.csrfToken = generateToken(req);
    next();
  });
  app.use(csrfSynchronisedProtection);

  app.use(loadUser);
  app.use((req, res, next) => {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
    res.locals.path = req.path;
    next();
  });

  app.use(require('./modules/auth/routes'));

  // Shu yerdan pastda — faqat kirgan foydalanuvchilar
  app.use(requireLogin);
  app.use((req, res, next) => {
    const r = req.user.role;
    res.locals.nav = {
      admin: r === 'admin',
      manager: r === 'admin' || r === 'dekanat',
      staff: ['dekanat', 'teacher', 'tyutor', 'xodim'].includes(r),
      student: r === 'student',
      tyutor: r === 'tyutor',
    };
    next();
  });
  app.use(pluginLocals());                         // menyu: plagin havolalari

  app.use(require('./modules/home/routes'));
  app.use(require('./modules/profile/routes'));
  app.use(require('./modules/users/routes'));
  app.use(require('./modules/guruhlar/routes'));
  app.use(require('./modules/bolimlar/routes'));
  app.use(require('./modules/murojaat/routes'));
  app.use(require('./modules/qabul/routes'));
  app.use(require('./modules/navbat/routes'));
  app.use(require('./modules/tyutor/routes'));
  app.use(require('./modules/admin/routes'));
  mountPlugins(app);                               // src/plugins/*

  app.use((req, res, next) => next(notFound('Sahifa topilmadi')));

  // Xatolar: ichki ma'lumot foydalanuvchiga ko'rsatilmaydi
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.expose ? err.message : 'Serverda xatolik yuz berdi';
    if (err.code === 'EBADCSRFTOKEN' || err.message === 'invalid csrf token') {
      status = 403;
      message = 'Sahifa eskirgan. Sahifani yangilab, qaytadan urinib ko\'ring.';
    }
    if (status >= 500) console.error(err);
    if (req.headers['hx-request']) {
      res.set('HX-Reswap', 'none');
      return res.status(status).set('HX-Trigger', JSON.stringify({ toast: message })).send(message);
    }
    res.status(status).render('error', { status, message });
  });

  return app;
}

module.exports = { createApp };
