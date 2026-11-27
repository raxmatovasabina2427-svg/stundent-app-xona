// M3: foydalanuvchilar — biznes-qoidalar va SQL
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const db = require('../../db/pool');
const { AppError, forbidden, notFound } = require('../../lib/http');
const { audit } = require('../../lib/audit');
const { STAFF_ROLES, userScope } = require('../../lib/scope');
const rbac = require('../../middleware/rbac');
const { today } = require('../../lib/time');
const { notify } = require('../navbat/notify');

/** '+998 90 123-45-67' -> '+998901234567'; bo'sh -> null; noto'g'ri -> false (K-22) */
function normalizePhone(v) {
  const s = String(v ?? '').replace(/[\s\-()]/g, '');
  if (!s) return null;
  if (/^\+998\d{9}$/.test(s)) return s;
  if (/^998\d{9}$/.test(s)) return '+' + s;
  if (/^\d{9}$/.test(s)) return '+998' + s;
  return false;
}

const str = (max) => z.string().trim().max(max, `Ko'pi bilan ${max} belgi`);
const optStr = (max) => str(max).optional().transform((v) => v || null);

const userSchema = z.object({
  familiya: str(100).min(1, 'Familiya kiritilmagan'),
  ism: str(100).min(1, 'Ism kiritilmagan'),
  ochestva: optStr(100),
  login: str(100).min(3, 'Login kamida 3 belgi').regex(/^[A-Za-z0-9._@-]+$/, 'Login faqat lotin harflari, raqam va . _ - @'),
  parol: z.string().max(72, 'Parol juda uzun').optional().default(''),
  role: z.enum(['admin', 'dekanat', 'teacher', 'tyutor', 'xodim', 'student'], { message: 'Rol noto\'g\'ri' }),
  phone: z.string().optional().default(''),
  guruh: optStr(30),
  kurs: z.union([z.literal(''), z.coerce.number().int().min(1, 'Kurs 1–6').max(6, 'Kurs 1–6')]).optional().transform((v) => (v === '' || v === undefined ? null : v)),
  lavozim: optStr(150),
  bolim_id: z.union([z.literal(''), z.coerce.number().int().positive()]).optional().transform((v) => (v === '' || v === undefined ? null : v)),
  tyutor_guruhlar: z.union([z.string(), z.array(z.string())]).optional()
    .transform((v) => [...new Set((Array.isArray(v) ? v : v ? [v] : []).map((s) => s.trim()).filter(Boolean))]),
});

function parse(body, { isNew }) {
  const r = userSchema.safeParse(body);
  const errors = {};
  if (!r.success) for (const i of r.error.issues) errors[i.path[0]] ??= i.message;
  const d = r.success ? r.data : null;
  if (d) {
    const phone = normalizePhone(d.phone);
    if (phone === false) errors.phone = 'Telefon formati: +998XXXXXXXXX';
    else d.phone = phone;
    if (isNew && d.parol.length < 8) errors.parol = 'Parol kamida 8 belgi';
    if (!isNew && d.parol && d.parol.length < 8) errors.parol = 'Parol kamida 8 belgi';
    if (d.role === 'student') {
      if (!d.guruh) errors.guruh = 'Guruhni tanlang';
      if (!d.kurs) errors.kurs = 'Kursni kiriting';
    }
    if (isNew && STAFF_ROLES.includes(d.role) && !d.bolim_id) errors.bolim_id = 'Asosiy bo\'limni tanlang';
  }
  return { data: d, errors };
}

const FULL = `
  SELECT u.id, u.ism, u.familiya, u.ochestva, u.login, u.role, u.phone, u.status,
         u.parol_almashtirish, u.created_at, u.updated_at,
         s.guruh, s.kurs, g.fakultet_id AS guruh_fakultet_id, fg.nomi AS guruh_fakultet,
         d.lavozim AS unvon,
         COALESCE(s.tg_user, t.tg_user, d.tg_user) AS tg_user,
         xb.bolim_id AS asosiy_bolim_id, ab.nomi AS asosiy_bolim, xb.lavozim AS asosiy_lavozim
    FROM users u
    LEFT JOIN student_info s       ON s.user_id = u.id
    LEFT JOIN guruhlar g           ON g.nomi = s.guruh
    LEFT JOIN bolimlar fg          ON fg.id = g.fakultet_id
    LEFT JOIN teacher_info t       ON t.user_id = u.id
    LEFT JOIN dekanat_user_info d  ON d.user_id = u.id
    LEFT JOIN xodim_bolim xb       ON xb.user_id = u.id AND xb.asosiy
    LEFT JOIN bolimlar ab          ON ab.id = xb.bolim_id`;

