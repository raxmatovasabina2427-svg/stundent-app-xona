CREATE TABLE IF NOT EXISTS xona_bron_resurslar (
  id BIGSERIAL PRIMARY KEY,
  nomi VARCHAR(120) NOT NULL,
  turi VARCHAR(20) NOT NULL CHECK (turi IN ('kompyuter','laboratoriya','maruza')),
  bino VARCHAR(100) NOT NULL DEFAULT '',
  qavat INTEGER NOT NULL DEFAULT 0 CHECK (qavat >= 0),
  xona_raqami VARCHAR(30) NOT NULL DEFAULT '',
  sigim INTEGER NOT NULL CHECK (sigim > 0),
  jihozlar TEXT NOT NULL DEFAULT '',
  ish_boshlanish TIME NOT NULL DEFAULT '08:00',
  ish_tugash TIME NOT NULL DEFAULT '20:00',
  masul_bolim_id BIGINT REFERENCES bolimlar(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'faol' CHECK (status IN ('faol','faol_emas')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT xona_bron_resurs_vaqt_ck CHECK (ish_boshlanish < ish_tugash)
);

CREATE INDEX IF NOT EXISTS ix_xona_bron_resurs_turi_status ON xona_bron_resurslar(turi,status);
CREATE INDEX IF NOT EXISTS ix_xona_bron_resurs_bolim ON xona_bron_resurslar(masul_bolim_id);

CREATE TABLE IF NOT EXISTS xona_bronlar (
  id BIGSERIAL PRIMARY KEY,
  resurs_id BIGINT NOT NULL REFERENCES xona_bron_resurslar(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sana DATE NOT NULL,
  boshlanish TIME NOT NULL,
  tugash TIME NOT NULL,
  odam_soni INTEGER NOT NULL DEFAULT 1 CHECK (odam_soni > 0),
  sabab VARCHAR(500) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'kutilmoqda' CHECK (status IN ('kutilmoqda','tasdiqlandi','rad_etildi','bekor_qilindi','yakunlandi')),
  javob_izoh VARCHAR(500),
  tasdiqlovchi_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT xona_bronlar_vaqt_ck CHECK (boshlanish < tugash)
);

CREATE INDEX IF NOT EXISTS ix_xona_bronlar_resurs_sana ON xona_bronlar(resurs_id,sana,boshlanish);
CREATE INDEX IF NOT EXISTS ix_xona_bronlar_user_sana ON xona_bronlar(user_id,sana DESC);
CREATE INDEX IF NOT EXISTS ix_xona_bronlar_status_sana ON xona_bronlar(status,sana);

CREATE TABLE IF NOT EXISTS xona_bron_tarix (
  id BIGSERIAL PRIMARY KEY,
  bron_id BIGINT NOT NULL REFERENCES xona_bronlar(id) ON DELETE RESTRICT,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  eski_status VARCHAR(20),
  yangi_status VARCHAR(20) NOT NULL,
  izoh VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_xona_bron_tarix_bron ON xona_bron_tarix(bron_id,created_at DESC);

CREATE TABLE IF NOT EXISTS xona_bron_yopiq_vaqtlar (
  id BIGSERIAL PRIMARY KEY,
  resurs_id BIGINT NOT NULL REFERENCES xona_bron_resurslar(id) ON DELETE RESTRICT,
  sana DATE NOT NULL,
  boshlanish TIME NOT NULL,
  tugash TIME NOT NULL,
  sabab VARCHAR(300) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT xona_bron_yopiq_vaqt_ck CHECK (boshlanish < tugash)
);
CREATE INDEX IF NOT EXISTS ix_xona_bron_yopiq_resurs_sana ON xona_bron_yopiq_vaqtlar(resurs_id,sana,boshlanish);
