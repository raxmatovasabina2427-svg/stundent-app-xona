'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../db/pool');
const { ah, flash, idParam, AppError, notFound } = require('../../lib/http');
const { requireRole, isAdmin } = require('../../middleware/rbac');
const { requireLogin } = require('../../middleware/auth');
const { userScope } = require('../../lib/scope');
const { audit } = require('../../lib/audit');
const { notify } = require('../../modules/navbat/notify');
const opts = require('../../lib/options');
const { today, nowTime } = require('../../lib/time');
const { z } = require('zod');

router.use(requireLogin);

const TYPES = ['kompyuter', 'laboratoriya', 'maruza'];
const dtFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDateTime = (d) => (d ? dtFmt.format(new Date(d)).replace(/^(\d{2})\/(\d{2})\/(\d{4}),?/, '$1.$2.$3') : '');
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
const resourceSchema = z.object({
  nomi: z.string().trim().min(2).max(120),
  turi: z.enum(TYPES),
  bino: z.string().trim().max(100).optional().default(''),
  qavat: z.coerce.number().int().min(0).max(100).default(0),
  xona_raqami: z.string().trim().max(30).optional().default(''),
  sigim: z.coerce.number().int().min(1).max(1000),
  jihozlar: z.string().trim().max(2000).optional().default(''),
  ish_boshlanish: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  ish_tugash: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  masul_bolim_id: z.preprocess((v) => v === '' || v === undefined ? null : v, z.coerce.number().int().positive().nullable()),
}).refine((v) => v.ish_boshlanish < v.ish_tugash, { path: ['ish_tugash'], message: 'Tugash vaqti boshlanish vaqtidan keyin bo‘lishi kerak' });
const bookingSchema = z.object({
  resurs_id: z.coerce.number().int().positive(),
  sana: z.string().refine(validDate, 'Sanani to‘g‘ri kiriting'),
  boshlanish: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  tugash: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  odam_soni: z.coerce.number().int().min(1).max(1000),
  sabab: z.string().trim().min(3).max(500),
}).refine((v) => v.boshlanish < v.tugash, { path: ['tugash'], message: 'Tugash vaqti boshlanish vaqtidan keyin bo‘lishi kerak' });

async function resourceAccess(req, resource) {
  if (isAdmin(req.user)) return true;
  if (req.user.role !== 'dekanat') return false;
  if (!resource.masul_bolim_id) return false;
  const scope = await userScope(req.user, req);
  return scope.bolimIds.includes(Number(resource.masul_bolim_id));
}
async function getResource(id) {
  const { rows } = await db.query('SELECT * FROM xona_bron_resurslar WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Xona topilmadi');
  return rows[0];
}
async function resourceFormData(req, { title, resource = null, values = null }) {
  const form = values || resource || { turi: 'kompyuter', sigim: 20, qavat: 0, ish_boshlanish: '08:00', ish_tugash: '20:00' };
  return { title, resource, form, types: TYPES, bolimlar: await opts.managedBolimlar(req.user, req), isDekanat: req.user.role === 'dekanat' };
}
function renderError(res, view, data, message, status = 400) {
  return res.status(status).render(`xona_bron/${view}`, { ...data, error: message });
}

// Foydalanuvchilar uchun resurslar ro‘yxati va filter.
router.get('/xona_bron', ah(async (req, res) => {
  const type = TYPES.includes(req.query.turi) ? req.query.turi : null;
  const { rows } = await db.query(
    `SELECT r.* FROM xona_bron_resurslar r WHERE r.status = 'faol' AND ($1::text IS NULL OR r.turi = $1) ORDER BY r.turi, r.nomi`,
    [type],
  );
  res.render('xona_bron/index', { title: 'Xonalarni bron qilish', resources: rows, filters: { turi: type }, types: TYPES, today: today() });
}));

