// Formalar uchun ro'yxatlar (rol doirasiga qarab)
const db = require('../db/pool');
const { userScope } = require('./scope');

/** Bo'limlar daraxti tekis ro'yxat ko'rinishida (chuqurlik bilan), doira bo'yicha filtr */
async function bolimTree({ onlyIds = null, onlyActive = false } = {}) {
  const { rows } = await db.query(
    `WITH RECURSIVE t AS (
       SELECT id, nomi, turi, parent_id, xona, status, 0 AS depth, ARRAY[nomi::text] AS yol
         FROM bolimlar WHERE parent_id IS NULL
       UNION ALL
       SELECT b.id, b.nomi, b.turi, b.parent_id, b.xona, b.status, t.depth + 1, t.yol || b.nomi::text
         FROM bolimlar b JOIN t ON b.parent_id = t.id WHERE t.depth < 20
     ) SELECT * FROM t ORDER BY yol`);
  return rows
    .filter((r) => (!onlyIds || onlyIds.includes(r.id)) && (!onlyActive || r.status))
    .map((r) => ({ ...r, label: `${'— '.repeat(r.depth)}${r.nomi}` }));
}

/** Foydalanuvchi boshqara oladigan bo'limlar */
async function managedBolimlar(actor, req) {
  if (actor.role === 'admin') return bolimTree();
  if (actor.role === 'dekanat') return bolimTree({ onlyIds: (await userScope(actor, req)).bolimIds });
  return [];
}

/** Foydalanuvchi boshqara oladigan guruhlar */
async function managedGuruhlar(actor, req) {
  if (actor.role === 'admin') {
    return (await db.query('SELECT g.*, b.nomi AS fakultet FROM guruhlar g JOIN bolimlar b ON b.id = g.fakultet_id ORDER BY g.nomi')).rows;
  }
  const scope = await userScope(actor, req);
  return (await db.query(
    'SELECT g.*, b.nomi AS fakultet FROM guruhlar g JOIN bolimlar b ON b.id = g.fakultet_id WHERE g.fakultet_id = $1 ORDER BY g.nomi',
    [scope.fakultetId])).rows;
}

async function fakultetlar(actor, req) {
  if (actor.role === 'admin') return (await db.query("SELECT id, nomi FROM bolimlar WHERE turi = 'fakultet' ORDER BY nomi")).rows;
  const scope = await userScope(actor, req);
  return (await db.query('SELECT id, nomi FROM bolimlar WHERE id = $1', [scope.fakultetId])).rows;
}

module.exports = { bolimTree, managedBolimlar, managedGuruhlar, fakultetlar };
