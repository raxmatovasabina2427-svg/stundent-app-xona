'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// helpers env o'zgaruvchilarini o'rnatadi — plagin va db'dan oldin yuklanishi shart
const { pool, createApp, resetDb, login, userId } = require('../../../../tests/helpers');
const plugin = require('../index');
const { seed } = require('../seed');
const { today, addDays } = require('../../../lib/time');

let app;
const roomId = async (nomi) => (await pool.query('SELECT id FROM xona_bron_resurslar WHERE nomi = $1', [nomi])).rows[0].id;
const bookingOf = async (id) => (await pool.query('SELECT * FROM xona_bronlar WHERE id = $1', [id])).rows[0];

before(async () => {
  await resetDb();
  await seed({ log: () => {} });
  app = createApp();
});
after(() => pool.end());

test('manifest: name, router, nav', () => {
  assert.equal(plugin.name, 'xona_bron');
  assert.ok(plugin.router);
  assert.equal(plugin.nav[0].href, '/xona_bron');
});

test('migratsiya faqat plagin jadvallarini yaratadi', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_init.sql'), 'utf8');
  for (const t of ['xona_bron_resurslar', 'xona_bronlar', 'xona_bron_tarix', 'xona_bron_yopiq_vaqtlar']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
  }
  assert.doesNotMatch(sql, /\b(ALTER|DROP|TRUNCATE)\s+TABLE\s+(users|bolimlar)\b/i);
});

test('kirmagan foydalanuvchi /login ga yo\'naltiriladi', async () => {
  const { request } = require('../../../../tests/helpers');
  const r = await request(app).get('/xona_bron');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/login');
});

test('talaba xonalar ro\'yxati va xona sahifasini ko\'radi, menyuda havola bor', async () => {
  const a = await login(app, 'talaba1');
  const r = await a.get('/xona_bron');
  assert.equal(r.status, 200);
  assert.match(r.text, /Kompyuter xonasi 1/);
  assert.match(r.text, /href="\/xona_bron"/);
  const id = await roomId('Kompyuter xonasi 1');
  const d = await a.get(`/xona_bron/${id}`);
  assert.equal(d.status, 200);
  assert.match(d.text, /25 kishi/);
  assert.equal((await a.get('/xona_bron/yangi')).status, 200);
  assert.equal((await a.get('/xona_bron/mening')).status, 200);
  assert.equal((await a.get('/p/xona_bron/app.css')).status, 200);
});

test('talaba admin sahifalariga kira olmaydi (403)', async () => {
  const a = await login(app, 'talaba1');
  for (const p of ['/admin/xona_bron/resurslar', '/admin/xona_bron/resurslar/yangi', '/admin/xona_bron/bronlar', '/admin/xona_bron/yopiq-vaqtlar']) {
    assert.equal((await a.get(p)).status, 403, p);
  }
  const r = await a.form('/admin/xona_bron/resurslar/yangi', { nomi: 'Hack', turi: 'maruza', sigim: 5, ish_boshlanish: '08:00', ish_tugash: '09:00' });
  assert.equal(r.status, 403);
});

test('admin va dekanat boshqaruv sahifalarini ochadi', async () => {
  const admin = await login(app, 'admin', 'admin12345');
  const dekan = await login(app, 'dekan_at');
  for (const a of [admin, dekan]) {
    for (const p of ['/admin/xona_bron/resurslar', '/admin/xona_bron/resurslar/yangi', '/admin/xona_bron/bronlar', '/admin/xona_bron/yopiq-vaqtlar']) {
      const r = await a.get(p);
      assert.equal(r.status, 200, `${p}: ${r.text.slice(0, 200)}`);
    }
  }
});

