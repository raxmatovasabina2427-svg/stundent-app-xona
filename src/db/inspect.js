// Bazaning hozirgi tuzilmasini ko'rsatadi (faqat o'qiydi, hech narsani o'zgartirmaydi).
// Ishga tushirish: npm run inspect   → natija: db-tuzilma.txt
const fs = require('node:fs');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');

(async () => {
  const ssl = ['true', '1'].includes(process.env.DB_SSL) ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl });
  await c.connect();
  const out = [];
  const p = (s = '') => out.push(s);

  const { rows: [v] } = await c.query('SHOW server_version');
  p(`PostgreSQL ${v.server_version}`);
  const { rows: ext } = await c.query('SELECT extname FROM pg_extension ORDER BY 1');
  p(`Extensions: ${ext.map((r) => r.extname).join(', ')}`);

  const { rows: tables } = await c.query(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY 1, 2`);
  for (const t of tables) {
    const fq = `"${t.table_schema}"."${t.table_name}"`;
    const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM ${fq}`);
    p(`\n=== ${t.table_schema}.${t.table_name}  (${n} qator)`);
    const { rows: cols } = await c.query(
      `SELECT column_name, data_type, character_maximum_length AS len, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [t.table_schema, t.table_name]);
    for (const col of cols) {
      p(`  ${col.column_name}  ${col.data_type}${col.len ? `(${col.len})` : ''}${col.is_nullable === 'NO' ? ' NOT NULL' : ''}${col.column_default ? ` DEFAULT ${col.column_default}` : ''}`);
    }
    const { rows: cons } = await c.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = $1::regclass ORDER BY contype, conname`, [fq]);
    for (const k of cons) p(`  [${k.conname}] ${k.def}`);
    const { rows: idx } = await c.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
      [t.table_schema, t.table_name]);
    for (const i of idx) p(`  ${i.indexdef}`);
  }

  // Qiymatlar formatini bilish uchun (parollarsiz)
  const sample = async (sql, title) => {
    try { const { rows } = await c.query(sql); p(`\n--- ${title}`); for (const r of rows) p('  ' + JSON.stringify(r)); } catch { /* jadval yo'q */ }
  };
  await sample('SELECT role, count(*)::int FROM users GROUP BY 1 ORDER BY 1', 'users.role');
  await sample('SELECT DISTINCT guruh FROM student_info ORDER BY 1 LIMIT 30', 'student_info.guruh');
  await sample('SELECT * FROM qabul_vaqti LIMIT 5', 'qabul_vaqti namuna');
  await sample('SELECT DISTINCT lavozim FROM dekanat_user_info LIMIT 20', 'dekanat_user_info.lavozim');
  await sample('SELECT * FROM bolimlar LIMIT 20', 'bolimlar namuna');

  await c.end();
  fs.writeFileSync('db-tuzilma.txt', out.join('\n') + '\n');
  console.log(`Tayyor: db-tuzilma.txt (${tables.length} ta jadval). Parollar va .env yozilmagan.`);
})().catch((e) => { console.error('Xato:', e.message); process.exitCode = 1; });