router.get('/xona_bron/:id(\\d+)', ah(async (req, res) => {
  const id = idParam(req.params.id);
  const resource = await getResource(id);
  const date = validDate(req.query.sana) ? req.query.sana : today();
  const { rows: bookings } = await db.query(
    `SELECT boshlanish, tugash, status FROM xona_bronlar WHERE resurs_id = $1 AND sana = $2 AND status IN ('kutilmoqda','tasdiqlandi') ORDER BY boshlanish`,
    [id, date],
  );
  res.render('xona_bron/detail', { title: resource.nomi, resource, bookings, bron_sana: date, today: today() });
}));
router.get('/xona_bron/jadval/:id(\\d+)', (req, res) => {
  const query = req.query.sana ? `?sana=${encodeURIComponent(req.query.sana)}` : '';
  res.redirect(`/xona_bron/${req.params.id}${query}`);
});

router.get('/xona_bron/yangi', ah(async (req, res) => {
  const id = req.query.resurs_id ? idParam(req.query.resurs_id) : null;
  const resource = id ? await getResource(id) : null;
  if (resource && resource.status !== 'faol') throw new AppError('Bu xona hozir bron uchun mavjud emas');
  res.render('xona_bron/booking', { title: 'Bron qilish', resource, resources: id ? [] : (await db.query("SELECT id, nomi, turi, sigim FROM xona_bron_resurslar WHERE status = 'faol' ORDER BY turi, nomi")).rows, today: today() });
}));

router.post('/xona_bron/yangi', ah(async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) return renderError(res, 'booking', { title: 'Bron qilish', resources: (await db.query("SELECT id, nomi, turi, sigim FROM xona_bron_resurslar WHERE status = 'faol' ORDER BY turi, nomi")).rows, today: today(), values: req.body }, parsed.error.issues[0].message);
  const v = parsed.data;
  if (v.sana < today() || (v.sana === today() && v.boshlanish <= nowTime())) throw new AppError('O‘tgan vaqtga bron qilib bo‘lmaydi');
  const result = await db.tx(async (client) => {
    const { rows: [resource] } = await client.query('SELECT * FROM xona_bron_resurslar WHERE id = $1 AND status = $2 FOR UPDATE', [v.resurs_id, 'faol']);
    if (!resource) throw notFound('Faol xona topilmadi');
    if (v.odam_soni > resource.sigim) throw new AppError('Odamlar soni xona sig‘imidan oshmasligi kerak');
    if (v.boshlanish < resource.ish_boshlanish || v.tugash > resource.ish_tugash) throw new AppError('Tanlangan vaqt xonaning ish vaqtiga mos emas');
    const { rows: [closed] } = await client.query(
      `SELECT id FROM xona_bron_yopiq_vaqtlar WHERE resurs_id = $1 AND sana = $2 AND boshlanish < $4 AND tugash > $3 LIMIT 1`,
      [v.resurs_id, v.sana, v.boshlanish, v.tugash],
    );
    if (closed) throw new AppError('Tanlangan vaqt xona uchun yopiq');
    const { rows: [conflict] } = await client.query(
      `SELECT id FROM xona_bronlar WHERE resurs_id = $1 AND sana = $2 AND status IN ('kutilmoqda','tasdiqlandi') AND boshlanish < $4 AND tugash > $3 LIMIT 1`,
      [v.resurs_id, v.sana, v.boshlanish, v.tugash],
    );
    if (conflict) throw new AppError('Bu vaqt oralig‘ida xona band yoki tasdiqlash kutilmoqda');
    const { rows: [booking] } = await client.query(
      `INSERT INTO xona_bronlar (resurs_id, user_id, sana, boshlanish, tugash, odam_soni, sabab, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'kutilmoqda') RETURNING *`,
      [v.resurs_id, req.user.id, v.sana, v.boshlanish, v.tugash, v.odam_soni, v.sabab],
    );
    await client.query(`INSERT INTO xona_bron_tarix (bron_id,user_id,eski_status,yangi_status,izoh) VALUES ($1,$2,NULL,'kutilmoqda','Bron so‘rovi yaratildi')`, [booking.id, req.user.id]);
    await notify(client, req.user.id, `Bron so‘rovingiz qabul qilindi. Bron raqami: ${booking.id}`);
    return booking;
  });
  await audit({ req, amal: 'xona_bron.create', obyekt: 'xona_bronlar', obyektId: result.id, yangi: result });
  flash(req, 'ok', 'Bron so‘rovi yuborildi. Tasdiqlanishini kuting.');
  res.redirect('/xona_bron/mening');
}));

