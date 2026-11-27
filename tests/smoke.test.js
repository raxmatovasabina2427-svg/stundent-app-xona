// Har rol uchun asosiy sahifalar xatosiz ochilishi
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, createApp, resetDb, login, userId } = require('./helpers');

let app;
before(async () => { await resetDb(); app = createApp(); });
after(() => pool.end());

const PAGES = {
  admin: ['/panel', '/admin/users', '/admin/users/new', '/admin/guruhlar', '/bolimlar', '/admin/bolimlar/new',
    '/admin/murojaat-turlari', '/admin/murojaat-turlari/new', '/qabul', '/jadval', '/istisno', '/xodim/navbatlar',
    '/admin/sozlamalar', '/admin/bayramlar', '/admin/audit', '/profil', '/profil/parol'],
  dekan_at: ['/panel', '/admin/users', '/admin/users?role=student&q=a', '/admin/guruhlar', '/qabul', '/qabul/new', '/jadval',
    '/istisno', '/xodim/bugun', '/xodim/navbatlar?hammasi=1', '/admin/murojaat-turlari', '/profil'],
  karimova: ['/xodim/bugun', '/xodim/navbatlar', '/qabul', '/qabul/new', '/istisno', '/jadval', '/bolimlar', '/profil'],
  tyutor_at: ['/tyutor', '/tyutor/guruh/AT-21-01', '/xodim/bugun', '/qabul'],
  registrator: ['/xodim/bugun', '/qabul', '/istisno'],
  talaba1: ['/talaba', '/navbat/yangi', '/navbatlarim', '/navbatlarim?tab=tarix', '/bolimlar', '/jadval', '/profil'],
};

for (const [who, pages] of Object.entries(PAGES)) {
  test(`${who}: sahifalar ochiladi`, async () => {
    const agent = await login(app, who, who === 'admin' ? 'admin12345' : 'parol123');
    for (const p of pages) {
      const r = await agent.get(p);
      assert.equal(r.status, 200, `${who} ${p} -> ${r.status}\n${r.text.slice(0, 400)}`);
    }
  });
}

test('admin: foydalanuvchi va bo\'lim sahifalari', async () => {
  const agent = await login(app, 'admin', 'admin12345');
  const id = await userId('karimova');
  for (const p of [`/admin/users/${id}`, `/admin/users/${id}/edit`, `/admin/users/${await userId('talaba1')}`]) {
    const r = await agent.get(p);
    assert.equal(r.status, 200, `${p}: ${r.text.slice(0, 300)}`);
  }
  const { rows } = await pool.query('SELECT id FROM bolimlar');
  for (const b of rows) {
    assert.equal((await agent.get(`/bolimlar/${b.id}`)).status, 200);
    assert.equal((await agent.get(`/admin/bolimlar/${b.id}/edit`)).status, 200);
  }
  const { rows: qv } = await pool.query('SELECT id FROM qabul_vaqti LIMIT 3');
  for (const q of qv) assert.equal((await agent.get(`/qabul/${q.id}/edit`)).status, 200);
});

test('talaba: yozilish ustasining barcha qadamlari ochiladi', async () => {
  const agent = await login(app, 'talaba1');
  const { rows: [b] } = await pool.query("SELECT id FROM bolimlar WHERE nomi = 'Registrator ofisi'");
  const { rows: [t] } = await pool.query('SELECT id FROM murojaat_turlari WHERE bolim_id = $1 LIMIT 1', [b.id]);
  const xid = await userId('registrator');
  let r = await agent.get(`/navbat/yangi?bolim=${b.id}`); assert.equal(r.status, 200); assert.match(r.text, /Murojaat turi/);
  r = await agent.get(`/navbat/yangi?bolim=${b.id}&tur=${t.id}`); assert.equal(r.status, 200); assert.match(r.text, /Kimga/);
  r = await agent.get(`/navbat/yangi?bolim=${b.id}&tur=${t.id}&xodim=${xid}`); assert.equal(r.status, 200); assert.match(r.text, /Sana/);
  const sana = r.text.match(/sana=(\d{4}-\d{2}-\d{2})/)[1];
  r = await agent.get(`/navbat/yangi?bolim=${b.id}&tur=${t.id}&xodim=${xid}&sana=${sana}`); assert.equal(r.status, 200);
  assert.match(r.text, /name="slot"/);
  r = await agent.get(`/navbat/slotlar?bolim=${b.id}&xodim=${xid}&sana=${sana}`);
  assert.equal(r.status, 200); assert.match(r.text, /slot-list/);
});

test('404 va kirmagan foydalanuvchi', async () => {
  const { request } = require('./helpers');
  const r = await request(app).get('/panel');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/login');
  const agent = await login(app, 'talaba1');
  assert.equal((await agent.get('/yoq-sahifa')).status, 404);
  assert.equal((await agent.get('/navbat/abc')).status, 404);
});
