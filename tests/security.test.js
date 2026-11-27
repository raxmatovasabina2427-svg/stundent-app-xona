// Faza 1: xavfsizlik va RBAC (TC-01…TC-08, TC-25/26, K-01…K-17)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { request, pool, createApp, resetDb, login, csrfOf, userId } = require('./helpers');

let app;
before(async () => { await resetDb(); app = createApp(); });
after(() => pool.end());

const userForm = (u, extra = {}) => ({
  familiya: u.familiya, ism: u.ism, ochestva: u.ochestva || '', login: u.login, phone: u.phone || '', role: u.role, ...extra,
});

test('TC-01 (K-01): dekanat o\'ziga admin rolini bera olmaydi, admin yarata olmaydi', async () => {
  const dek = await login(app, 'dekan_at');
  const id = await userId('dekan_at');
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  const r = await dek.form(`/admin/users/${id}`, userForm(u, { role: 'admin', lavozim: 'Dekan' }));
  assert.equal(r.status, 403);
  assert.equal((await pool.query('SELECT role FROM users WHERE id = $1', [id])).rows[0].role, 'dekanat');

  const r2 = await dek.form('/admin/users', { familiya: 'X', ism: 'Y', login: 'hacker', parol: 'parol12345', role: 'admin' });
  assert.equal(r2.status, 403);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE login = 'hacker'")).rows[0].n, 0);
});

test('TC-02: dekanat adminni o\'chira/bloklay olmaydi', async () => {
  const dek = await login(app, 'dekan_at');
  const adminId = await userId('admin');
  assert.equal((await dek.form(`/admin/users/${adminId}/delete`)).status, 403);
  assert.equal((await dek.form(`/admin/users/${adminId}/status`)).status, 403);
  assert.equal((await dek.get(`/admin/users/${adminId}/edit`)).status, 403);
  const { rows: [a] } = await pool.query('SELECT status FROM users WHERE id = $1', [adminId]);
  assert.equal(a.status, true);
});

test('TC-26: dekanat boshqa fakultet talabasini ko\'ra/tahrirlay olmaydi', async () => {
  const dek = await login(app, 'dekan_at');
  const t5 = await userId('talaba5');        // Iqtisodiyot fakulteti
  assert.equal((await dek.get(`/admin/users/${t5}/edit`)).status, 403);
  assert.equal((await dek.form(`/admin/users/${t5}/status`)).status, 403);
  const list = await dek.get('/admin/users?role=student');
  assert.doesNotMatch(list.text, /Nazarov/);
  assert.match(list.text, /Abdullayev/);
  // Boshqa fakultet guruhiga talaba yaratish
  const r = await dek.form('/admin/users', { familiya: 'A', ism: 'B', login: 'yangi_iq', parol: 'parol12345', role: 'student', guruh: 'IQ-21-01', kurs: '3' });
  assert.equal(r.status, 403);
});

test('K-11: o\'zini bloklash taqiqlangan; oxirgi admin himoyalangan', async () => {
  const dek = await login(app, 'dekan_at');
  assert.equal((await dek.form(`/admin/users/${await userId('dekan_at')}/status`)).status, 403);
  const adm = await login(app, 'admin', 'admin12345');
  assert.equal((await adm.form(`/admin/users/${await userId('admin')}/status`)).status, 403);
  assert.equal((await adm.form(`/admin/users/${await userId('admin')}/delete`)).status, 403);
});

test('TC-03 (K-02): bloklangan foydalanuvchining sessiyasi darhol tugaydi', async () => {
  const st = await login(app, 'talaba2');
  assert.equal((await st.get('/talaba')).status, 200);
  const dek = await login(app, 'dekan_at');
  const r = await dek.form(`/admin/users/${await userId('talaba2')}/status`);
  assert.equal(r.status, 302);
  const after1 = await st.get('/talaba');
  assert.equal(after1.status, 302);
  assert.equal(after1.headers.location, '/login');
  // qayta kira olmaydi
  const page = await request(app).get('/login');
  const r2 = await request(app).post('/login').set('Cookie', page.headers['set-cookie']).type('form')
    .send({ _csrf: csrfOf(page.text), login: 'talaba2', parol: 'parol123' });
  assert.equal(r2.status, 401);
  await pool.query("UPDATE users SET status = TRUE WHERE login = 'talaba2'");
});

test('TC-04 (K-03): sessiya Postgres\'da — yangi app instansida ham ishlaydi', async () => {
  const agent = await login(app, 'karimova');
  const cookie = agent.jar.getCookie('sid', { domain: '127.0.0.1', path: '/', secure: false, script: false });
  const app2 = createApp();
  const r = await request(app2).get('/xodim/bugun').set('Cookie', `sid=${cookie.value}`);
  assert.equal(r.status, 200);
});

