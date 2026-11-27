// Rejalashtirilgan ishlar: Render Cron Job yoki tashqi scheduler chaqiradi
//   curl -X POST -H "X-Cron-Secret: $CRON_SECRET" https://.../internal/cron/kelmadi
const express = require('express');
const crypto = require('node:crypto');
const env = require('../../config/env');
const { autoKelmadi } = require('../navbat/status');

const router = express.Router();

router.use((req, res, next) => {
  const got = Buffer.from(String(req.get('X-Cron-Secret') || ''));
  const want = Buffer.from(String(env.CRON_SECRET || ''));
  if (!env.CRON_SECRET || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return res.status(401).json({ ok: false });
  }
  next();
});

// BR-07: qabul tugagach hali faol bronlar -> "kelmadi" (har 15 daqiqada)
router.post('/kelmadi', async (req, res, next) => {
  try { res.json({ ok: true, yangilandi: await autoKelmadi() }); } catch (e) { next(e); }
});

// Eskirgan Telegram tokenlarini tozalash
router.post('/tozalash', async (req, res, next) => {
  try {
    const db = require('../../db/pool');
    const { rowCount } = await db.query('DELETE FROM tg_link_tokens WHERE expires_at < now()');
    res.json({ ok: true, ochirildi: rowCount });
  } catch (e) { next(e); }
});

module.exports = router;
