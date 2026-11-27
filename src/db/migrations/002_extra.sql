-- =====================================================================
-- 002_extra — sessiyalar, audit, holatlar tarixi, sozlamalar, bayramlar,
-- outbox va Telegram tokenlari (T-04, T-08…T-12). v1 bazada ham xavfsiz.
-- =====================================================================

-- Sessiyalar (connect-pg-simple), K-03
CREATE TABLE IF NOT EXISTS "session" (
  sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" (expire);

-- Audit jurnali (M16)
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  amal       VARCHAR(50) NOT NULL,
  obyekt     VARCHAR(50),
  obyekt_id  BIGINT,
  eski       JSONB,
  yangi      JSONB,
  ip         INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_obyekt ON audit_log (obyekt, obyekt_id);
CREATE INDEX IF NOT EXISTS ix_audit_vaqt   ON audit_log (created_at DESC);

-- Navbat holatlari tarixi (T-04)
CREATE TABLE IF NOT EXISTS navbat_tarix (
  id           BIGSERIAL PRIMARY KEY,
  navbat_id    BIGINT NOT NULL REFERENCES navbatlar(id) ON DELETE CASCADE,
  eski_status  VARCHAR(20),
  yangi_status VARCHAR(20) NOT NULL,
  user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,   -- NULL = tizim
  izoh         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_navbat_tarix ON navbat_tarix (navbat_id, created_at);

-- Global bayramlar (T-08)
CREATE TABLE IF NOT EXISTS bayramlar (
  sana  DATE PRIMARY KEY,
  nomi  VARCHAR(150) NOT NULL
);

-- Tizim sozlamalari (T-09)
CREATE TABLE IF NOT EXISTS sozlamalar (
  kalit  VARCHAR(60) PRIMARY KEY,
  qiymat JSONB NOT NULL
);
INSERT INTO sozlamalar (kalit, qiymat) VALUES
  ('yozilish_oynasi_kun',  '14'),       -- BR-01
  ('bugun_yopilish_daq',   '30'),       -- BR-02
  ('max_faol_bron',        '3'),        -- BR-03
  ('bekor_muddati_soat',   '1'),        -- BR-05
  ('tasdiqlash_rejimi',    '"avto"'),   -- BR-06: "avto" | "qolda"
  ('kelmadi_jazo',         'false'),    -- BR-08
  ('kelmadi_chegara',      '3'),
  ('kelmadi_davr_kun',     '30'),
  ('kelmadi_taqiq_kun',    '7')
ON CONFLICT (kalit) DO NOTHING;

-- Bildirishnomalar outbox (T-10). v1 (16-okt) dagi bildirishnomalar boshqa
-- tuzilishda — o'chirilmaydi, bildirishnomalar_v1 nomi bilan saqlanadi.
DO $$ BEGIN
  IF to_regclass('public.bildirishnomalar') IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bildirishnomalar' AND column_name = 'holat') THEN
    ALTER TABLE bildirishnomalar RENAME TO bildirishnomalar_v1;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS bildirishnomalar (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  matn            TEXT   NOT NULL,
  holat           VARCHAR(10) NOT NULL DEFAULT 'kutmoqda' CHECK (holat IN ('kutmoqda','yuborildi','xato')),
  urinishlar      SMALLINT NOT NULL DEFAULT 0,
  keyingi_urinish TIMESTAMPTZ NOT NULL DEFAULT now(),
  xato            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  yuborilgan      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_outbox_navbat ON bildirishnomalar (keyingi_urinish) WHERE holat = 'kutmoqda';

-- Telegram ulash tokenlari (T-12)
CREATE TABLE IF NOT EXISTS tg_link_tokens (
  token      VARCHAR(64) PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
