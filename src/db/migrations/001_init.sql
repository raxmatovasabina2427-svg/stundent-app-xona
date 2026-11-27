-- =====================================================================
-- 001_init — Dekanat App v2 sxemasi (TZ, ilova A)
-- Bo'sh bazada jadvallarni yaratadi; v1 jadvallari bor bazada esa ularni
-- O'CHIRMASDAN kengaytiradi: yetishmayotgan ustunlar qo'shiladi, nomlar/tiplar
-- moslashtiriladi, eski ma'lumotlar yangi tuzilishga ulanadi.
-- Hammasi bitta tranzaksiyada (migrate.js) — xato bo'lsa hech narsa o'zgarmaydi.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$ BEGIN
  CREATE TYPE timerange AS RANGE (subtype = time);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- Yordamchi funksiyalar (faqat shu sessiya uchun) ----------------
CREATE FUNCTION pg_temp.has_tab(t text) RETURNS boolean LANGUAGE sql AS
  $$ SELECT to_regclass(format('public.%I', t)) IS NOT NULL $$;

CREATE FUNCTION pg_temp.has_col(t text, c text) RETURNS boolean LANGUAGE sql AS
  $$ SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = t AND column_name = c) $$;

CREATE FUNCTION pg_temp.col_type(t text, c text) RETURNS text LANGUAGE sql AS
  $$ SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = c $$;

