// Markaziy ruxsatlar (4.2-matritsa). Route'lar faqat shu yerdagi funksiyalarni chaqiradi.
const db = require('../db/pool');
const { forbidden } = require('../lib/http');
const { STAFF_ROLES, userScope, userInScope } = require('../lib/scope');

const isAdmin = (u) => u.role === 'admin';
const isStaff = (u) => STAFF_ROLES.includes(u.role);
const isManager = (u) => u.role === 'admin' || u.role === 'dekanat';

/** Rol bo'yicha marshrut himoyasi */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};

/**
 * Foydalanuvchini boshqarish (yaratish/tahrirlash/bloklash) — K-01:
 *  - admin: hammani (o'zini bloklash/rolini o'zgartirish alohida taqiqlanadi)
 *  - dekanat: faqat fakultet doirasidagi student/teacher/tyutor/xodim
 */
async function canManageUser(actor, target, req) {
  if (isAdmin(actor)) return true;
  if (actor.role !== 'dekanat') return false;
  if (!['student', 'teacher', 'tyutor', 'xodim'].includes(target.role)) return false;
  return userInScope(target, await userScope(actor, req));
}

/** Qaysi rollarni bera oladi */
function assignableRoles(actor) {
  if (isAdmin(actor)) return ['admin', 'dekanat', 'teacher', 'tyutor', 'xodim', 'student'];
  if (actor.role === 'dekanat') return ['teacher', 'tyutor', 'xodim', 'student'];
  return [];
}

/** Bo'lim doirada (dekanat uchun) yoki admin */
async function canUseBolim(actor, bolimId, req) {
  if (isAdmin(actor)) return true;
  if (actor.role !== 'dekanat') return false;
  return (await userScope(actor, req)).bolimIds.includes(Number(bolimId));
}

/** Fakultet (guruh uchun) doirada */
async function canUseFakultet(actor, fakultetId, req) {
  if (isAdmin(actor)) return true;
  if (actor.role !== 'dekanat') return false;
  return (await userScope(actor, req)).fakultetId === Number(fakultetId);
}

/**
 * Xodimning qabul jadvali va istisnolarini boshqarish:
 * o'zi (xodim rollari), dekanat — fakultet xodimlari, admin — hamma.
 */
async function canManageXodim(actor, xodimId, req) {
  if (isAdmin(actor)) return true;
  if (actor.id === Number(xodimId)) return isStaff(actor);
  if (actor.role !== 'dekanat') return false;
  const { rows: [t] } = await db.query('SELECT id, role FROM users WHERE id = $1', [xodimId]);
  if (!t || !isStaff(t)) return false;
  return userInScope(t, await userScope(actor, req));
}

/**
 * Navbatga kirish huquqi. nav: { student_id, xodim_id, bolim_id, guruh }
 * 'view' — ko'rish, 'manage' — holatni o'zgartirish (BR-17)
 */
async function navbatAccess(actor, nav, mode, req) {
  if (isAdmin(actor)) return true;
  if (nav.xodim_id === actor.id && isStaff(actor)) return true;
  if (actor.role === 'dekanat') {
    return (await userScope(actor, req)).bolimIds.includes(nav.bolim_id);
  }
  if (mode === 'view') {
    if (actor.role === 'student') return nav.student_id === actor.id;
    if (actor.role === 'tyutor' && nav.guruh) {
      const { rows } = await db.query('SELECT 1 FROM tyutor_guruh WHERE tyutor_id = $1 AND guruh = $2', [actor.id, nav.guruh]);
      return rows.length > 0;
    }
  }
  return false;
}

async function assert(promiseOrBool, msg) {
  if (!(await promiseOrBool)) throw forbidden(msg);
}

module.exports = {
  isAdmin, isStaff, isManager, requireRole, canManageUser, assignableRoles,
  canUseBolim, canUseFakultet, canManageXodim, navbatAccess, assert,
};
