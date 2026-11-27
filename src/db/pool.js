const { Pool, types } = require('pg');
const env = require('../config/env');

// bigint -> Number (ID va Telegram ID lar 2^53 dan kichik)
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// date -> 'YYYY-MM-DD' satr (vaqt zonasi siljishining oldini oladi)
types.setTypeParser(1082, (v) => v);
// time -> 'HH:MM' (soniyalarsiz)
types.setTypeParser(1083, (v) => (v === null ? null : v.slice(0, 5)));

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : false,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  // Barcha "bugun"/"hozir" hisoblari Toshkent vaqtida (BR-14)
  options: `-c TimeZone=${env.TZ}`,
});

pool.on('error', (err) => console.error('pg pool xatosi:', err.message));

const query = (text, params) => pool.query(text, params);

/** Tranzaksiya yordamchisi: fn(client) xato bersa ROLLBACK. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