-- Eski ustun nomini yangisiga o'zgartirish (yangisi hali yo'q bo'lsa)
CREATE FUNCTION pg_temp.rename_col(t text, eski text, yangi text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF pg_temp.has_col(t, eski) AND NOT pg_temp.has_col(t, yangi) THEN
    EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I', t, eski, yangi);
  END IF;
END $$;

-- Cheklovni qo'shishga urinish: eski ma'lumot mos kelmasa — NOT VALID (yangi yozuvlar baribir tekshiriladi)
CREATE FUNCTION pg_temp.add_con(t text, nom text, def text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', t)::regclass AND conname = nom) THEN RETURN; END IF;
  -- shu ustunlar bo'yicha shu jadvalga FK allaqachon bo'lsa (v1 dagi) — qayta qo'shilmaydi
  IF def ILIKE 'FOREIGN KEY%' AND EXISTS (
       SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', t)::regclass AND contype = 'f'
          AND pg_get_constraintdef(oid) LIKE split_part(def, ' REFERENCES ', 1) || ' REFERENCES '
              || split_part(split_part(def, ' REFERENCES ', 2), ' ', 1) || '%') THEN
    RETURN;
  END IF;
  BEGIN
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', t, nom, def);
  EXCEPTION WHEN others THEN
    BEGIN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s NOT VALID', t, nom, def);
      RAISE WARNING '% (%): eski ma''lumotlar mos emas — NOT VALID qo''shildi', nom, t;
    EXCEPTION WHEN others THEN
      RAISE WARNING '% (%): qo''shilmadi — %', nom, t, SQLERRM;
    END;
  END;
END $$;

-- Unikal indeks: dublikat bo'lsa ogohlantirib o'tkazib yuboradi
CREATE FUNCTION pg_temp.add_uidx(sql text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE sql;
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'Indeks yaratilmadi (dublikat qiymatlar bor): %', sql;
END $$;

-- Ustundagi eski CHECK cheklovlarini olib tashlash (masalan v1 dagi 4 ta rol)
CREATE FUNCTION pg_temp.drop_checks(t text, c text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint
            WHERE conrelid = format('public.%I', t)::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) ~ ('\m' || c || '\M')
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, r.conname);
  END LOOP;
END $$;

-- Jadval eski (mos kelmaydigan) tuzilishda bo'lsa — <nom>_v1 deb saqlab qo'yish
CREATE FUNCTION pg_temp.archive_if(t text, kerakli_ustun text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF pg_temp.has_tab(t) AND NOT pg_temp.has_col(t, kerakli_ustun) THEN
    EXECUTE format('ALTER TABLE %I RENAME TO %I', t, t || '_v1');
    RAISE NOTICE '% jadvali % ga ko''chirildi (eski tuzilish)', t, t || '_v1';
  END IF;
END $$;

-- Matnli/sonli kurs qiymatidan 1..6 ni ajratib olish
CREATE FUNCTION pg_temp.to_kurs(v text) RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN x BETWEEN 1 AND 6 THEN x::smallint END
    FROM (SELECT NULLIF(substring(v from '\d+'), '')::int AS x) s $$;

CREATE FUNCTION pg_temp.num_time(v bigint) RETURNS time LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v BETWEEN 0 AND 1439 THEN TIME '00:00' + make_interval(mins => v::int)
              WHEN v BETWEEN 1440 AND 86399 THEN TIME '00:00' + make_interval(secs => v::int) END $$;

-- Hafta kuni: 1..7, 'Dushanba', 'monday', 'du' ... -> 1..7
CREATE FUNCTION pg_temp.to_kun(v text) RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN v ~ '^\s*[1-7]\s*$' THEN trim(v)::smallint
    WHEN lower(v) ~ '^\s*(dush|du\M|mon|пон)' THEN 1
    WHEN lower(v) ~ '^\s*(sesh|se\M|tue|вто)' THEN 2
    WHEN lower(v) ~ '^\s*(chor|ch\M|wed|сре)' THEN 3
    WHEN lower(v) ~ '^\s*(pay|pa\M|thu|чет)' THEN 4
    WHEN lower(v) ~ '^\s*(jum|ju\M|fri|пят)' THEN 5
    WHEN lower(v) ~ '^\s*(shan|sh\M|sat|суб)' THEN 6
    WHEN lower(v) ~ '^\s*(yak|ya\M|sun|вос)' THEN 7
  END $$;

-- v1 ning v2 ishlatmaydigan ustunlaridagi NOT NULL olib tashlanadi — aks holda
-- yangi yozuvlar qo'shilmay qoladi (ma'lumotlar o'chmaydi, ustunlar qoladi)
CREATE FUNCTION pg_temp.relax(t text, cols text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = t AND is_nullable = 'NO'
              AND column_default IS NULL AND NOT (column_name = ANY (cols))
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL', t, r.column_name);
    RAISE NOTICE 'v1 ustuni %.% endi ixtiyoriy', t, r.column_name;
  END LOOP;
END $$;

-- Bitta (birinchi) fakultet; yo'q bo'lsa "Asosiy fakultet" yaratiladi
CREATE FUNCTION pg_temp.default_fak() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE fid bigint;
BEGIN
  SELECT id INTO fid FROM bolimlar WHERE turi = 'fakultet' ORDER BY id LIMIT 1;
  IF fid IS NULL THEN
    INSERT INTO bolimlar (nomi, turi) VALUES ('Asosiy fakultet', 'fakultet') RETURNING id INTO fid;
    RAISE NOTICE 'Yaratildi: "Asosiy fakultet" (nomini Bo''limlar sahifasida o''zgartiring)';
  END IF;
  RETURN fid;
END $$;

-- Bitta (birinchi) dekanat bo'limi; yo'q bo'lsa "Dekanat" yaratiladi
CREATE FUNCTION pg_temp.default_dek() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE did bigint;
BEGIN
  SELECT id INTO did FROM bolimlar WHERE turi = 'dekanat' ORDER BY id LIMIT 1;
  IF did IS NULL THEN
    INSERT INTO bolimlar (nomi, turi, parent_id) VALUES ('Dekanat', 'dekanat', pg_temp.default_fak()) RETURNING id INTO did;
    RAISE NOTICE 'Yaratildi: "Dekanat" bo''limi';
  END IF;
  RETURN did;
END $$;

-- =====================================================================
-- 1. users
-- =====================================================================
CREATE TABLE IF NOT EXISTS users (
  id                 BIGSERIAL PRIMARY KEY,
  ism                VARCHAR(100) NOT NULL,
  familiya           VARCHAR(100) NOT NULL,
  ochestva           VARCHAR(100),
  login              VARCHAR(100) NOT NULL,
  parol              VARCHAR(255) NOT NULL,
  role               VARCHAR(20)  NOT NULL,
  phone              VARCHAR(20),
  status             BOOLEAN NOT NULL DEFAULT TRUE,
  parol_almashtirish BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
SELECT pg_temp.rename_col('users', 'password', 'parol');
SELECT pg_temp.rename_col('users', 'telefon', 'phone');
SELECT pg_temp.rename_col('users', 'otasining_ismi', 'ochestva');
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ism                VARCHAR(100),
  ADD COLUMN IF NOT EXISTS familiya           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS ochestva           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS phone              VARCHAR(20),
  ADD COLUMN IF NOT EXISTS status             BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS parol_almashtirish BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT now();
SELECT pg_temp.relax('users', ARRAY['id','ism','familiya','login','parol','role','status','parol_almashtirish','created_at','updated_at']);

-- Tipi o'zgaradigan ustunlarning eski CHECK cheklovlari (v2 cheklovlari keyinroq qo'shiladi)
SELECT pg_temp.drop_checks('users', c) FROM unnest(ARRAY['status','created_at','updated_at']) c;
DO $$ BEGIN
  -- status matn/son bo'lsa -> boolean
  IF pg_temp.col_type('users', 'status') <> 'boolean' THEN
    ALTER TABLE users ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE users ALTER COLUMN status TYPE boolean USING
      (COALESCE(lower(status::text), 'true') NOT IN ('false', 'f', '0', 'no', 'blok', 'blocked', 'nofaol', 'inactive'));
    ALTER TABLE users ALTER COLUMN status SET DEFAULT TRUE;
  END IF;
  UPDATE users SET status = TRUE WHERE status IS NULL;
  ALTER TABLE users ALTER COLUMN status SET NOT NULL;
  -- K-14: vaqt belgilari TIMESTAMPTZ
  IF pg_temp.col_type('users', 'created_at') = 'timestamp without time zone' THEN
    ALTER TABLE users ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'Asia/Tashkent';
  END IF;
  IF pg_temp.col_type('users', 'updated_at') = 'timestamp without time zone' THEN
    ALTER TABLE users ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'Asia/Tashkent';
  END IF;
END $$;

-- Rollar: v1 dagi nomlarni v2 ga moslash (mudir -> teacher, katta-kichik harf)
SELECT pg_temp.drop_checks('users', 'role');
UPDATE users SET role = lower(trim(role)) WHERE role <> lower(trim(role));
UPDATE users SET role = 'teacher' WHERE role IN ('mudir', 'oqituvchi', 'o''qituvchi', 'kafedra');
UPDATE users SET role = 'student' WHERE role IN ('talaba', 'students');
SELECT pg_temp.add_con('users', 'users_role_check',
  $$CHECK (role IN ('admin','dekanat','teacher','tyutor','xodim','student'))$$);
SELECT pg_temp.add_uidx('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_login_lower ON users (lower(login))');   -- K-13
CREATE INDEX IF NOT EXISTS ix_users_role ON users (role);

-- =====================================================================
-- 2. bolimlar
-- =====================================================================
CREATE TABLE IF NOT EXISTS bolimlar (
  id         BIGSERIAL PRIMARY KEY,
  nomi       VARCHAR(200) NOT NULL,
  turi       VARCHAR(30)  NOT NULL DEFAULT 'bolim',
  parent_id  BIGINT,
  xona       VARCHAR(50),
  status     BOOLEAN NOT NULL DEFAULT TRUE
);
SELECT pg_temp.rename_col('bolimlar', 'nom', 'nomi');
SELECT pg_temp.rename_col('bolimlar', 'name', 'nomi');
ALTER TABLE bolimlar
  ADD COLUMN IF NOT EXISTS nomi      VARCHAR(200),
  ADD COLUMN IF NOT EXISTS turi      VARCHAR(30) NOT NULL DEFAULT 'bolim',
  ADD COLUMN IF NOT EXISTS parent_id BIGINT,
  ADD COLUMN IF NOT EXISTS xona      VARCHAR(50),
  ADD COLUMN IF NOT EXISTS status    BOOLEAN NOT NULL DEFAULT TRUE;
SELECT pg_temp.relax('bolimlar', ARRAY['id','turi','status']);
SELECT pg_temp.drop_checks('bolimlar', 'turi');
UPDATE bolimlar SET turi = lower(trim(turi)) WHERE turi <> lower(trim(turi));
UPDATE bolimlar SET turi = 'bolim'
 WHERE turi IS NULL OR turi NOT IN ('fakultet','dekanat','kafedra','bolim','markaz');
UPDATE bolimlar SET nomi = 'Bo''lim #' || id WHERE nomi IS NULL OR trim(nomi) = '';
SELECT pg_temp.add_con('bolimlar', 'bolimlar_turi_check', $$CHECK (turi IN ('fakultet','dekanat','kafedra','bolim','markaz'))$$);
SELECT pg_temp.add_con('bolimlar', 'bolimlar_parent_fk', 'FOREIGN KEY (parent_id) REFERENCES bolimlar(id) ON DELETE RESTRICT');
SELECT pg_temp.add_con('bolimlar', 'bolimlar_parent_self', 'CHECK (parent_id IS NULL OR parent_id <> id)');
SELECT pg_temp.add_uidx('CREATE UNIQUE INDEX IF NOT EXISTS ux_bolimlar_parent_nomi ON bolimlar (COALESCE(parent_id, 0), nomi)');
CREATE INDEX IF NOT EXISTS ix_bolimlar_parent ON bolimlar (parent_id);

-- Eski dekanat/kafedralarni fakultetga bog'lash (fakultet bitta bo'lsa)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM bolimlar WHERE turi IN ('dekanat','kafedra') AND parent_id IS NULL)
     AND (SELECT count(*) FROM bolimlar WHERE turi = 'fakultet') <= 1 THEN
    UPDATE bolimlar SET parent_id = pg_temp.default_fak()
     WHERE turi IN ('dekanat','kafedra') AND parent_id IS NULL;
  END IF;
END $$;

-- =====================================================================
-- 3. guruhlar (T-07) + 4. student_info
-- =====================================================================
CREATE TABLE IF NOT EXISTS guruhlar (
  id           BIGSERIAL PRIMARY KEY,
  nomi         VARCHAR(50) NOT NULL UNIQUE,
  kurs         SMALLINT CHECK (kurs BETWEEN 1 AND 6),
  fakultet_id  BIGINT NOT NULL REFERENCES bolimlar(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_guruhlar_fakultet ON guruhlar (fakultet_id);

CREATE TABLE IF NOT EXISTS student_info (
  user_id  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  guruh    VARCHAR(50),
  kurs     SMALLINT CHECK (kurs BETWEEN 1 AND 6),
  tg_user  BIGINT
);
SELECT pg_temp.rename_col('student_info', 'guruh_nomi', 'guruh');
SELECT pg_temp.rename_col('student_info', 'group', 'guruh');
ALTER TABLE student_info
  ADD COLUMN IF NOT EXISTS guruh   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS kurs    SMALLINT,
  ADD COLUMN IF NOT EXISTS tg_user BIGINT;
SELECT pg_temp.relax('student_info', ARRAY['user_id']);
SELECT pg_temp.drop_checks('student_info', c) FROM unnest(ARRAY['guruh','kurs','tg_user']) c;
DO $$ BEGIN
  IF pg_temp.col_type('student_info', 'guruh') <> 'character varying' THEN
    ALTER TABLE student_info ALTER COLUMN guruh TYPE VARCHAR(50) USING left(guruh::text, 50);
  END IF;
  IF pg_temp.col_type('student_info', 'kurs') NOT IN ('smallint', 'integer') THEN
    ALTER TABLE student_info ALTER COLUMN kurs TYPE SMALLINT USING pg_temp.to_kurs(kurs::text);
  END IF;
  IF pg_temp.col_type('student_info', 'tg_user') NOT IN ('bigint', 'integer') THEN
    ALTER TABLE student_info ALTER COLUMN tg_user TYPE BIGINT USING NULLIF(substring(tg_user::text from '\d+'), '')::bigint;
  END IF;
END $$;
UPDATE student_info SET guruh = NULLIF(trim(guruh), '') WHERE guruh IS DISTINCT FROM NULLIF(trim(guruh), '');
UPDATE student_info SET kurs = NULL WHERE kurs NOT BETWEEN 1 AND 6;

-- Talabalardagi guruh nomlaridan guruhlar ma'lumotnomasini to'ldirish
INSERT INTO guruhlar (nomi, kurs, fakultet_id)
SELECT s.guruh, max(s.kurs), pg_temp.default_fak()
  FROM student_info s
 WHERE s.guruh IS NOT NULL AND NOT EXISTS (SELECT 1 FROM guruhlar g WHERE g.nomi = s.guruh)
 GROUP BY s.guruh;

SELECT pg_temp.add_con('student_info', 'student_info_guruh_fk',
  'FOREIGN KEY (guruh) REFERENCES guruhlar(nomi) ON UPDATE CASCADE ON DELETE RESTRICT');
SELECT pg_temp.add_con('student_info', 'student_info_kurs_check', 'CHECK (kurs BETWEEN 1 AND 6)');
SELECT pg_temp.add_uidx('CREATE UNIQUE INDEX IF NOT EXISTS ux_student_tg ON student_info (tg_user)');
CREATE INDEX IF NOT EXISTS ix_student_guruh ON student_info (guruh);

-- =====================================================================
-- 5. teacher_info / dekanat_user_info
-- =====================================================================
CREATE TABLE IF NOT EXISTS teacher_info (
  user_id  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tg_user  BIGINT UNIQUE
);
ALTER TABLE teacher_info ADD COLUMN IF NOT EXISTS tg_user BIGINT;
SELECT pg_temp.relax('teacher_info', ARRAY['user_id']);

CREATE TABLE IF NOT EXISTS dekanat_user_info (
  user_id  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lavozim  VARCHAR(150),
  tg_user  BIGINT UNIQUE
);
ALTER TABLE dekanat_user_info
  ADD COLUMN IF NOT EXISTS lavozim VARCHAR(150),
  ADD COLUMN IF NOT EXISTS tg_user BIGINT;
SELECT pg_temp.relax('dekanat_user_info', ARRAY['user_id']);
SELECT pg_temp.drop_checks('dekanat_user_info', 'lavozim');
DO $$ BEGIN
  IF pg_temp.col_type('dekanat_user_info', 'lavozim') <> 'character varying'
     OR (SELECT character_maximum_length FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'dekanat_user_info' AND column_name = 'lavozim') < 150 THEN
    ALTER TABLE dekanat_user_info ALTER COLUMN lavozim TYPE VARCHAR(150) USING left(lavozim::text, 150);
  END IF;
END $$;

-- =====================================================================
-- 6. tyutor_guruh
-- =====================================================================
CREATE TABLE IF NOT EXISTS tyutor_guruh (
  id         BIGSERIAL PRIMARY KEY,
  tyutor_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guruh      VARCHAR(50) NOT NULL
);
SELECT pg_temp.rename_col('tyutor_guruh', 'user_id', 'tyutor_id');
SELECT pg_temp.rename_col('tyutor_guruh', 'xodim_id', 'tyutor_id');
SELECT pg_temp.rename_col('tyutor_guruh', 'guruh_nomi', 'guruh');
ALTER TABLE tyutor_guruh
  ADD COLUMN IF NOT EXISTS id        BIGSERIAL,
  ADD COLUMN IF NOT EXISTS tyutor_id BIGINT,
  ADD COLUMN IF NOT EXISTS guruh     VARCHAR(50);
SELECT pg_temp.relax('tyutor_guruh', ARRAY['id']);
SELECT pg_temp.drop_checks('tyutor_guruh', 'guruh');
DO $$ BEGIN
  IF pg_temp.col_type('tyutor_guruh', 'guruh') <> 'character varying' THEN
    ALTER TABLE tyutor_guruh ALTER COLUMN guruh TYPE VARCHAR(50) USING left(guruh::text, 50);
  END IF;
END $$;
UPDATE tyutor_guruh SET guruh = NULLIF(trim(guruh), '') WHERE guruh IS DISTINCT FROM NULLIF(trim(guruh), '');
DELETE FROM tyutor_guruh WHERE guruh IS NULL OR tyutor_id IS NULL;
INSERT INTO guruhlar (nomi, fakultet_id)
SELECT DISTINCT t.guruh, pg_temp.default_fak() FROM tyutor_guruh t
 WHERE NOT EXISTS (SELECT 1 FROM guruhlar g WHERE g.nomi = t.guruh);
DELETE FROM tyutor_guruh a USING tyutor_guruh b
 WHERE a.tyutor_id = b.tyutor_id AND a.guruh = b.guruh AND a.ctid > b.ctid;
SELECT pg_temp.add_con('tyutor_guruh', 'tyutor_guruh_tyutor_fk', 'FOREIGN KEY (tyutor_id) REFERENCES users(id) ON DELETE CASCADE');
SELECT pg_temp.add_con('tyutor_guruh', 'tyutor_guruh_guruh_fk',
  'FOREIGN KEY (guruh) REFERENCES guruhlar(nomi) ON UPDATE CASCADE ON DELETE CASCADE');
SELECT pg_temp.add_uidx('CREATE UNIQUE INDEX IF NOT EXISTS ux_tyutor_guruh ON tyutor_guruh (tyutor_id, guruh)');

-- =====================================================================
-- 7. xodim_bolim
-- =====================================================================
CREATE TABLE IF NOT EXISTS xodim_bolim (
  id        BIGSERIAL PRIMARY KEY,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bolim_id  BIGINT NOT NULL REFERENCES bolimlar(id) ON DELETE RESTRICT,
  lavozim   VARCHAR(150),
  asosiy    BOOLEAN NOT NULL DEFAULT FALSE
);
SELECT pg_temp.rename_col('xodim_bolim', 'xodim_id', 'user_id');
ALTER TABLE xodim_bolim
  ADD COLUMN IF NOT EXISTS id       BIGSERIAL,
  ADD COLUMN IF NOT EXISTS user_id  BIGINT,
  ADD COLUMN IF NOT EXISTS bolim_id BIGINT,
  ADD COLUMN IF NOT EXISTS lavozim  VARCHAR(150),
  ADD COLUMN IF NOT EXISTS asosiy   BOOLEAN NOT NULL DEFAULT FALSE;
SELECT pg_temp.relax('xodim_bolim', ARRAY['id','asosiy']);
ALTER TABLE xodim_bolim ALTER COLUMN asosiy SET DEFAULT FALSE;   -- v1 da TRUE edi
DO $$ BEGIN
  -- v1 (16-okt) da lavozim alohida jadvalda bo'lgan: lavozim_id -> lavozim nomi
  IF pg_temp.has_col('xodim_bolim', 'lavozim_id') AND pg_temp.has_tab('lavozimlar') THEN
    IF pg_temp.has_col('lavozimlar', 'nomi') THEN
      UPDATE xodim_bolim x SET lavozim = left(l.nomi, 150) FROM lavozimlar l WHERE l.id = x.lavozim_id AND x.lavozim IS NULL;
    ELSIF pg_temp.has_col('lavozimlar', 'nom') THEN
      UPDATE xodim_bolim x SET lavozim = left(l.nom, 150) FROM lavozimlar l WHERE l.id = x.lavozim_id AND x.lavozim IS NULL;
    END IF;
  END IF;
END $$;
DELETE FROM xodim_bolim WHERE user_id IS NULL OR bolim_id IS NULL;
DELETE FROM xodim_bolim a USING xodim_bolim b
 WHERE a.user_id = b.user_id AND a.bolim_id = b.bolim_id AND a.id > b.id;
-- Har xodimda aynan bitta asosiy bo'lim
UPDATE xodim_bolim x SET asosiy = FALSE
 WHERE asosiy AND EXISTS (SELECT 1 FROM xodim_bolim y WHERE y.user_id = x.user_id AND y.asosiy AND y.id < x.id);
UPDATE xodim_bolim x SET asosiy = TRUE
 WHERE NOT EXISTS (SELECT 1 FROM xodim_bolim y WHERE y.user_id = x.user_id AND y.asosiy)
   AND x.id = (SELECT min(id) FROM xodim_bolim z WHERE z.user_id = x.user_id);
-- Bo'limga biriktirilmagan dekanat xodimlari -> dekanat bo'limiga (fakultet doirasi ishlashi uchun)
INSERT INTO xodim_bolim (user_id, bolim_id, lavozim, asosiy)
SELECT u.id, pg_temp.default_dek(), d.lavozim, TRUE
  FROM users u LEFT JOIN dekanat_user_info d ON d.user_id = u.id
 WHERE u.role = 'dekanat' AND NOT EXISTS (SELECT 1 FROM xodim_bolim x WHERE x.user_id = u.id);

SELECT pg_temp.add_con('xodim_bolim', 'xodim_bolim_user_fk', 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');
SELECT pg_temp.add_con('xodim_bolim', 'xodim_bolim_bolim_fk', 'FOREIGN KEY (bolim_id) REFERENCES bolimlar(id) ON DELETE RESTRICT');
CREATE UNIQUE INDEX IF NOT EXISTS ux_xodim_bolim_pair ON xodim_bolim (user_id, bolim_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_xodim_bolim_asosiy ON xodim_bolim (user_id) WHERE asosiy;
CREATE INDEX IF NOT EXISTS ix_xodim_bolim_bolim ON xodim_bolim (bolim_id);

-- =====================================================================
-- 8. murojaat_turlari
-- =====================================================================
CREATE TABLE IF NOT EXISTS murojaat_turlari (
  id                 BIGSERIAL PRIMARY KEY,
  bolim_id           BIGINT NOT NULL REFERENCES bolimlar(id) ON DELETE RESTRICT,
  nomi               VARCHAR(200) NOT NULL,
  tavsif             TEXT,
  kerakli_hujjatlar  TEXT,
  status             BOOLEAN NOT NULL DEFAULT TRUE
);
SELECT pg_temp.rename_col('murojaat_turlari', 'nom', 'nomi');
SELECT pg_temp.rename_col('murojaat_turlari', 'name', 'nomi');
ALTER TABLE murojaat_turlari
  ADD COLUMN IF NOT EXISTS bolim_id          BIGINT,
  ADD COLUMN IF NOT EXISTS nomi              VARCHAR(200),
  ADD COLUMN IF NOT EXISTS tavsif            TEXT,
  ADD COLUMN IF NOT EXISTS kerakli_hujjatlar TEXT,
  ADD COLUMN IF NOT EXISTS status            BOOLEAN NOT NULL DEFAULT TRUE;
SELECT pg_temp.relax('murojaat_turlari', ARRAY['id','status']);
UPDATE murojaat_turlari SET nomi = 'Murojaat #' || id WHERE nomi IS NULL OR trim(nomi) = '';
UPDATE murojaat_turlari SET bolim_id = pg_temp.default_dek() WHERE bolim_id IS NULL;
SELECT pg_temp.add_con('murojaat_turlari', 'murojaat_turlari_bolim_fk', 'FOREIGN KEY (bolim_id) REFERENCES bolimlar(id) ON DELETE RESTRICT');
SELECT pg_temp.add_uidx('CREATE UNIQUE INDEX IF NOT EXISTS ux_murojaat_turlari ON murojaat_turlari (bolim_id, nomi)');

-- =====================================================================
-- 9. qabul_vaqti (xodimning haftalik shabloni)
-- =====================================================================
CREATE TABLE IF NOT EXISTS qabul_vaqti (
  id          BIGSERIAL PRIMARY KEY,
  xodim_id    BIGINT   NOT NULL,
  bolim_id    BIGINT   NOT NULL,
  hafta_kuni  SMALLINT NOT NULL,
  start_time  TIME     NOT NULL,
  end_time    TIME     NOT NULL,
  slot_min    SMALLINT CHECK (slot_min BETWEEN 5 AND 240),     -- NULL = jonli navbat
  max_navbat  SMALLINT NOT NULL DEFAULT 20 CHECK (max_navbat BETWEEN 1 AND 500),
  status      BOOLEAN  NOT NULL DEFAULT TRUE
);
-- v1 ustun nomlari: user_id / teacher_id -> xodim_id
SELECT pg_temp.rename_col('qabul_vaqti', 'user_id', 'xodim_id');
SELECT pg_temp.rename_col('qabul_vaqti', 'teacher_id', 'xodim_id');
SELECT pg_temp.rename_col('qabul_vaqti', 'dekanat_id', 'xodim_id');
SELECT pg_temp.rename_col('qabul_vaqti', 'boshlanish', 'start_time');
SELECT pg_temp.rename_col('qabul_vaqti', 'tugash', 'end_time');
ALTER TABLE qabul_vaqti
  ADD COLUMN IF NOT EXISTS xodim_id   BIGINT,
  ADD COLUMN IF NOT EXISTS bolim_id   BIGINT,
  ADD COLUMN IF NOT EXISTS hafta_kuni SMALLINT,
  ADD COLUMN IF NOT EXISTS start_time TIME,
  ADD COLUMN IF NOT EXISTS end_time   TIME,
  ADD COLUMN IF NOT EXISTS slot_min   SMALLINT,
  ADD COLUMN IF NOT EXISTS max_navbat SMALLINT NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS status     BOOLEAN NOT NULL DEFAULT TRUE;
SELECT pg_temp.relax('qabul_vaqti', ARRAY['id','max_navbat','status']);

-- v1 dagi CHECK lar (masalan start_time >= 0) TIME tipiga o'tishga to'sqinlik qiladi — avval olib tashlanadi
SELECT pg_temp.drop_checks('qabul_vaqti', c)
  FROM unnest(ARRAY['start_time','end_time','week_date','hafta_kuni','slot_min','max_navbat','status']) c;
-- Eski DEFAULT va indekslar ham tip o'zgarishiga to'sqinlik qilishi mumkin
DO $$ DECLARE r record; c text; BEGIN
  FOREACH c IN ARRAY ARRAY['start_time','end_time','hafta_kuni'] LOOP
    IF pg_temp.has_col('qabul_vaqti', c) AND pg_temp.col_type('qabul_vaqti', c) NOT IN ('time without time zone', 'smallint') THEN
      EXECUTE format('ALTER TABLE qabul_vaqti ALTER COLUMN %I DROP DEFAULT', c);
    END IF;
  END LOOP;
  FOR r IN SELECT i.indexname FROM pg_indexes i
            WHERE i.schemaname = 'public' AND i.tablename = 'qabul_vaqti'
              AND i.indexdef ~ '\m(start_time|end_time|week_date)\M'
              AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = i.indexname)
  LOOP
    EXECUTE format('DROP INDEX %I', r.indexname);
  END LOOP;
END $$;
DO $$ BEGIN
  -- v1: week_date (kun nomi yoki 1..7) -> hafta_kuni
  IF pg_temp.has_col('qabul_vaqti', 'week_date') THEN
    UPDATE qabul_vaqti SET hafta_kuni = pg_temp.to_kun(week_date::text) WHERE hafta_kuni IS NULL;
  END IF;
  IF pg_temp.col_type('qabul_vaqti', 'hafta_kuni') <> 'smallint' THEN
    ALTER TABLE qabul_vaqti ALTER COLUMN hafta_kuni TYPE SMALLINT USING pg_temp.to_kun(hafta_kuni::text);
  END IF;
  -- vaqtlar: daqiqa (son) yoki matn bo'lsa -> TIME
  -- v1: xodim qabul_vaqti ga emas, teacher_info/dekanat_user_info.qabul_vaqti orqali bog'langan
  IF pg_temp.has_col('teacher_info', 'qabul_vaqti') THEN
    UPDATE qabul_vaqti q SET xodim_id = t.user_id FROM teacher_info t WHERE t.qabul_vaqti = q.id AND q.xodim_id IS NULL;
  END IF;
  IF pg_temp.has_col('dekanat_user_info', 'qabul_vaqti') THEN
    UPDATE qabul_vaqti q SET xodim_id = d.user_id FROM dekanat_user_info d WHERE d.qabul_vaqti = q.id AND q.xodim_id IS NULL;
  END IF;
  -- vaqt son bo'lsa: 0..1439 — kun boshidan daqiqa, 1440..86399 — soniya, boshqasi yaroqsiz
  IF pg_temp.col_type('qabul_vaqti', 'start_time') IN ('integer', 'smallint', 'bigint') THEN
    ALTER TABLE qabul_vaqti ALTER COLUMN start_time TYPE TIME USING pg_temp.num_time(start_time);
  ELSIF pg_temp.col_type('qabul_vaqti', 'start_time') NOT IN ('time without time zone') THEN
    ALTER TABLE qabul_vaqti ALTER COLUMN start_time TYPE TIME USING NULLIF(trim(start_time::text), '')::time;
  END IF;
  IF pg_temp.col_type('qabul_vaqti', 'end_time') IN ('integer', 'smallint', 'bigint') THEN
    ALTER TABLE qabul_vaqti ALTER COLUMN end_time TYPE TIME USING pg_temp.num_time(end_time);
  ELSIF pg_temp.col_type('qabul_vaqti', 'end_time') NOT IN ('time without time zone') THEN
    ALTER TABLE qabul_vaqti ALTER COLUMN end_time TYPE TIME USING NULLIF(trim(end_time::text), '')::time;
  END IF;
  IF pg_temp.col_type('qabul_vaqti', 'status') <> 'boolean' THEN
    ALTER TABLE qabul_vaqti ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE qabul_vaqti ALTER COLUMN status TYPE boolean USING
      (COALESCE(lower(status::text), 'true') NOT IN ('false', 'f', '0', 'no', 'nofaol', 'inactive'));
    ALTER TABLE qabul_vaqti ALTER COLUMN status SET DEFAULT TRUE;
  END IF;
END $$;
UPDATE qabul_vaqti SET status = TRUE WHERE status IS NULL;
UPDATE qabul_vaqti SET max_navbat = 20 WHERE max_navbat IS NULL OR max_navbat NOT BETWEEN 1 AND 500;
UPDATE qabul_vaqti SET slot_min = NULL WHERE slot_min NOT BETWEEN 5 AND 240;

-- Eski qabullarni bo'limga ulash: xodimning asosiy bo'limi, bo'lmasa — dekanat
UPDATE qabul_vaqti q SET bolim_id = x.bolim_id
  FROM xodim_bolim x WHERE q.bolim_id IS NULL AND x.user_id = q.xodim_id AND x.asosiy;
UPDATE qabul_vaqti SET bolim_id = pg_temp.default_dek() WHERE bolim_id IS NULL AND xodim_id IS NOT NULL;
-- Shablon (xodim, bo'lim) juftligi xodim_bolim da bo'lishi shart
INSERT INTO xodim_bolim (user_id, bolim_id, asosiy)
SELECT DISTINCT q.xodim_id, q.bolim_id, NOT EXISTS (SELECT 1 FROM xodim_bolim y WHERE y.user_id = q.xodim_id AND y.asosiy)
  FROM qabul_vaqti q JOIN users u ON u.id = q.xodim_id
 WHERE q.bolim_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM xodim_bolim x WHERE x.user_id = q.xodim_id AND x.bolim_id = q.bolim_id)
ON CONFLICT DO NOTHING;
-- Yaroqsiz eski qatorlar o'chirilmaydi — nofaol qilinadi
UPDATE qabul_vaqti SET status = FALSE
 WHERE status AND (xodim_id IS NULL OR bolim_id IS NULL OR hafta_kuni IS NULL OR hafta_kuni NOT BETWEEN 1 AND 7
                   OR start_time IS NULL OR end_time IS NULL OR end_time <= start_time);
-- Ustma-ust tushgan faol qabullardan keyingilari nofaol
UPDATE qabul_vaqti q SET status = FALSE
 WHERE q.status AND EXISTS (
   SELECT 1 FROM qabul_vaqti o
    WHERE o.status AND o.id < q.id AND o.xodim_id = q.xodim_id AND o.hafta_kuni = q.hafta_kuni
      AND timerange(o.start_time, o.end_time) && timerange(q.start_time, q.end_time));

SELECT pg_temp.drop_checks('qabul_vaqti', 'week_date');
SELECT pg_temp.add_con('qabul_vaqti', 'qabul_vaqti_kun_check', 'CHECK (hafta_kuni BETWEEN 1 AND 7)');
SELECT pg_temp.add_con('qabul_vaqti', 'qabul_vaqti_vaqt_check', 'CHECK (end_time > start_time)');
SELECT pg_temp.add_con('qabul_vaqti', 'qabul_vaqti_slot_check', 'CHECK (slot_min BETWEEN 5 AND 240)');
SELECT pg_temp.add_con('qabul_vaqti', 'qabul_vaqti_max_check', 'CHECK (max_navbat BETWEEN 1 AND 500)');
SELECT pg_temp.add_con('qabul_vaqti', 'qabul_vaqti_xodim_fk', 'FOREIGN KEY (xodim_id) REFERENCES users(id) ON DELETE RESTRICT');
SELECT pg_temp.add_con('qabul_vaqti', 'qabul_vaqti_bolim_fk', 'FOREIGN KEY (bolim_id) REFERENCES bolimlar(id) ON DELETE RESTRICT');
SELECT pg_temp.add_con('qabul_vaqti', 'qabul_vaqti_xodim_bolim_fk',
  'FOREIGN KEY (xodim_id, bolim_id) REFERENCES xodim_bolim (user_id, bolim_id) ON DELETE RESTRICT');
SELECT pg_temp.add_con('qabul_vaqti', 'ex_qabul_ustma_ust',
  'EXCLUDE USING gist (xodim_id WITH =, hafta_kuni WITH =, timerange(start_time, end_time) WITH &&) WHERE (status)');
-- Yangi qatorlar uchun majburiy ustunlar (eski yaroqsizlari nofaol, NOT NULL faqat bo'shlari yo'q bo'lsa)
DO $$ DECLARE c text; BEGIN
  FOREACH c IN ARRAY ARRAY['xodim_id','bolim_id','hafta_kuni','start_time','end_time'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'qabul_vaqti'
                    AND column_name = c AND is_nullable = 'NO') THEN
      BEGIN
        EXECUTE format('ALTER TABLE qabul_vaqti ALTER COLUMN %I SET NOT NULL', c);
      EXCEPTION WHEN not_null_violation THEN
        RAISE WARNING 'qabul_vaqti.% da bo''sh qiymatlar bor — NOT NULL qo''yilmadi', c;
      END;
    END IF;
  END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS ix_qabul_bolim_kun ON qabul_vaqti (bolim_id, hafta_kuni) WHERE status;
CREATE INDEX IF NOT EXISTS ix_qabul_xodim ON qabul_vaqti (xodim_id);

-- =====================================================================
-- 10. qabul_istisno, 11. navbatlar — yangi jadvallar
--     (shu nomda boshqa tuzilishdagi eski jadval bo'lsa, <nom>_v1 ga ko'chiriladi)
-- =====================================================================
SELECT pg_temp.archive_if('qabul_istisno', 'sana');
CREATE TABLE IF NOT EXISTS qabul_istisno (
  id        BIGSERIAL PRIMARY KEY,
  xodim_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sana      DATE   NOT NULL,
  sabab     VARCHAR(255),
  UNIQUE (xodim_id, sana)
);

SELECT pg_temp.archive_if('navbatlar', 'navbat_raqami');
CREATE TABLE IF NOT EXISTS navbatlar (
  id                BIGSERIAL PRIMARY KEY,
  student_id        BIGINT   NOT NULL REFERENCES users(id)            ON DELETE RESTRICT,
  qabul_vaqti_id    BIGINT   NOT NULL REFERENCES qabul_vaqti(id)      ON DELETE RESTRICT,
  murojaat_turi_id  BIGINT            REFERENCES murojaat_turlari(id) ON DELETE RESTRICT,
  sana              DATE     NOT NULL,
  boshlanish        TIME,
  tugash            TIME,
  navbat_raqami     SMALLINT NOT NULL CHECK (navbat_raqami > 0),
  mavzu             TEXT     CHECK (char_length(mavzu) <= 1000),
  status            VARCHAR(20) NOT NULL DEFAULT 'kutilmoqda'
                    CHECK (status IN ('kutilmoqda','tasdiqlandi','qabul_qilindi',
                                      'kelmadi','rad_etildi','bekor_qilindi')),
  javob_izoh        TEXT,
  ozgartirgan_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((boshlanish IS NULL AND tugash IS NULL) OR tugash > boshlanish)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_navbat_slot_faol
  ON navbatlar (qabul_vaqti_id, sana, navbat_raqami)
  WHERE status IN ('kutilmoqda','tasdiqlandi','qabul_qilindi','kelmadi');
CREATE UNIQUE INDEX IF NOT EXISTS ux_navbat_student_kun
  ON navbatlar (student_id, qabul_vaqti_id, sana)
  WHERE status IN ('kutilmoqda','tasdiqlandi');
CREATE INDEX IF NOT EXISTS ix_navbat_student    ON navbatlar (student_id, sana DESC);
CREATE INDEX IF NOT EXISTS ix_navbat_qabul_sana ON navbatlar (qabul_vaqti_id, sana);

-- =====================================================================
-- updated_at trigger
-- =====================================================================
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_navbat_updated_at ON navbatlar;
CREATE TRIGGER trg_navbat_updated_at BEFORE UPDATE ON navbatlar
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
