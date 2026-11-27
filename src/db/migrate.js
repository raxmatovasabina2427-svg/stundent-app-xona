// Versiyalangan migratsiyalar (K-10): db/migrations/NNN_*.sql fayllari tartib bilan,
// har biri o'z tranzaksiyasida, schema_migrations jadvalida qayd qilinadi.
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { pluginMigrationFiles } = require('../lib/plugins');

const DIR = path.join(__dirname, 'migrations');

async function migrate(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    // Bir vaqtda ikki instans migratsiya qilmasligi uchun
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));

    // Avval asosiy migratsiyalar, keyin plaginlarniki (plagin jadvallari users/bolimlar'ga tayanadi)
    const files = [
      ...fs.readdirSync(DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()
        .map((f) => ({ version: f.replace(/\.sql$/, ''), file: path.join(DIR, f), label: f })),
      ...pluginMigrationFiles(),
    ];
    for (const { version, file: filePath, label: file } of files) {
      if (done.has(version)) continue;
      const sql = fs.readFileSync(filePath, 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        log(`✓ ${version}`);
      } catch (e) {
        await client.query('ROLLBACK');
        const line = e.position ? sql.slice(0, Number(e.position)).split('\n').length : null;
        throw new Error(`Migratsiya ${version} xato: ${e.message}`
          + (line ? `\n  joyi: ${file}, ${line}-qator` : '')
          + (e.where ? `\n  kontekst: ${e.where.split('\n')[0]}` : '')
          + (e.detail ? `\n  tafsilot: ${e.detail}` : ''));
      }
    }
    await client.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    client.release();
  }
}

/** Faol admin bo'lmasa, .env dagi ADMIN_LOGIN/ADMIN_PAROL bilan yaratadi. */
async function ensureAdmin(pool, login, parol, { log = console.log } = {}) {
  const { rows } = await pool.query("SELECT 1 FROM users WHERE role='admin' AND status LIMIT 1");
  if (rows.length) return false;
  if (!login || !parol) {
    log('! Faol admin yo\'q. ADMIN_LOGIN va ADMIN_PAROL ni .env ga yozib, qayta ishga tushiring.');
    return false;
  }
  if (parol.length < 8) throw new Error('ADMIN_PAROL kamida 8 belgi bo\'lsin');
  const hash = await bcrypt.hash(parol, 10);
  await pool.query(
    `INSERT INTO users (ism, familiya, login, parol, role, parol_almashtirish)
     VALUES ('Admin', 'Tizim', $1, $2, 'admin', TRUE)`,
    [login.trim(), hash],
  );
  log(`✓ Admin yaratildi: ${login} (birinchi kirishda parolni almashtiring, keyin ADMIN_PAROL ni .env dan o'chiring)`);
  return true;
}

module.exports = { migrate, ensureAdmin };

if (require.main === module) {
  const env = require('../config/env');
  const { pool } = require('./pool');
  (async () => {
    try {
      await migrate(pool);
      await ensureAdmin(pool, env.ADMIN_LOGIN, env.ADMIN_PAROL);
      console.log('Migratsiya tugadi.');
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
