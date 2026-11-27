# Dekanat App v2 — elektron qabul va navbat tizimi

Talabalar dekanat, kafedra va boshqa bo'lim xodimlari qabuliga onlayn navbat oladi; xodimlar haftalik qabul jadvalini kiritadi va navbatlarni boshqaradi.
Bu — TZ'dagi **MVP (Faza 0–4)**: xavfsizlik tuzatishlari, yangi DB sxemasi, bo'limlar, qabul jadvali va navbat yadrosi.

**Stek:** Node.js 22 · Express 4 · Handlebars (SSR) + htmx · PostgreSQL 15+ (Render: 16)

---

## 1. Lokal ishga tushirish (Windows / macOS / Linux)

```bash
npm install
copy .env.example .env        # macOS/Linux: cp .env.example .env
# .env ni to'ldiring (pastdagi jadval)
npm run migrate               # jadvallar + birinchi admin
npm run seed                  # (ixtiyoriy) demo ma'lumotlar — faqat lokal/staging!
npm run dev                   # http://localhost:3000
```

Demo loginlar (`npm run seed` dan keyin, parol hammasida `parol123`):

| Login | Rol | Nimani ko'rish mumkin |
|---|---|---|
| `admin` | administrator | `.env` dagi `ADMIN_PAROL`; birinchi kirishda parolni almashtiradi |
| `dekan_at` | dekanat (AT fakulteti) | panel, fakultet foydalanuvchilari, jadvallar, navbatlar |
| `zamdekan_at` | dekanat | |
| `karimova` | o'qituvchi (kafedra + dekanat maslahatchisi) | bugungi navbat, 2 bo'lim nomidan qabul |
| `tyutor_at` | tyutor (AT-21-01) | guruh talabalari va navbatlari |
| `registrator` | bo'lim xodimi | Du–Ju 09:00–12:00 qabul |
| `dekan_iq` | dekanat (Iqtisodiyot) | boshqa fakultet — AT ma'lumotlarini ko'rmaydi |
| `talaba1` … `talaba5` | talaba | navbatga yozilish |

## 2. Muhit o'zgaruvchilari (`.env`)

| O'zgaruvchi | Misol | Izoh |
|---|---|---|
| `NODE_ENV` | `production` | prod'da `secure` cookie |
| `DATABASE_URL` | `postgres://...` | Render ichida **Internal URL**, lokaldan **External URL** |
| `DB_SSL` | `false` / `true` | Internal URL — `false`, External URL — `true` |
| `SESSION_SECRET` | 64 ta tasodifiy belgi | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `CRON_SECRET` | tasodifiy satr | `/internal/cron/*` himoyasi |
| `ADMIN_LOGIN`, `ADMIN_PAROL` | `admin`, `kamida8belgi` | faqat faol admin bo'lmasa ishlatiladi; keyin o'chirib qo'ying |
| `PORT` | `3000` | Render o'zi beradi |
| `APP_URL` | `https://dekanat.onrender.com` | |

## 3. Mavjud (v1) baza bilan ishlash

`npm run migrate` bo'sh bazada jadvallarni yaratadi, v1 jadvallari bor bazada esa ularni **o'chirmasdan kengaytiradi**:

- `users`: `parol_almashtirish` qo'shiladi, sanalar `timestamptz` ga o'tadi, rollar 6 ta rolga moslanadi (`mudir` → `teacher`).
- `qabul_vaqti`: `bigint` daqiqalar → `TIME`, `week_date` → `hafta_kuni`, xodim `teacher_info/dekanat_user_info.qabul_vaqti` orqali topiladi; eski qabul jonli navbat (20 joy) sifatida ochiladi.
- `bolimlar`: `fakultet` turi qo'shiladi; fakultetsiz dekanat/kafedralar avtomatik **"Asosiy fakultet"** ichiga joylanadi (nomini Bo'limlar sahifasida o'zgartiring). `tyutorlar`/`xizmat` turlari → `bolim`.
- `xodim_bolim`: lavozim nomi `lavozimlar` dan ko'chiriladi; `guruhlar` talabalardagi guruh nomlaridan to'ldiriladi.
- Eski `bildirishnomalar` → `bildirishnomalar_v1` nomi bilan saqlanadi. `murojaatlar`, `qabul_jadvali`, `qabul_slotlari`, `lavozimlar` tegilmaydi.
- v1 ning v2 ishlatmaydigan ustunlari o'chirilmaydi, faqat majburiy (NOT NULL) emas bo'ladi.

Hammasi bitta tranzaksiyada: xato bo'lsa baza o'zgarmaydi. Baribir avval zaxira oling:

```bash
pg_dump "EXTERNAL_DATABASE_URL" -Fc -f backup_v1.dump
npm run migrate
```

Bazaning tuzilishini tekshirish uchun: `node schema-dump.js` → `schema-dump.txt` (faqat o'qiydi; parol va shaxsiy ma'lumot yozilmaydi).

## 4. Render'ga deploy

`render.yaml` (Blueprint) tayyor. Qo'lda sozlasangiz:

