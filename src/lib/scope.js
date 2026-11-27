// Ruxsat doirasi (4.1): "o'z fakulteti" = asosiy bo'limdan yuqoridagi fakultet va uning avlodlari
const db = require('../db/pool');

const STAFF_ROLES = ['dekanat', 'teacher', 'tyutor', 'xodim'];  // qabul qiluvchilar
const ALL_ROLES = ['admin', 'dekanat', 'teacher', 'tyutor', 'xodim', 'student'];

/** Bo'lim (yoki unga ota bo'lgan) fakultet ID si */
async function fakultetOfBolim(bolimId, q = db) {
  const { rows } = await q.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, turi, 0 AS d FROM bolimlar WHERE id = $1
       UNION ALL
       SELECT b.id, b.parent_id, b.turi, up.d + 1 FROM bolimlar b JOIN up ON b.id = up.parent_id WHERE up.d < 50
     ) SELECT id FROM up WHERE turi = 'fakultet' ORDER BY d LIMIT 1`,
    [bolimId],
  );
  return rows[0]?.id ?? null;
}

/** Bo'lim va uning barcha avlodlari */
async function subtree(rootId, q = db) {
  const { rows } = await q.query(
    `WITH RECURSIVE down AS (
       SELECT id, 0 AS d FROM bolimlar WHERE id = $1
       UNION ALL
       SELECT b.id, down.d + 1 FROM bolimlar b JOIN down ON b.parent_id = down.id WHERE down.d < 50
     ) SELECT id FROM down`,
    [rootId],
  );
  return rows.map((r) => r.id);
}

/**
 * Foydalanuvchining fakultet doirasi: { fakultetId, bolimIds: number[] }.
 * Fakultet topilmasa — bo'sh doira. Natija so'rov davomida keshlanadi (req.scope).
 */
async function userScope(user, req) {
  if (req && req._scope) return req._scope;
  let scope = { fakultetId: null, bolimIds: [] };
  const { rows } = await db.query('SELECT bolim_id FROM xodim_bolim WHERE user_id = $1 AND asosiy', [user.id]);
  if (rows[0]) {
    const f = await fakultetOfBolim(rows[0].bolim_id);
    if (f) scope = { fakultetId: f, bolimIds: await subtree(f) };
  }
  if (req) req._scope = scope;
  return scope;
}

/** Foydalanuvchi (target) dekanat doirasidami? */
async function userInScope(target, scope, q = db) {
  if (!scope.fakultetId) return false;
  if (target.role === 'student') {
    const { rows } = await q.query(
      `SELECT 1 FROM student_info s JOIN guruhlar g ON g.nomi = s.guruh
        WHERE s.user_id = $1 AND g.fakultet_id = $2`, [target.id, scope.fakultetId]);
    return rows.length > 0;
  }
  const { rows } = await q.query(
    'SELECT 1 FROM xodim_bolim WHERE user_id = $1 AND bolim_id = ANY($2::bigint[]) LIMIT 1',
    [target.id, scope.bolimIds],
  );
  return rows.length > 0;
}

module.exports = { STAFF_ROLES, ALL_ROLES, fakultetOfBolim, subtree, userScope, userInScope };
