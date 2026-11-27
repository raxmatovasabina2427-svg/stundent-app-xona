// M3: /admin/users — admin va dekanat (fakultet doirasida)
const express = require('express');
const { ah, flash, idParam, notFound, forbidden, safeBack } = require('../../lib/http');
const { requireRole, canManageUser, assignableRoles } = require('../../middleware/rbac');
const { STAFF_ROLES } = require('../../lib/scope');
const opts = require('../../lib/options');
const svc = require('./service');

const router = express.Router();
router.use('/admin/users', requireRole('admin', 'dekanat'));

async function formOptions(req) {
  const [bolimlar, guruhlar] = await Promise.all([opts.managedBolimlar(req.user, req), opts.managedGuruhlar(req.user, req)]);
  return { bolimlar, guruhlar, roles: assignableRoles(req.user) };
}

async function loadTarget(req) {
  const u = await svc.find(idParam(req.params.id));
  if (!u) throw notFound('Foydalanuvchi topilmadi');
  return u;
}

router.get('/admin/users', ah(async (req, res) => {
  const f = {
    q: req.query.q || '', role: req.query.role || '', status: req.query.status || '',
    guruh: req.query.guruh || '', kurs: req.query.kurs || '', bolim: req.query.bolim || '',
    page: req.query.page, size: req.query.size,
  };
  const result = await svc.list(req.user, f, req);
  const o = await formOptions(req);
  res.render('users/list', {
    title: 'Foydalanuvchilar', f, ...result, ...o,
    allRoles: req.user.role === 'admin' ? ['admin', 'dekanat', 'teacher', 'tyutor', 'xodim', 'student'] : ['dekanat', 'teacher', 'tyutor', 'xodim', 'student'],
    prev: result.page > 1 ? result.page - 1 : null,
    next: result.page < result.pages ? result.page + 1 : null,
  });
}));

router.get('/admin/users/new', ah(async (req, res) => {
  const o = await formOptions(req);
  const role = o.roles.includes(req.query.role) ? req.query.role : 'student';
  res.render('users/form', { title: 'Yangi foydalanuvchi', isNew: true, u: { role }, ...o, staffRoles: STAFF_ROLES });
}));

router.post('/admin/users', ah(async (req, res) => {
  const { data, errors } = svc.parse(req.body, { isNew: true });
  const o = await formOptions(req);
  const again = (errs, status = 400) => res.status(status).render('users/form', {
    title: 'Yangi foydalanuvchi', isNew: true, u: { ...req.body, tyutor_guruhlar: [].concat(req.body.tyutor_guruhlar || []) },
    errors: errs, ...o, staffRoles: STAFF_ROLES,
  });
  if (Object.keys(errors).length) return again(errors);
  try {
    const id = await svc.create(req.user, data, req);
    flash(req, 'ok', 'Foydalanuvchi yaratildi. Birinchi kirishda parolni almashtirishi so\'raladi.');
    res.redirect(`/admin/users/${id}`);
  } catch (e) {
    if (e.expose && e.status === 400) return again({ _: e.message });
    throw e;
  }
}));

router.get('/admin/users/:id', ah(async (req, res) => {
  const target = await loadTarget(req);
  const canManage = await canManageUser(req.user, target, req);
  if (!canManage && req.user.role !== 'admin') {
    // dekanat fakultetidagi boshqa dekanat xodimlarini faqat ko'radi
    const r = await svc.list(req.user, { q: target.login }, req);
    if (!r.rows.some((x) => x.id === target.id)) throw forbidden();
  }
  const u = await svc.profile(target.id);
  res.render('users/show', {
    title: `${u.familiya} ${u.ism}`, u, canManage, isSelf: u.id === req.user.id,
    isStaffUser: STAFF_ROLES.includes(u.role), bolimOptions: await opts.managedBolimlar(req.user, req),
  });
}));

router.get('/admin/users/:id/edit', ah(async (req, res) => {
  const u = await loadTarget(req);
  if (!(await canManageUser(req.user, u, req))) throw forbidden();
  res.render('users/form', { title: 'Tahrirlash', u, ...(await formOptions(req)), staffRoles: STAFF_ROLES, isSelf: u.id === req.user.id });
}));

router.post('/admin/users/:id', ah(async (req, res) => {
  const target = await loadTarget(req);
  const { data, errors } = svc.parse(req.body, { isNew: false });
  const again = async (errs) => res.status(400).render('users/form', {
    title: 'Tahrirlash', u: { ...target, ...req.body, id: target.id, tyutor_guruhlar: [].concat(req.body.tyutor_guruhlar || []) },
    errors: errs, ...(await formOptions(req)), staffRoles: STAFF_ROLES, isSelf: target.id === req.user.id,
  });
  if (Object.keys(errors).length) return again(errors);
  try {
    await svc.update(req.user, target, data, req);
  } catch (e) {
    if (e.expose && e.status === 400) return again({ _: e.message });
    throw e;
  }
  flash(req, 'ok', 'Saqlandi');
  res.redirect(`/admin/users/${target.id}`);
}));

router.post('/admin/users/:id/status', ah(async (req, res) => {
  const target = await loadTarget(req);
  const status = !target.status;
  const bekor = await svc.setStatus(req.user, target, status, req);
  flash(req, 'ok', status ? 'Faollashtirildi' : `Bloklandi${bekor ? ` — ${bekor} ta kelgusi navbat bekor qilindi` : ''}`);
  res.redirect(safeBack(req, '/admin/users'));
}));

router.post('/admin/users/:id/delete', ah(async (req, res) => {
  const target = await loadTarget(req);
  await svc.remove(req.user, target, req);
  flash(req, 'ok', 'O\'chirildi');
  res.redirect('/admin/users');
}));

router.post('/admin/users/:id/bolimlar', ah(async (req, res) => {
  const target = await loadTarget(req);
  const bolimId = Number(req.body.bolim_id);
  if (!Number.isSafeInteger(bolimId) || bolimId <= 0) {
    flash(req, 'err', 'Bo\'limni tanlang');
  } else {
    await svc.addBolim(req.user, target, {
      bolim_id: bolimId, lavozim: String(req.body.lavozim || '').trim().slice(0, 150), asosiy: req.body.asosiy === '1',
    }, req);
    flash(req, 'ok', 'Bo\'lim biriktirildi');
  }
  res.redirect(`/admin/users/${target.id}`);
}));

router.post('/admin/users/:id/bolimlar/:xb/delete', ah(async (req, res) => {
  const target = await loadTarget(req);
  await svc.removeBolim(req.user, target, idParam(req.params.xb), req);
  flash(req, 'ok', 'Biriktirish olib tashlandi');
  res.redirect(`/admin/users/${target.id}`);
}));

module.exports = router;
