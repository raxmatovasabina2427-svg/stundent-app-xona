// FR-AUTH-10: rolga mos bosh sahifa; dekanat/admin paneli
const express = require('express');
const db = require('../../db/pool');
const { ah } = require('../../lib/http');
const { requireRole } = require('../../middleware/rbac');
const { userScope } = require('../../lib/scope');
const { today } = require('../../lib/time');

const router = express.Router();

router.get('/', (req, res) => {
  const r = req.user.role;
  if (r === 'student') return res.redirect('/talaba');
  if (r === 'admin' || r === 'dekanat') return res.redirect('/panel');
  if (r === 'tyutor') return res.redirect('/tyutor');
  return res.redirect('/xodim/bugun');
});

router.get('/talaba', requireRole('student'), ah(async (req, res) => {
  const { rows } = await db.query(
    `SELECT n.*, q.start_time, q.end_time, b.nomi AS bolim, b.xona, x.familiya AS x_familiya, x.ism AS x_ism, mt.nomi AS murojaat
       FROM navbatlar n JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id JOIN bolimlar b ON b.id = q.bolim_id
       JOIN users x ON x.id = q.xodim_id LEFT JOIN murojaat_turlari mt ON mt.id = n.murojaat_turi_id
      WHERE n.student_id = $1 AND n.sana >= $2 AND n.status IN ('kutilmoqda','tasdiqlandi')
      ORDER BY n.sana, n.boshlanish NULLS LAST LIMIT 3`, [req.user.id, today()]);
  const { rows: [si] } = await db.query('SELECT guruh, kurs FROM student_info WHERE user_id = $1', [req.user.id]);
  res.render('home/talaba', { title: 'Bosh sahifa', kelgusi: rows, si });
}));

router.get('/panel', requireRole('admin', 'dekanat'), ah(async (req, res) => {
  const bugun = today();
  let ids = null;
  if (req.user.role === 'dekanat') ids = (await userScope(req.user, req)).bolimIds;
  const p = [bugun, ids];
  const scopeSql = '($2::bigint[] IS NULL OR q.bolim_id = ANY($2))';
  const [{ rows: [stat] }, { rows: band }, { rows: [cnt] }, { rows: jadvalsiz }] = await Promise.all([
    db.query(`SELECT count(*)::int AS jami,
                     count(*) FILTER (WHERE n.status = 'qabul_qilindi')::int AS qabul,
                     count(*) FILTER (WHERE n.status = 'kelmadi')::int AS kelmadi,
                     count(*) FILTER (WHERE n.status IN ('kutilmoqda','tasdiqlandi'))::int AS kutilmoqda,
                     count(*) FILTER (WHERE n.status = 'bekor_qilindi')::int AS bekor
                FROM navbatlar n JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id
               WHERE n.sana = $1 AND ${scopeSql}`, p),
    db.query(`SELECT u.id, u.familiya, u.ism, b.nomi AS bolim, count(*)::int AS n
                FROM navbatlar n JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id JOIN users u ON u.id = q.xodim_id
                JOIN bolimlar b ON b.id = q.bolim_id
               WHERE n.sana = $1 AND n.status <> 'bekor_qilindi' AND ${scopeSql}
               GROUP BY u.id, b.nomi ORDER BY n DESC LIMIT 5`, p),
    db.query(`SELECT
                (SELECT count(*)::int FROM users u LEFT JOIN student_info s ON s.user_id = u.id LEFT JOIN guruhlar g ON g.nomi = s.guruh
                  WHERE u.role = 'student' AND u.status AND ($1::bigint IS NULL OR g.fakultet_id = $1)) AS talabalar,
                (SELECT count(DISTINCT u.id)::int FROM users u JOIN xodim_bolim xb ON xb.user_id = u.id
                  WHERE u.status AND ($2::bigint[] IS NULL OR xb.bolim_id = ANY($2))) AS xodimlar,
                (SELECT count(*)::int FROM navbatlar n JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id
                  WHERE n.sana > $3 AND n.status IN ('kutilmoqda','tasdiqlandi') AND ($2::bigint[] IS NULL OR q.bolim_id = ANY($2))) AS kelgusi`,
    [req.user.role === 'dekanat' ? (await userScope(req.user, req)).fakultetId : null, ids, bugun]),
    // "Jadvali yo'q xodimlar" (17-bo'lim xavflari)
    db.query(`SELECT DISTINCT u.id, u.familiya, u.ism, u.role FROM users u JOIN xodim_bolim xb ON xb.user_id = u.id
               WHERE u.status AND u.role IN ('dekanat','teacher','tyutor','xodim')
                 AND ($1::bigint[] IS NULL OR xb.bolim_id = ANY($1))
                 AND NOT EXISTS (SELECT 1 FROM qabul_vaqti q WHERE q.xodim_id = u.id AND q.status)
               ORDER BY u.familiya LIMIT 20`, [ids]),
  ]);
  const scope = req.user.role === 'dekanat' ? await userScope(req.user, req) : null;
  const fakultet = scope?.fakultetId ? (await db.query('SELECT nomi FROM bolimlar WHERE id = $1', [scope.fakultetId])).rows[0]?.nomi : null;
  res.render('home/panel', {
    title: 'Panel', stat, band, cnt, jadvalsiz, fakultet,
    noScope: req.user.role === 'dekanat' && !scope?.fakultetId, bugun,
  });
}));

module.exports = router;
