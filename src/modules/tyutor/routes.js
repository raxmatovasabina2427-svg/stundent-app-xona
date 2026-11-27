// M13: tyutor paneli — guruhlar, talabalar, ularning navbatlari (ko'rish)
const express = require('express');
const db = require('../../db/pool');
const { ah, forbidden } = require('../../lib/http');
const { requireRole } = require('../../middleware/rbac');
const { today } = require('../../lib/time');

const router = express.Router();
router.use('/tyutor', requireRole('tyutor'));

router.get('/tyutor', ah(async (req, res) => {
  const { rows: guruhlar } = await db.query(
    `SELECT tg.guruh, g.kurs, b.nomi AS fakultet,
            (SELECT count(*)::int FROM student_info s JOIN users u ON u.id = s.user_id AND u.status WHERE s.guruh = tg.guruh) AS talabalar,
            (SELECT count(*)::int FROM navbatlar n JOIN student_info s ON s.user_id = n.student_id
              WHERE s.guruh = tg.guruh AND n.sana >= $2 AND n.status IN ('kutilmoqda','tasdiqlandi')) AS kelgusi
       FROM tyutor_guruh tg JOIN guruhlar g ON g.nomi = tg.guruh JOIN bolimlar b ON b.id = g.fakultet_id
      WHERE tg.tyutor_id = $1 ORDER BY tg.guruh`, [req.user.id, today()]);
  res.render('tyutor/index', { title: 'Guruhlarim', guruhlar });
}));

router.get('/tyutor/guruh/:guruh', ah(async (req, res) => {
  const guruh = String(req.params.guruh);
  const { rows: [ok] } = await db.query('SELECT 1 FROM tyutor_guruh WHERE tyutor_id = $1 AND guruh = $2', [req.user.id, guruh]);
  if (!ok) throw forbidden();
  const [{ rows: talabalar }, { rows: navbatlar }] = await Promise.all([
    db.query(`SELECT u.id, u.familiya, u.ism, u.ochestva, u.phone, u.status, s.kurs, (s.tg_user IS NOT NULL) AS telegram
                FROM student_info s JOIN users u ON u.id = s.user_id WHERE s.guruh = $1 ORDER BY u.familiya, u.ism`, [guruh]),
    db.query(`SELECT n.id, n.sana, n.boshlanish, n.tugash, n.navbat_raqami, n.status, u.familiya, u.ism,
                     b.nomi AS bolim, x.familiya AS x_familiya, x.ism AS x_ism, mt.nomi AS murojaat
                FROM navbatlar n JOIN student_info s ON s.user_id = n.student_id JOIN users u ON u.id = n.student_id
                JOIN qabul_vaqti q ON q.id = n.qabul_vaqti_id JOIN bolimlar b ON b.id = q.bolim_id
                JOIN users x ON x.id = q.xodim_id LEFT JOIN murojaat_turlari mt ON mt.id = n.murojaat_turi_id
               WHERE s.guruh = $1 AND n.sana >= $2::date - 30
               ORDER BY n.sana DESC, n.boshlanish NULLS LAST LIMIT 200`, [guruh, today()]),
  ]);
  res.render('tyutor/guruh', { title: `${guruh} guruhi`, guruh, talabalar, navbatlar });
}));

module.exports = router;