test('TC-05 (K-04): CSRF tokensiz POST rad etiladi', async () => {
  const agent = await login(app, 'admin', 'admin12345');
  const r = await agent.post('/admin/guruhlar').type('form').send({ nomi: 'CSRF-1', fakultet_id: '1' });
  assert.equal(r.status, 403);
  const r2 = await agent.post('/admin/guruhlar').type('form').send({ _csrf: 'notogri', nomi: 'CSRF-1', fakultet_id: '1' });
  assert.equal(r2.status, 403);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM guruhlar WHERE nomi = 'CSRF-1'")).rows[0].n, 0);
});

test('TC-07 (K-13): login katta-kichik harfga sezgir emas', async () => {
  const agent = await login(app, 'ADMIN', 'admin12345');
  assert.equal((await agent.get('/panel')).status, 200);
  const r = await agent.form('/admin/users', { familiya: 'Test', ism: 'Admin', login: 'Admin', parol: 'parol12345', role: 'teacher', bolim_id: '1' });
  assert.equal(r.status, 400);
  assert.match(r.text, /Bu login band/);
});

test('TC-08 (K-09): guruh nomi matn ("AT-21-01"), yangi foydalanuvchi parolni almashtirishi shart', async () => {
  const adm = await login(app, 'admin', 'admin12345');
  const r = await adm.form('/admin/users', {
    familiya: 'Yangi', ism: 'Talaba', login: 'yangi_t', parol: 'vaqtincha1', role: 'student', guruh: 'AT-21-01', kurs: '3', phone: '90 123 45 67',
  });
  assert.equal(r.status, 302, r.text.slice(0, 500));
  const { rows: [u] } = await pool.query("SELECT u.phone, s.guruh FROM users u JOIN student_info s ON s.user_id = u.id WHERE login = 'yangi_t'");
  assert.equal(u.guruh, 'AT-21-01');
  assert.equal(u.phone, '+998901234567');           // K-22 normallashtirildi

  const t = await login(app, 'yangi_t', 'vaqtincha1');
  const r1 = await t.get('/talaba');
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.location, '/profil/parol');
  const r2 = await t.get('/profil/parol');
  const ch = await t.post('/profil/parol').type('form').send({ _csrf: csrfOf(r2.text), eski: 'vaqtincha1', yangi: 'yangiParol1', yangi2: 'yangiParol1' });
  assert.equal(ch.status, 302);
  assert.equal((await t.get('/talaba')).status, 200);
});

test('Xodim/talaba admin sahifalariga kira olmaydi', async () => {
  const st = await login(app, 'talaba1');
  for (const p of ['/admin/users', '/admin/guruhlar', '/qabul', '/xodim/bugun', '/admin/sozlamalar', '/panel']) {
    assert.equal((await st.get(p)).status, 403, p);
  }
  const t = await login(app, 'karimova');
  for (const p of ['/admin/users', '/admin/sozlamalar', '/admin/audit', '/panel', '/navbat/yangi']) {
    assert.equal((await t.get(p)).status, 403, p);
  }
  // O'qituvchi boshqa xodimning jadvalini boshqara olmaydi
  assert.equal((await t.get(`/qabul?xodim=${await userId('dekan_at')}`)).status, 403);
});

test('Xavfsizlik sarlavhalari va cookie (K-05, K-07)', async () => {
  const r = await request(app).get('/login');
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(r.headers['x-powered-by'], undefined);
  const page = await request(app).get('/login');
  const res = await request(app).post('/login').set('Cookie', page.headers['set-cookie']).type('form')
    .send({ _csrf: csrfOf(page.text), login: 'talaba1', parol: 'parol123' });
  assert.match(res.headers['set-cookie'].join(';'), /HttpOnly/);
  assert.match(res.headers['set-cookie'].join(';'), /SameSite=Lax/);
});

test('Cron endpoint maxfiy kalitsiz ishlamaydi', async () => {
  assert.equal((await request(app).post('/internal/cron/kelmadi')).status, 401);
  assert.equal((await request(app).post('/internal/cron/kelmadi').set('X-Cron-Secret', 'x')).status, 401);
  const r = await request(app).post('/internal/cron/kelmadi').set('X-Cron-Secret', 'test-cron');
  assert.equal(r.status, 200);
});

test('TC-06 (K-06): 11-noto\'g\'ri urinishda 429', async () => {
  const page = await request(app).get('/login');
  const cookie = page.headers['set-cookie'];
  const token = csrfOf(page.text);
  let last;
  for (let i = 0; i < 11; i++) {
    last = await request(app).post('/login').set('Cookie', cookie).type('form').send({ _csrf: token, login: 'registrator', parol: 'xato' + i });
  }
  assert.equal(last.status, 429);
  assert.match(last.text, /Juda ko&#x27;p urinish|Juda ko'p urinish/);
});