| Sozlama | Qiymat |
|---|---|
| Build Command | `npm ci` |
| Start Command | `npm start` (migratsiyalar start'da avtomatik, idempotent) |
| Health Check Path | `/healthz` |
| Region | DB bilan bir xil (Frankfurt) |

**Rejalashtirilgan ish (BR-07, avto-"kelmadi")** — har 15 daqiqada:
```bash
curl -X POST -H "X-Cron-Secret: $CRON_SECRET" https://SIZNING-APP.onrender.com/internal/cron/kelmadi
```
Render Cron Job, GitHub Actions `schedule` yoki cron-job.org dan chaqirish mumkin.

> Render Free: web servis 15 daqiqada uxlaydi, Free Postgres 30 kunda muddati tugaydi va backup yo'q — faqat sinov uchun.

## 5. Testlar

```bash
# test bazasi kerak (alohida!)
set TEST_DATABASE_URL=postgres://user:pass@localhost:5432/dekanat_test   # macOS/Linux: export ...
npm test        # 43 ta test: RBAC, CSRF, sessiya, parallel bron, biznes-qoidalar
npm run lint
```
⚠️ Testlar `TEST_DATABASE_URL` dagi bazani **tozalab** qayta yaratadi — hech qachon ishchi bazani bermang.

## 6. Tuzilma

```
src/
  server.js, app.js          # ishga tushirish, middleware zanjiri (helmet, sessiya, CSRF)
  config/env.js              # .env ni zod bilan tekshirish
  db/  pool.js, migrate.js, seed.js, migrations/001_init.sql, 002_extra.sql
  middleware/ auth.js        # har so'rovda foydalanuvchini bazadan yuklash
              rbac.js        # barcha ruxsatlar shu yerda (4.2-matritsa)
  lib/        scope.js (fakultet doirasi), time.js (Toshkent vaqti), audit.js, settings.js, hbs.js
  modules/
    auth, profile, home      # kirish, profil, rolga mos bosh sahifa/panel
    users, guruhlar          # foydalanuvchilar (6 rol), guruhlar
    bolimlar, murojaat       # tashkiliy tuzilma, murojaat turlari
    qabul/                   # shablonlar, istisnolar, bayramlar, haftalik jadval
    navbat/  slots.js        # bo'sh slotlarni hisoblash
             booking.js      # band qilish (FOR UPDATE + unique indekslar)
             status.js       # holatlar mashinasi, ommaviy bekor qilish, avto-"kelmadi"
             notify.js       # bildirishnomalar outbox'i (Telegram — Faza 5)
    tyutor, admin, cron
  views/                     # .hbs shablonlar
public/                      # css, js (htmx), favicon
tests/                       # node:test + supertest
```

## 7. Nima qilindi (TZ bo'yicha)

- **Faza 1:** K-01 (dekanat endi admin bera olmaydi), K-02 (bloklash darhol), K-03 (sessiya Postgres'da), K-04 CSRF, K-05 `trust proxy`/secure cookie, K-06 login limit, K-07 helmet+CSP, K-10 versiyalangan migratsiyalar, K-11 o'zini/oxirgi adminni himoya, K-13 login registri, K-14 TIMESTAMPTZ + Toshkent vaqti, K-15 sahifalash, K-16 xavfsiz redirect, K-17 doimiy vaqtli login, K-22 telefon formati, K-24 audit.
- **Faza 2:** 6 rol, bo'limlar daraxti (sikl taqiqi), xodim ↔ bo'lim (bitta asosiy), guruhlar (T-07), tyutor guruhlari, murojaat turlari, dekanat uchun fakultet doirasi.
- **Faza 3:** cheksiz haftalik shablonlar (slot/jonli rejim, sig'im hisoblagichi, ustma-ust tushish taqiqi), istisnolar (sana oralig'i, oldindan ko'rish), bayramlar, haftalik jadval.
- **Faza 4:** 5 qadamli talaba ustasi, chipta, mening navbatlarim, bekor qilish, xodim paneli (htmx), holatlar mashinasi + tarix, BR-01…BR-21, avto-"kelmadi".

## 8. Keyingi fazalar (hali yo'q)

Faza 5 — Telegram bot (outbox jadvali va ulash tokenlari tayyor) · Faza 6 — Excel import/eksport, hisobotlar, TV ekran · Faza 7 — E2E, yuk sinovi, UAT.
TZ'dagi ochiq savollar (Q1–Q24) bo'yicha standart taxminlar qabul qilingan; BR-22 ("talaba faqat o'z fakulteti dekanatiga") yoqilmagan — talabaga o'z fakulteti bo'limlari ro'yxat boshida ko'rsatiladi.


---

## Plaginlar (`src/plugins/`)

Qo'shimcha modullar `src/plugins/<nom>/` papkasida yashaydi va ilova ularni o'zi topib ulaydi (marshrut, menyu, view, `/p/<nom>/` statik fayllar, migratsiya). `_` bilan boshlangan papkalar yuklanmaydi. Hozirgi plaginlar:

| Plagin | Vazifasi | URL |
|---|---|---|
| `xona_bron` | Kompyuter, laboratoriya va ma'ruza xonalarini bron qilish | `/xona_bron` |

Lokal tezkor ishga tushirish (Docker bilan PostgreSQL):

```bash
docker compose up -d          # PostgreSQL 5432 (dekanat va dekanat_test bazalari)
npm install
npm run migrate && npm run seed && npm run seed:xona
npm run dev                   # http://localhost:3000
```