test('bron oqimi: yaratish, to\'qnashuv, tasdiqlash, bekor qilish', async () => {
  const room = await roomId('Kompyuter xonasi 2');
  const sana = addDays(today(), 12);
  const t1 = await login(app, 'talaba1');
  const t2 = await login(app, 'talaba2');
  const admin = await login(app, 'admin', 'admin12345');

  const r1 = await t1.form('/xona_bron/yangi', { resurs_id: room, sana, boshlanish: '10:00', tugash: '11:00', odam_soni: 10, sabab: 'Dasturlash mashg\'uloti' });
  assert.equal(r1.status, 302);
  const { rows: [b] } = await pool.query('SELECT * FROM xona_bronlar WHERE resurs_id = $1 AND sana = $2', [room, sana]);
  assert.equal(b.status, 'kutilmoqda');
  assert.equal(b.user_id, await userId('talaba1'));

  // kesishuvchi vaqt
  const r2 = await t2.form('/xona_bron/yangi', { resurs_id: room, sana, boshlanish: '10:30', tugash: '11:30', odam_soni: 5, sabab: 'Boshqa mashg\'ulot' });
  assert.equal(r2.status, 400);
  assert.match(r2.text, /band/);
  // ketma-ket (chegarada) — mumkin
  const r3 = await t2.form('/xona_bron/yangi', { resurs_id: room, sana, boshlanish: '11:00', tugash: '12:00', odam_soni: 5, sabab: 'Ketma-ket mashg\'ulot' });
  assert.equal(r3.status, 302);

  // talaba tasdiqlay olmaydi
  assert.equal((await t1.form(`/admin/xona_bron/bronlar/${b.id}/tasdiq`)).status, 403);
  // admin rad etish — sababsiz xato
  assert.equal((await admin.form(`/admin/xona_bron/bronlar/${b.id}/rad`, { izoh: '' })).status, 400);
  // admin tasdiqlaydi
  assert.equal((await admin.form(`/admin/xona_bron/bronlar/${b.id}/tasdiq`)).status, 302);
  assert.equal((await bookingOf(b.id)).status, 'tasdiqlandi');
  const { rows: notif } = await pool.query('SELECT 1 FROM bildirishnomalar WHERE user_id = $1 AND matn LIKE $2', [b.user_id, '%tasdiqlandi%']);
  assert.equal(notif.length, 1);

  // boshqa talaba bronni ko'ra / bekor qila olmaydi
  assert.equal((await t2.get(`/xona_bron/bron/${b.id}`)).status, 403);
  assert.equal((await t2.form(`/xona_bron/bron/${b.id}/bekor`)).status, 403);
  // egasi ko'radi va bekor qiladi
  assert.equal((await t1.get(`/xona_bron/bron/${b.id}`)).status, 200);
  assert.equal((await t1.form(`/xona_bron/bron/${b.id}/bekor`)).status, 302);
  assert.equal((await bookingOf(b.id)).status, 'bekor_qilindi');
  // bekor qilingan vaqt yana bo'sh
  const r4 = await t2.form('/xona_bron/yangi', { resurs_id: room, sana, boshlanish: '10:00', tugash: '11:00', odam_soni: 5, sabab: 'Bo\'shagan vaqt' });
  assert.equal(r4.status, 302);
});

test('validatsiya xatolari (400)', async () => {
  const room = await roomId('Dasturlash laboratoriyasi'); // sig'im 15, 09:00-18:00
  const sana = addDays(today(), 20);
  const t = await login(app, 'talaba3');
  const ok = { resurs_id: room, sana, boshlanish: '10:00', tugash: '11:00', odam_soni: 5, sabab: 'Mashg\'ulot' };
  const bad = [
    { ...ok, odam_soni: 16 },                 // sig'imdan ko'p
    { ...ok, boshlanish: '12:00', tugash: '11:00' },
    { ...ok, boshlanish: '08:00', tugash: '09:30' },  // ish vaqtidan tashqari
    { ...ok, sana: addDays(today(), -1) },    // o'tgan sana
    { ...ok, sana: '2026-02-31' },            // mavjud bo'lmagan sana
    { ...ok, sabab: 'x' },
    { ...ok, resurs_id: 'abc' },
  ];
  for (const body of bad) {
    const r = await t.form('/xona_bron/yangi', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await pool.query('SELECT 1 FROM xona_bronlar WHERE resurs_id = $1', [room])).rowCount, 0);
});