router.get('/xona_bron/mening', ah(async (req, res) => {
  const { rows } = await db.query(
    `SELECT b.*, r.nomi AS resurs_nomi, r.turi FROM xona_bronlar b JOIN xona_bron_resurslar r ON r.id = b.resurs_id WHERE b.user_id = $1 ORDER BY b.sana DESC,b.boshlanish DESC LIMIT 200`,
    [req.user.id],
  );
  res.render('xona_bron/my-bookings', { title: 'Mening bronlarim', bookings: rows, today: today(), nowTime: nowTime() });
}));

router.get('/xona_bron/bron/:id(\\d+)', ah(async (req, res) => {
  const id = idParam(req.params.id);
  const { rows: [booking] } = await db.query(
    `SELECT b.*, r.nomi AS resurs_nomi, r.turi, r.bino, r.xona_raqami, u.ism, u.familiya FROM xona_bronlar b JOIN xona_bron_resurslar r ON r.id=b.resurs_id JOIN users u ON u.id=b.user_id WHERE b.id=$1`, [id],
  );
  if (!booking) throw notFound('Bron topilmadi');
  if (booking.user_id !== req.user.id && !['admin','dekanat'].includes(req.user.role)) throw new AppError('Bu bronni ko‘rish huquqingiz yo‘q', 403);
  if (req.user.role === 'dekanat') {
    const resource = await getResource(booking.resurs_id);
    if (!(await resourceAccess(req, resource))) throw new AppError('Bu bronni ko‘rish huquqingiz yo‘q', 403);
  }
  const { rows: rawHistory } = await db.query('SELECT * FROM xona_bron_tarix WHERE bron_id=$1 ORDER BY created_at DESC', [id]);
  const history = rawHistory.map((h) => ({ ...h, vaqt_matn: fmtDateTime(h.created_at) }));
  res.render('xona_bron/booking-detail', { title: 'Bron tafsilotlari', booking, history });
}));

router.post('/xona_bron/bron/:id(\\d+)/bekor', ah(async (req, res) => {
  const id = idParam(req.params.id);
  const result = await db.tx(async (client) => {
    const { rows: [booking] } = await client.query('SELECT * FROM xona_bronlar WHERE id=$1 FOR UPDATE', [id]);
    if (!booking) throw notFound('Bron topilmadi');
    if (booking.user_id !== req.user.id && !isAdmin(req.user)) throw new AppError('Bu bronni bekor qilish huquqingiz yo‘q', 403);
    if (!['kutilmoqda','tasdiqlandi'].includes(booking.status)) throw new AppError('Bu bronni bekor qilib bo‘lmaydi');
    if (booking.sana < today() || (booking.sana === today() && booking.boshlanish <= nowTime())) throw new AppError('Boshlanib bo‘lgan bronni bekor qilib bo‘lmaydi');
    await client.query("UPDATE xona_bronlar SET status='bekor_qilindi',updated_at=NOW() WHERE id=$1", [id]);
    await client.query("INSERT INTO xona_bron_tarix (bron_id,user_id,eski_status,yangi_status,izoh) VALUES ($1,$2,$3,'bekor_qilindi','Foydalanuvchi bekor qildi')", [id, req.user.id, booking.status]);
    return booking;
  });
  await audit({ req, amal: 'xona_bron.cancel', obyekt: 'xona_bronlar', obyektId: id, eski: result, yangi: { status: 'bekor_qilindi' } });
  flash(req, 'ok', 'Bron bekor qilindi.');
  res.redirect('/xona_bron/mening');
}));

