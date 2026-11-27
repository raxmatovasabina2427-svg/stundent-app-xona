// Audit jurnali (M16): kim, qachon, nima, eski -> yangi
const db = require('../db/pool');

/**
 * @param {object} p
 * @param {import('pg').PoolClient} [p.client] tranzaksiya ichida bo'lsa
 */
async function audit({ client, req, userId, amal, obyekt = null, obyektId = null, eski = null, yangi = null }) {
  const q = client || db;
  const uid = userId !== undefined ? userId : req?.user?.id ?? null;
  const ip = req?.ip ? req.ip.replace(/^::ffff:/, '') : null;
  try {
    await q.query(
      `INSERT INTO audit_log (user_id, amal, obyekt, obyekt_id, eski, yangi, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uid, amal, obyekt, obyektId, eski && JSON.stringify(strip(eski)), yangi && JSON.stringify(strip(yangi)), ip],
    );
  } catch (e) {
    if (client) throw e; // tranzaksiya ichida xato — tranzaksiya bekor bo'lsin
    console.error('audit xatosi:', e.message);
  }
}

// Parol hash hech qachon jurnalga tushmaydi
function strip(o) {
  if (!o || typeof o !== 'object') return o;
  const rest = { ...o };
  delete rest.parol;
  return rest;
}

module.exports = { audit };