test('dekanat faqat o\'z fakulteti xonalarini boshqaradi', async () => {
  const atRoom = await roomId('Kompyuter xonasi 1');
  const iqRoom = await roomId('Iqtisodiyot ma\'ruza xonasi');
  const sana = addDays(today(), 25);
  const t = await login(app, 'talaba1');
  await t.form('/xona_bron/yangi', { resurs_id: atRoom, sana, boshlanish: '14:00', tugash: '15:00', odam_soni: 5, sabab: 'Dars' });
  const { rows: [b] } = await pool.query('SELECT id FROM xona_bronlar WHERE resurs_id = $1 AND sana = $2', [atRoom, sana]);

  const iq = await login(app, 'dekan_iq');
  const at = await login(app, 'dekan_at');
  // IQ dekani AT xonasining so'rovini tasdiqlay olmaydi va xonani tahrirlay olmaydi
  assert.equal((await iq.form(`/admin/xona_bron/bronlar/${b.id}/tasdiq`)).status, 403);
  assert.equal((await iq.get(`/admin/xona_bron/resurslar/${atRoom}/tahrir`)).status, 403);
  assert.equal((await iq.get(`/xona_bron/bron/${b.id}`)).status, 403);
  // AT dekani IQ xonasini tahrirlay olmaydi, o'zinikini tasdiqlaydi
  assert.equal((await at.get(`/admin/xona_bron/resurslar/${iqRoom}/tahrir`)).status, 403);
  assert.equal((await at.form(`/admin/xona_bron/bronlar/${b.id}/tasdiq`)).status, 302);
  assert.equal((await bookingOf(b.id)).status, 'tasdiqlandi');
});

test('admin xona qo\'shadi, tahrirlaydi, yopiq vaqt belgilaydi', async () => {
  const admin = await login(app, 'admin', 'admin12345');
  const r = await admin.form('/admin/xona_bron/resurslar/yangi', { nomi: 'Test xonasi', turi: 'kompyuter', sigim: 12, ish_boshlanish: '08:00', ish_tugash: '17:00', masul_bolim_id: '' });
  assert.equal(r.status, 302);
  const id = await roomId('Test xonasi');
  // noto'g'ri tur
  const bad = await admin.form('/admin/xona_bron/resurslar/yangi', { nomi: 'Noto\'g\'ri', turi: 'zal', sigim: 12, ish_boshlanish: '08:00', ish_tugash: '17:00' });
  assert.equal(bad.status, 400);

  const sana = addDays(today(), 30);
  const c = await admin.form('/admin/xona_bron/yopiq-vaqtlar', { resurs_id: id, sana, boshlanish: '09:00', tugash: '12:00', sabab: 'Ta\'mirlash' });
  assert.equal(c.status, 302);
  const t = await login(app, 'talaba4');
  const blocked = await t.form('/xona_bron/yangi', { resurs_id: id, sana, boshlanish: '10:00', tugash: '11:00', odam_soni: 3, sabab: 'Mashg\'ulot' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.text, /yopiq/);

  // faolsizlantirilgan xona ro'yxatda ko'rinmaydi
  assert.equal((await admin.form(`/admin/xona_bron/resurslar/${id}/status`, { status: 'faol_emas' })).status, 302);
  const list = await t.get('/xona_bron');
  assert.doesNotMatch(list.text, /Test xonasi/);
  const { rows: au } = await pool.query("SELECT 1 FROM audit_log WHERE amal LIKE 'xona_bron.%'");
  assert.ok(au.length >= 3);
});
