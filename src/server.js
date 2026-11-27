const env = require('./config/env');
const { createApp } = require('./app');
const { pool } = require('./db/pool');
const { migrate, ensureAdmin } = require('./db/migrate');

(async () => {
  // Migratsiyalar idempotent — start'da xavfsiz (Render'da shell yo'q)
  await migrate(pool);
  await ensureAdmin(pool, env.ADMIN_LOGIN, env.ADMIN_PAROL);

  const server = createApp().listen(env.PORT, () => {
    console.log(`Dekanat App: ${env.APP_URL} (port ${env.PORT}, ${env.NODE_ENV})`);
  });

  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch((e) => {
  console.error('Ishga tushmadi:', e.message);
  process.exit(1);
});
