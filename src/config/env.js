// Muhit o'zgaruvchilarini o'qish va tekshirish (K-19, 14.3-bo'lim)
require('dotenv').config({ quiet: true });
const { z } = require('zod');

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL kerak'),
  DB_SSL: bool,
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET kamida 16 belgi bo\'lsin'),
  APP_URL: z.string().default('http://localhost:3000'),
  CRON_SECRET: z.string().optional(),
  ADMIN_LOGIN: z.string().optional(),
  ADMIN_PAROL: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Muhit sozlamalarida xato (.env):');
  for (const i of parsed.error.issues) console.error(`  ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}

module.exports = { ...parsed.data, isProd: parsed.data.NODE_ENV === 'production', TZ: 'Asia/Tashkent' };
