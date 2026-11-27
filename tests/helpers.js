// Test muhiti: alohida test bazasi (TEST_DATABASE_URL), har fayl boshida toza sxema + demo ma'lumot
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5544/dekanat_test?host=/tmp';
process.env.DB_SSL = 'false';
process.env.SESSION_SECRET = 'test-secret-test-secret-test';
process.env.CRON_SECRET = 'test-cron';
process.env.ADMIN_LOGIN = 'admin';
process.env.ADMIN_PAROL = 'admin12345';

const request = require('supertest');
const { pool } = require('../src/db/pool');
const { migrate, ensureAdmin } = require('../src/db/migrate');
const { seed } = require('../src/db/seed');
const { createApp } = require('../src/app');
const { resetSettingsCache } = require('../src/lib/settings');

const quiet = { log: () => {} };

async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool, quiet);
  await ensureAdmin(pool, 'admin', 'admin12345', quiet);
  await pool.query('UPDATE users SET parol_almashtirish = FALSE');
  const log = console.log; console.log = () => {};
  try { await seed(); } finally { console.log = log; }
  resetSettingsCache();
}

const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

/** Kirgan foydalanuvchi agenti: agent.post(url, body) CSRF tokenni o'zi qo'shadi */
async function login(app, login, parol = 'parol123') {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfOf(page.text), login, parol });
  if (res.status !== 302) throw new Error(`Login ${login} muvaffaqiyatsiz: ${res.status}`);
  const home = await agent.get('/profil');
  agent.csrf = csrfOf(home.text);
  agent.form = (url, body = {}) => agent.post(url).type('form').send({ _csrf: agent.csrf, ...body });
  return agent;
}

async function userId(login) {
  return (await pool.query('SELECT id FROM users WHERE login = $1', [login])).rows[0].id;
}

module.exports = { request, pool, createApp, resetDb, login, csrfOf, userId };