async function find(id, q = db) {
  const { rows: [u] } = await q.query(`${FULL} WHERE u.id = $1`, [id]);
  if (!u) return null;
  const [{ rows: bolimlar }, { rows: tg }] = await Promise.all([
    q.query(`SELECT xb.id, xb.bolim_id, xb.lavozim, xb.asosiy, b.nomi, b.turi
               FROM xodim_bolim xb JOIN bolimlar b ON b.id = xb.bolim_id
              WHERE xb.user_id = $1 ORDER BY xb.asosiy DESC, b.nomi`, [id]),
    q.query('SELECT guruh FROM tyutor_guruh WHERE tyutor_id = $1 ORDER BY guruh', [id]),
  ]);
  u.bolimlar = bolimlar;
  u.tyutor_guruhlar = tg.map((r) => r.guruh);
  return u;
}

async function profile(id) {
  const u = await find(id);
  if (!u) throw notFound();
  if (STAFF_ROLES.includes(u.role)) {
    const { rows } = await db.query(
      `SELECT q.*, b.nomi AS bolim, b.xona FROM qabul_vaqti q JOIN bolimlar b ON b.id = q.bolim_id
        WHERE q.xodim_id = $1 ORDER BY q.status DESC, q.hafta_kuni, q.start_time`, [id]);
    u.shablonlar = rows;
  }
  if (u.role === 'student') {
    const { rows } = await db.query(
      `SELECT n.id, n.sana, n.boshlanish, n.tugash, n.navbat_raqami, n.status, b.nomi AS bolim,
              x.familiya, x.ism, mt.nomi AS murojaat
         FROM navbatlar n JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id
         JOIN bolimlar b ON b.id = q.bolim_id JOIN users x ON x.id = q.xodim_id
         LEFT JOIN murojaat_turlari mt ON mt.id = n.murojaat_turi_id
        WHERE n.student_id = $1 ORDER BY n.sana DESC, n.boshlanish DESC NULLS LAST LIMIT 50`, [id]);
    u.navbatlar = rows;
  }
  return u;
}

/** Ro'yxat: filtr + sahifalash (FR-USR-01), dekanat — fakultet doirasi */
async function list(actor, f, req) {
  const where = [];
  const p = [];
  const add = (sql, v) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };

  if (actor.role === 'dekanat') {
    const scope = await userScope(actor, req);
    p.push(scope.fakultetId, scope.bolimIds);
    where.push(`u.role <> 'admin' AND (
      (u.role = 'student' AND g.fakultet_id = $1)
      OR EXISTS (SELECT 1 FROM xodim_bolim z WHERE z.user_id = u.id AND z.bolim_id = ANY($2::bigint[])))`);
  }
  if (f.q) {
    p.push(`%${f.q.trim()}%`);
    const i = p.length;
    where.push(`(u.ism ILIKE $${i} OR u.familiya ILIKE $${i} OR u.login ILIKE $${i} OR u.phone ILIKE $${i}
                 OR (u.familiya || ' ' || u.ism) ILIKE $${i})`);
  }
  if (f.role) add('u.role = ?', f.role);
  if (f.status === '1' || f.status === '0') add('u.status = ?', f.status === '1');
  if (f.guruh) add('s.guruh = ?', f.guruh);
  if (f.kurs) add('s.kurs = ?', Number(f.kurs));
  if (f.bolim) add('EXISTS (SELECT 1 FROM xodim_bolim z2 WHERE z2.user_id = u.id AND z2.bolim_id = ?)', Number(f.bolim));

  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = [25, 50, 100].includes(Number(f.size)) ? Number(f.size) : 25;
  const page = Math.max(1, Number(f.page) || 1);
  const { rows: [{ count }] } = await db.query(
    `SELECT count(*)::int AS count FROM users u LEFT JOIN student_info s ON s.user_id = u.id
       LEFT JOIN guruhlar g ON g.nomi = s.guruh ${w}`, p);
  const { rows } = await db.query(
    `${FULL} ${w} ORDER BY u.familiya, u.ism, u.id LIMIT ${size} OFFSET ${(page - 1) * size}`, p);
  return { rows, count, page, size, pages: Math.max(1, Math.ceil(count / size)) };
}

