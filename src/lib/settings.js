// Tizim sozlamalari (M17) — kalit/qiymat, qisqa muddatli kesh bilan
const db = require('../db/pool');

const DEFAULTS = {
  yozilish_oynasi_kun: 14,
  bugun_yopilish_daq: 30,
  max_faol_bron: 3,
  bekor_muddati_soat: 1,
  tasdiqlash_rejimi: 'avto',
  kelmadi_jazo: false,
  kelmadi_chegara: 3,
  kelmadi_davr_kun: 30,
  kelmadi_taqiq_kun: 7,
};

let cache = null;
let cachedAt = 0;

async function getSettings(q = db) {
  if (cache && Date.now() - cachedAt < 30_000) return cache;
  const { rows } = await q.query('SELECT kalit, qiymat FROM sozlamalar');
  const s = { ...DEFAULTS };
  for (const r of rows) s[r.kalit] = r.qiymat;
  cache = s;
  cachedAt = Date.now();
  return s;
}

async function saveSettings(values) {
  await db.tx(async (c) => {
    for (const [k, v] of Object.entries(values)) {
      if (!(k in DEFAULTS)) continue;
      await c.query(
        `INSERT INTO sozlamalar (kalit, qiymat) VALUES ($1, $2::jsonb)
         ON CONFLICT (kalit) DO UPDATE SET qiymat = EXCLUDED.qiymat`,
        [k, JSON.stringify(v)],
      );
    }
  });
  cache = null;
}

const resetSettingsCache = () => { cache = null; };

module.exports = { getSettings, saveSettings, resetSettingsCache, DEFAULTS };