// Admin va dekanat boshqaruvi.
router.get('/admin/xona_bron/resurslar', requireRole('admin','dekanat'), ah(async (req, res) => {
  let sql = 'SELECT * FROM xona_bron_resurslar';
  let params = [];
  if (req.user.role === 'dekanat') {
    const scope = await userScope(req.user, req);
    sql += ' WHERE masul_bolim_id = ANY($1::bigint[])'; params = [scope.bolimIds];
  }
  sql += ' ORDER BY turi,nomi';
  const { rows } = await db.query(sql, params);
  res.render('xona_bron/admin-resources', { title: 'Xonalarni boshqarish', resources: rows });
}));

router.get('/admin/xona_bron/resurslar/yangi', requireRole('admin','dekanat'), ah(async (req, res) => {
  res.render('xona_bron/resource-form', await resourceFormData(req, { title: 'Yangi xona' }));
}));
router.get('/admin/xona_bron/resurslar/:id(\\d+)/tahrir', requireRole('admin','dekanat'), ah(async (req, res) => {
  const resource = await getResource(idParam(req.params.id));
  if (!(await resourceAccess(req, resource))) throw new AppError('Bu xonani boshqarish huquqingiz yo‘q', 403);
  res.render('xona_bron/resource-form', await resourceFormData(req, { title: 'Xonani tahrirlash', resource }));
}));
router.post('/admin/xona_bron/resurslar/yangi', requireRole('admin','dekanat'), ah(async (req, res) => {
  const parsed = resourceSchema.safeParse(req.body);
  if (!parsed.success) return renderError(res, 'resource-form', await resourceFormData(req, { title: 'Yangi xona', values: req.body }), parsed.error.issues[0].message);
  const v = parsed.data;
  if (req.user.role === 'dekanat') {
    const scope = await userScope(req.user, req);
    if (!v.masul_bolim_id || !scope.bolimIds.includes(v.masul_bolim_id)) throw new AppError('Faqat o‘z fakultetingiz bo‘limiga biriktirilgan xona qo‘shishingiz mumkin', 403);
  }
  const { rows: [resource] } = await db.query(
    `INSERT INTO xona_bron_resurslar (nomi,turi,bino,qavat,xona_raqami,sigim,jihozlar,ish_boshlanish,ish_tugash,masul_bolim_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [v.nomi,v.turi,v.bino,v.qavat,v.xona_raqami,v.sigim,v.jihozlar,v.ish_boshlanish,v.ish_tugash,v.masul_bolim_id || null],
  );
  await audit({ req, amal: 'xona_bron.resource_create', obyekt: 'xona_bron_resurslar', obyektId: resource.id, yangi: resource });
  flash(req, 'ok', 'Xona qo‘shildi.'); res.redirect('/admin/xona_bron/resurslar');
}));
router.post('/admin/xona_bron/resurslar/:id(\\d+)/tahrir', requireRole('admin','dekanat'), ah(async (req, res) => {
  const id = idParam(req.params.id); const old = await getResource(id);
  if (!(await resourceAccess(req, old))) throw new AppError('Bu xonani boshqarish huquqingiz yo‘q', 403);
  const parsed = resourceSchema.safeParse(req.body);
  if (!parsed.success) return renderError(res, 'resource-form', await resourceFormData(req, { title: 'Xonani tahrirlash', resource: old, values: req.body }), parsed.error.issues[0].message);
  const v = parsed.data;
  if (req.user.role === 'dekanat') { const scope = await userScope(req.user, req); if (!v.masul_bolim_id || !scope.bolimIds.includes(v.masul_bolim_id)) throw new AppError('Bo‘lim doirasidan tashqarida', 403); }
  const { rows: [updated] } = await db.query(
    `UPDATE xona_bron_resurslar SET nomi=$1,turi=$2,bino=$3,qavat=$4,xona_raqami=$5,sigim=$6,jihozlar=$7,ish_boshlanish=$8,ish_tugash=$9,masul_bolim_id=$10,updated_at=NOW() WHERE id=$11 RETURNING *`,
    [v.nomi,v.turi,v.bino,v.qavat,v.xona_raqami,v.sigim,v.jihozlar,v.ish_boshlanish,v.ish_tugash,v.masul_bolim_id || null,id],
  );
  await audit({ req, amal: 'xona_bron.resource_update', obyekt: 'xona_bron_resurslar', obyektId: id, eski: old, yangi: updated });
  flash(req, 'ok', 'Xona ma’lumotlari yangilandi.'); res.redirect('/admin/xona_bron/resurslar');
}));
router.post('/admin/xona_bron/resurslar/:id(\\d+)/status', requireRole('admin','dekanat'), ah(async (req, res) => {
  const id = idParam(req.params.id); const old = await getResource(id);
  if (!(await resourceAccess(req, old))) throw new AppError('Bu xonani boshqarish huquqingiz yo‘q', 403);
  const status = req.body.status;
  if (!['faol','faol_emas'].includes(status)) throw new AppError('Noto‘g‘ri holat');
  await db.query('UPDATE xona_bron_resurslar SET status=$1,updated_at=NOW() WHERE id=$2', [status,id]);
  await audit({ req, amal: 'xona_bron.resource_status', obyekt: 'xona_bron_resurslar', obyektId: id, eski: old, yangi: { status } });
  flash(req, 'ok', 'Xona holati yangilandi.'); res.redirect('/admin/xona_bron/resurslar');
}));

router.get('/admin/xona_bron/bronlar', requireRole('admin','dekanat'), ah(async (req, res) => {
  let scopeSql = ''; let params = [];
  if (req.user.role === 'dekanat') { const scope = await userScope(req.user, req); scopeSql = ' AND r.masul_bolim_id = ANY($1::bigint[])'; params = [scope.bolimIds]; }
  const { rows } = await db.query(
    `SELECT b.*,r.nomi AS resurs_nomi,r.turi,u.ism,u.familiya FROM xona_bronlar b JOIN xona_bron_resurslar r ON r.id=b.resurs_id JOIN users u ON u.id=b.user_id WHERE 1=1${scopeSql} ORDER BY CASE b.status WHEN 'kutilmoqda' THEN 0 ELSE 1 END,b.sana,b.boshlanish LIMIT 300`, params,
  );
  res.render('xona_bron/admin-bookings', { title: 'Bronlarni boshqarish', bookings: rows });
}));
async function changeBooking(req, res, status) {
  const id = idParam(req.params.id);
  const result = await db.tx(async (client) => {
    const { rows: [booking] } = await client.query('SELECT b.*,r.masul_bolim_id,r.status AS resurs_status,r.ish_boshlanish,r.ish_tugash FROM xona_bronlar b JOIN xona_bron_resurslar r ON r.id=b.resurs_id WHERE b.id=$1 FOR UPDATE OF b', [id]);
    if (!booking) throw notFound('Bron topilmadi');
    if (req.user.role === 'dekanat') { const scope = await userScope(req.user, req); if (!scope.bolimIds.includes(Number(booking.masul_bolim_id))) throw new AppError('Bu bron sizning vakolatingizga kirmaydi', 403); }
    if (booking.status !== 'kutilmoqda') throw new AppError('Faqat kutilayotgan bronni ko‘rib chiqish mumkin');
    if (status === 'tasdiqlandi') {
      if (booking.resurs_status !== 'faol') throw new AppError('Xona faol emas, bronni tasdiqlab bo‘lmaydi');
      if (booking.boshlanish < booking.ish_boshlanish || booking.tugash > booking.ish_tugash) throw new AppError('Bron vaqti xonaning ish vaqtiga mos emas');
      const { rows: [closed] } = await client.query('SELECT id FROM xona_bron_yopiq_vaqtlar WHERE resurs_id=$1 AND sana=$2 AND boshlanish<$4 AND tugash>$3 LIMIT 1', [booking.resurs_id,booking.sana,booking.boshlanish,booking.tugash]);
      if (closed) throw new AppError('Tanlangan vaqt xona uchun yopiq');
    }
    if (status === 'tasdiqlandi') {
      const { rows: [conflict] } = await client.query("SELECT id FROM xona_bronlar WHERE resurs_id=$1 AND sana=$2 AND id<>$3 AND status='tasdiqlandi' AND boshlanish<$5 AND tugash>$4 LIMIT 1", [booking.resurs_id,booking.sana,id,booking.boshlanish,booking.tugash]);
      if (conflict) throw new AppError('Bu vaqt boshqa tasdiqlangan bron bilan to‘qnashmoqda');
    }
    const note = String(req.body.izoh || '').trim().slice(0,500);
    if (status === 'rad_etildi' && note.length < 3) throw new AppError('Rad etish sababini kamida 3 ta belgida yozing');
    await client.query('UPDATE xona_bronlar SET status=$1,javob_izoh=$2,tasdiqlovchi_id=$3,updated_at=NOW() WHERE id=$4', [status,note || null,req.user.id,id]);
    await client.query('INSERT INTO xona_bron_tarix (bron_id,user_id,eski_status,yangi_status,izoh) VALUES ($1,$2,$3,$4,$5)', [id,req.user.id,booking.status,status,note || null]);
    await notify(client, booking.user_id, status === 'tasdiqlandi' ? `Broningiz tasdiqlandi. Bron raqami: ${id}` : `Broningiz rad etildi. Sabab: ${note}`);
    return booking;
  });
  await audit({ req, amal: `xona_bron.${status}`, obyekt: 'xona_bronlar', obyektId: id, eski: result, yangi: { status } });
  flash(req, 'ok', status === 'tasdiqlandi' ? 'Bron tasdiqlandi.' : 'Bron rad etildi.');
  res.redirect('/admin/xona_bron/bronlar');
}
router.post('/admin/xona_bron/bronlar/:id(\\d+)/tasdiq', requireRole('admin','dekanat'), ah(async (req,res)=>changeBooking(req,res,'tasdiqlandi')));
router.post('/admin/xona_bron/bronlar/:id(\\d+)/rad', requireRole('admin','dekanat'), ah(async (req,res)=>changeBooking(req,res,'rad_etildi')));

router.get('/admin/xona_bron/yopiq-vaqtlar', requireRole('admin','dekanat'), ah(async (req,res)=>{
  let clause=''; let params=[];
  if(req.user.role==='dekanat'){const scope=await userScope(req.user,req);clause=' WHERE r.masul_bolim_id=ANY($1::bigint[])';params=[scope.bolimIds];}
  const {rows}=await db.query(`SELECT c.*,r.nomi AS resurs_nomi FROM xona_bron_yopiq_vaqtlar c JOIN xona_bron_resurslar r ON r.id=c.resurs_id${clause} ORDER BY c.sana DESC,c.boshlanish`,params);
  const resources= req.user.role==='admin' ? (await db.query("SELECT id,nomi FROM xona_bron_resurslar WHERE status='faol' ORDER BY nomi")).rows : (await db.query("SELECT id,nomi FROM xona_bron_resurslar WHERE status='faol' AND masul_bolim_id=ANY($1::bigint[]) ORDER BY nomi",params)).rows;
  res.render('xona_bron/closed-times',{title:'Yopiq vaqtlar',closed:rows,resources,today:today()});
}));
router.post('/admin/xona_bron/yopiq-vaqtlar', requireRole('admin','dekanat'), ah(async(req,res)=>{
  const schema=z.object({resurs_id:z.coerce.number().int().positive(),sana:z.string().refine(validDate),boshlanish:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),tugash:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),sabab:z.string().trim().min(3).max(300)}).refine(v=>v.boshlanish<v.tugash);
  const parsed=schema.safeParse(req.body); if(!parsed.success) throw new AppError(parsed.error.issues[0]?.message || 'Ma’lumot noto‘g‘ri');
  const v=parsed.data; const resource=await getResource(v.resurs_id); if(!(await resourceAccess(req,resource))) throw new AppError('Bu xonani boshqarish huquqingiz yo‘q',403);
  if (v.sana < today() || (v.sana === today() && v.boshlanish <= nowTime())) throw new AppError('O‘tgan vaqtni yopib bo‘lmaydi');
  if (v.boshlanish < resource.ish_boshlanish || v.tugash > resource.ish_tugash) throw new AppError('Yopiq vaqt xona ish vaqtiga mos emas');
  const {rows:[conflict]} = await db.query("SELECT id FROM xona_bronlar WHERE resurs_id=$1 AND sana=$2 AND status IN ('kutilmoqda','tasdiqlandi') AND boshlanish<$4 AND tugash>$3 LIMIT 1", [v.resurs_id,v.sana,v.boshlanish,v.tugash]);
  if (conflict) throw new AppError('Bu vaqtda bron mavjud; avval bronni hal qiling');
  const {rows:[closed]}=await db.query('INSERT INTO xona_bron_yopiq_vaqtlar (resurs_id,sana,boshlanish,tugash,sabab,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',[v.resurs_id,v.sana,v.boshlanish,v.tugash,v.sabab,req.user.id]);
  await audit({req,amal:'xona_bron.close_time',obyekt:'xona_bron_yopiq_vaqtlar',obyektId:closed.id,yangi:closed}); flash(req,'ok','Yopiq vaqt qo‘shildi.'); res.redirect('/admin/xona_bron/yopiq-vaqtlar');
}));
router.post('/admin/xona_bron/yopiq-vaqtlar/:id(\\d+)/och', requireRole('admin','dekanat'), ah(async(req,res)=>{
  const id=idParam(req.params.id); const {rows:[closed]}=await db.query('SELECT c.*,r.masul_bolim_id FROM xona_bron_yopiq_vaqtlar c JOIN xona_bron_resurslar r ON r.id=c.resurs_id WHERE c.id=$1',[id]);
  if(!closed) throw notFound('Yopiq vaqt topilmadi'); if(!(await resourceAccess(req,{masul_bolim_id:closed.masul_bolim_id}))) throw new AppError('Ruxsat yo‘q',403);
  await db.query('DELETE FROM xona_bron_yopiq_vaqtlar WHERE id=$1',[id]); await audit({req,amal:'xona_bron.open_time',obyekt:'xona_bron_yopiq_vaqtlar',obyektId:id,eski:closed}); flash(req,'ok','Yopiq vaqt olib tashlandi.'); res.redirect('/admin/xona_bron/yopiq-vaqtlar');
}));

module.exports = {
  name: 'xona_bron',
  title: 'Xonalarni bron qilish',
  router,
  nav: [
    { href: '/xona_bron', label: 'Xonalarni bron qilish', roles: ['student','teacher','tyutor','xodim','dekanat','admin'] },
    { href: '/admin/xona_bron/bronlar', label: 'Bron so‘rovlari', roles: ['dekanat','admin'] },
    { href: '/admin/xona_bron/resurslar', label: 'Xonalar', roles: ['dekanat','admin'] },
    { href: '/admin/xona_bron/yopiq-vaqtlar', label: 'Yopiq vaqtlar', roles: ['dekanat','admin'] },
  ],
};