async function saveRoleInfo(c, userId, d) {
  // Rolga tegishli bo'lmagan info qatorlari o'chiriladi
  if (d.role !== 'student') await c.query('DELETE FROM student_info WHERE user_id = $1', [userId]);
  if (d.role !== 'teacher') await c.query('DELETE FROM teacher_info WHERE user_id = $1', [userId]);
  if (d.role !== 'dekanat') await c.query('DELETE FROM dekanat_user_info WHERE user_id = $1', [userId]);
  if (d.role !== 'tyutor') await c.query('DELETE FROM tyutor_guruh WHERE tyutor_id = $1', [userId]);

  if (d.role === 'student') {
    await c.query(
      `INSERT INTO student_info (user_id, guruh, kurs) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET guruh = EXCLUDED.guruh, kurs = EXCLUDED.kurs`,
      [userId, d.guruh, d.kurs]);
  } else if (d.role === 'teacher') {
    await c.query('INSERT INTO teacher_info (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  } else if (d.role === 'dekanat') {
    await c.query(
      `INSERT INTO dekanat_user_info (user_id, lavozim) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET lavozim = EXCLUDED.lavozim`, [userId, d.lavozim]);
  } else if (d.role === 'tyutor') {
    await c.query('DELETE FROM tyutor_guruh WHERE tyutor_id = $1 AND NOT (guruh = ANY($2::varchar[]))', [userId, d.tyutor_guruhlar]);
    for (const g of d.tyutor_guruhlar) {
      await c.query('INSERT INTO tyutor_guruh (tyutor_id, guruh) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, g]);
    }
  }
}

/** Dekanat uchun: guruh/bo'lim fakultet doirasida ekanini tekshirish */
async function checkTargets(actor, d, req) {
  if (actor.role === 'admin') return;
  const scope = await userScope(actor, req);
  if (!scope.fakultetId) throw forbidden('Sizga fakultet biriktirilmagan. Administratorga murojaat qiling.');
  const guruhlar = [d.role === 'student' ? d.guruh : null, ...(d.role === 'tyutor' ? d.tyutor_guruhlar : [])].filter(Boolean);
  if (guruhlar.length) {
    const { rows } = await db.query('SELECT nomi FROM guruhlar WHERE nomi = ANY($1::varchar[]) AND fakultet_id = $2', [guruhlar, scope.fakultetId]);
    if (rows.length !== guruhlar.length) throw forbidden('Guruh sizning fakultetingizga tegishli emas');
  }
  if (d.bolim_id && !scope.bolimIds.includes(d.bolim_id)) throw forbidden('Bo\'lim sizning fakultetingizga tegishli emas');
}

function mapPgError(e) {
  if (e.code === '23505' && /login/.test(e.constraint || '')) return new AppError('Bu login band');
  if (e.code === '23503' && /guruh/.test(e.constraint || '')) return new AppError('Bunday guruh yo\'q');
  if (e.code === '23503' && /bolim/.test(e.constraint || '')) return new AppError('Bo\'lim topilmadi');
  return e;
}

async function create(actor, d, req) {
  if (!rbac.assignableRoles(actor).includes(d.role)) throw forbidden('Bu rolni berishga ruxsatingiz yo\'q');
  await checkTargets(actor, d, req);
  try {
    return await db.tx(async (c) => {
      const { rows: [u] } = await c.query(
        `INSERT INTO users (ism, familiya, ochestva, login, parol, role, phone, parol_almashtirish)
         VALUES ($1,$2,$3,$4,$5,$6,$7, TRUE) RETURNING id`,
        [d.ism, d.familiya, d.ochestva, d.login, await bcrypt.hash(d.parol, 10), d.role, d.phone]);
      await saveRoleInfo(c, u.id, d);
      if (STAFF_ROLES.includes(d.role) && d.bolim_id) {
        await c.query('INSERT INTO xodim_bolim (user_id, bolim_id, lavozim, asosiy) VALUES ($1, $2, $3, TRUE)',
          [u.id, d.bolim_id, d.lavozim]);
      }
      await audit({ client: c, req, amal: 'user.create', obyekt: 'users', obyektId: u.id, yangi: { ...d, parol: undefined } });
      return u.id;
    });
  } catch (e) { throw mapPgError(e); }
}

async function activeAdminCount(q = db, exceptId = 0) {
  const { rows: [{ n }] } = await q.query("SELECT count(*)::int AS n FROM users WHERE role='admin' AND status AND id <> $1", [exceptId]);
  return n;
}

async function update(actor, target, d, req) {
  if (!(await rbac.canManageUser(actor, target, req))) throw forbidden();
  if (d.role !== target.role) {
    if (actor.id === target.id) throw forbidden('O\'z rolingizni o\'zgartira olmaysiz');
    if (!rbac.assignableRoles(actor).includes(d.role)) throw forbidden('Bu rolni berishga ruxsatingiz yo\'q');
    if ((d.role === 'student') !== (target.role === 'student')) {
      throw new AppError('Talaba va xodim rollari o\'rtasida almashtirib bo\'lmaydi — yangi hisob yarating');
    }
    if (target.role === 'admin' && (await activeAdminCount(db, target.id)) === 0) {
      throw new AppError('Oxirgi faol administratorning rolini o\'zgartirib bo\'lmaydi');
    }
  }
  await checkTargets(actor, { ...d, bolim_id: null }, req);
  try {
    await db.tx(async (c) => {
      const hash = d.parol ? await bcrypt.hash(d.parol, 10) : null;
      await c.query(
        `UPDATE users SET ism=$1, familiya=$2, ochestva=$3, login=$4, role=$5, phone=$6,
                parol = COALESCE($7, parol),
                parol_almashtirish = CASE WHEN $7::text IS NOT NULL AND id <> $9 THEN TRUE ELSE parol_almashtirish END
          WHERE id = $8`,
        [d.ism, d.familiya, d.ochestva, d.login, d.role, d.phone, hash, target.id, actor.id]);
      await saveRoleInfo(c, target.id, d);
      if (d.parol) {
        await c.query(`DELETE FROM "session" WHERE (sess->>'userId')::bigint = $1`, [target.id]);
      }
      await audit({
        client: c, req, amal: 'user.update', obyekt: 'users', obyektId: target.id,
        eski: { role: target.role, login: target.login, guruh: target.guruh },
        yangi: { role: d.role, login: d.login, guruh: d.guruh, parol_tiklandi: !!d.parol },
      });
    });
  } catch (e) { throw mapPgError(e); }
}

/** Bloklash/faollashtirish (K-11, FR-USR-06, Q21) */
async function setStatus(actor, target, status, req) {
  if (actor.id === target.id) throw forbidden('O\'zingizni bloklay olmaysiz');
  if (!(await rbac.canManageUser(actor, target, req))) throw forbidden();
  if (!status && target.role === 'admin' && (await activeAdminCount(db, target.id)) === 0) {
    throw new AppError('Oxirgi faol administratorni bloklab bo\'lmaydi');
  }
  return db.tx(async (c) => {
    await c.query('UPDATE users SET status = $1 WHERE id = $2', [status, target.id]);
    let bekor = 0;
    if (!status) {
      await c.query(`DELETE FROM "session" WHERE (sess->>'userId')::bigint = $1`, [target.id]);
      // Kelgusi faol navbatlar bekor qilinadi
      const izoh = target.role === 'student' ? 'Hisob bloklangan' : 'Xodim qabul qilmaydi (hisob bloklangan)';
      const { rows } = await c.query(
        `UPDATE navbatlar n SET status = 'bekor_qilindi', javob_izoh = $2, ozgartirgan_id = $3
           FROM qabul_vaqti q
          WHERE q.id = n.qabul_vaqti_id AND n.status IN ('kutilmoqda','tasdiqlandi') AND n.sana >= $4
            AND (n.student_id = $1 OR q.xodim_id = $1)
        RETURNING n.id, n.student_id, n.sana`, [target.id, izoh, actor.id, today()]);
      for (const r of rows) {
        await c.query(`INSERT INTO navbat_tarix (navbat_id, eski_status, yangi_status, user_id, izoh)
                       VALUES ($1, NULL, 'bekor_qilindi', $2, $3)`, [r.id, actor.id, izoh]);
        if (r.student_id !== target.id) await notify(c, r.student_id, `Navbatingiz bekor qilindi: ${izoh}.`);
      }
      bekor = rows.length;
    }
    await audit({ client: c, req, amal: status ? 'user.unblock' : 'user.block', obyekt: 'users', obyektId: target.id, yangi: { bekor_qilingan_navbatlar: bekor } });
    return bekor;
  });
}

/** O'chirish: faqat admin; navbatlari yoki shablonlari bo'lsa — faqat bloklash (FR-USR-05) */
async function remove(actor, target, req) {
  if (actor.role !== 'admin') throw forbidden('O\'chirish faqat administrator uchun. Foydalanuvchini bloklang.');
  if (actor.id === target.id) throw forbidden('O\'zingizni o\'chira olmaysiz');
  if (target.role === 'admin' && (await activeAdminCount(db, target.id)) === 0) throw new AppError('Oxirgi administratorni o\'chirib bo\'lmaydi');
  const { rows: [r] } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM navbatlar WHERE student_id = $1) OR EXISTS (SELECT 1 FROM qabul_vaqti WHERE xodim_id = $1) AS bor`, [target.id]);
  if (r.bor) throw new AppError('Foydalanuvchining navbatlar yoki qabul jadvali tarixi bor — o\'chirish o\'rniga bloklang');
  await db.tx(async (c) => {
    await c.query('DELETE FROM users WHERE id = $1', [target.id]);
    await audit({ client: c, req, amal: 'user.delete', obyekt: 'users', obyektId: target.id, eski: { login: target.login, role: target.role } });
  });
}

// ---- Xodim <-> bo'lim (M5) ---------------------------------------------
async function addBolim(actor, target, { bolim_id, lavozim, asosiy }, req) {
  if (!STAFF_ROLES.includes(target.role)) throw new AppError('Faqat xodimlarni bo\'limga biriktirish mumkin');
  if (!(await rbac.canManageUser(actor, target, req))) throw forbidden();
  if (!(await rbac.canUseBolim(actor, bolim_id, req))) throw forbidden('Bo\'lim sizning doirangizda emas');
  try {
    await db.tx(async (c) => {
      if (asosiy) await c.query('UPDATE xodim_bolim SET asosiy = FALSE WHERE user_id = $1', [target.id]);
      const { rows: [has] } = await c.query('SELECT 1 FROM xodim_bolim WHERE user_id = $1 AND asosiy', [target.id]);
      await c.query(
        `INSERT INTO xodim_bolim (user_id, bolim_id, lavozim, asosiy) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, bolim_id) DO UPDATE SET lavozim = EXCLUDED.lavozim, asosiy = EXCLUDED.asosiy`,
        [target.id, bolim_id, lavozim || null, asosiy || !has]);
      await audit({ client: c, req, amal: 'xodim_bolim.set', obyekt: 'users', obyektId: target.id, yangi: { bolim_id, lavozim, asosiy } });
    });
  } catch (e) {
    if (e.code === '23503') throw new AppError('Bo\'lim topilmadi');
    throw e;
  }
}

async function removeBolim(actor, target, xbId, req) {
  if (!(await rbac.canManageUser(actor, target, req))) throw forbidden();
  const { rows: [xb] } = await db.query('SELECT * FROM xodim_bolim WHERE id = $1 AND user_id = $2', [xbId, target.id]);
  if (!xb) throw notFound();
  if (!(await rbac.canUseBolim(actor, xb.bolim_id, req))) throw forbidden();
  const { rows: [q] } = await db.query('SELECT count(*)::int AS n FROM qabul_vaqti WHERE xodim_id = $1 AND bolim_id = $2', [target.id, xb.bolim_id]);
  if (q.n) throw new AppError('Bu bo\'lim nomidan qabul vaqtlari bor — avval ularni o\'chiring yoki nofaol qiling (FR-XB-03)');
  if (xb.asosiy) {
    const { rows: [o] } = await db.query('SELECT count(*)::int AS n FROM xodim_bolim WHERE user_id = $1', [target.id]);
    if (o.n > 1) throw new AppError('Asosiy bo\'limni olib tashlashdan oldin boshqa bo\'limni asosiy qiling');
  }
  await db.query('DELETE FROM xodim_bolim WHERE id = $1', [xbId]);
  await audit({ req, amal: 'xodim_bolim.delete', obyekt: 'users', obyektId: target.id, eski: xb });
}

module.exports = {
  normalizePhone, parse, find, profile, list, create, update, setStatus, remove, addBolim, removeBolim,
};
