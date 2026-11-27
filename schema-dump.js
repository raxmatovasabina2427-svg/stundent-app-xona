// Bazaning tuzilishini o'qiydi (faqat SELECT, hech narsa o'zgarmaydi) va schema-dump.txt ga yozadi.
// Ishlatish:  node schema-dump.js
// Parol va shaxsiy ma'lumotlar yozilmaydi — faqat jadval/ustun/cheklov nomlari, qator soni
// va rol/kun kabi qisqa qiymatlar ro'yxati.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { Client } = require('pg');

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  const out = [];
  const p = (s = '') => out.push(s);

  const { rows: [v] } = await c.query('SHOW server_version');
  p(`PostgreSQL ${v.server_version}`);
  const { rows: ext } = await c.query('SELECT extname FROM pg_extension ORDER BY 1');
  p(`Extensions: ${ext.map((e) => e.extname).join(', ')}`);
  const { rows: types } = await c.query(
    `SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace LEFT JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname = 'public' AND t.typtype IN ('e','r','d') GROUP BY 1`);
  for (const t of types) p(`Type: ${t.typname} ${t.labels || ''}`);

  const { rows: tables } = await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1");

  for (const { table_name: t } of tables) {
    const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM public."${t}"`);
    p(); p(`=== ${t}  (${n} qator)`);
    const { rows: cols } = await c.query(
      `SELECT column_name, data_type, udt_name, character_maximum_length AS len, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t]);
    for (const col of cols) {
      const type = col.data_type === 'USER-DEFINED' || col.data_type === 'ARRAY' ? col.udt_name : col.data_type;
      p(`  ${col.column_name}: ${type}${col.len ? `(${col.len})` : ''}${col.is_nullable === 'NO' ? ' NOT NULL' : ''}${col.column_default ? ` DEFAULT ${col.column_default}` : ''}`);
    }
    const { rows: cons } = await c.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = format('public.%I', $1::text)::regclass ORDER BY contype, conname`, [t]);
    for (const k of cons) p(`  [C] ${k.conname}: ${k.def}`);
    const { rows: idx } = await c.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1
          AND indexname NOT IN (SELECT conname FROM pg_constraint) ORDER BY 1`, [t]);
    for (const i of idx) p(`  [I] ${i.indexdef}`);
    const { rows: trg } = await c.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = format('public.%I', $1::text)::regclass AND NOT tgisinternal`, [t]);
    for (const g of trg) p(`  [T] ${g.tgname}`);

    // Kod/holat ustunlarining takrorlanmas qiymatlari (shaxsiy ma'lumot emas)
    for (const col of cols.filter((x) => /^(role|status|turi|week_date|hafta_kuni|holat|format|lavozim|kurs)$/.test(x.column_name))) {
      const { rows: vals } = await c.query(
        `SELECT "${col.column_name}"::text AS v, count(*)::int AS n FROM public."${t}" GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
      p(`  [V] ${col.column_name}: ${vals.map((x) => `${x.v ?? 'NULL'}×${x.n}`).join(', ')}`);
    }
  }

  // Login dublikatlari (katta-kichik harf bo'yicha) — yangi UNIQUE indeks uchun muhim
  if (tables.some((t) => t.table_name === 'users')) {
    const { rows: [d] } = await c.query(
      'SELECT count(*)::int AS n FROM (SELECT lower(login) FROM users GROUP BY 1 HAVING count(*) > 1) x');
    p(); p(`users: lower(login) dublikatlari: ${d.n}`);
    const { rows: [h] } = await c.query("SELECT count(*) FILTER (WHERE parol LIKE '$2%')::int AS bcrypt, count(*)::int AS jami FROM users");
    p(`users: bcrypt parollar ${h.bcrypt} / ${h.jami}`);
  }

  await c.end();
  fs.writeFileSync('schema-dump.txt', out.join('\n') + '\n');
  console.log(`✓ schema-dump.txt yozildi (${tables.length} ta jadval). Shu faylni chatga yuboring.`);
})().catch((e) => {
  console.error('Xato:', e.message);
  process.exit(1);
});
