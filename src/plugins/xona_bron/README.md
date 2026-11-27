# Xonalarni bron qilish (`xona_bron`)

Universitetning kompyuter xonalari, laboratoriya xonalari va ma'ruza xonalarini vaqt oralig'i bo'yicha bron qilish plagini. Kutubxona, stol, o'qish joyi yoki zal bron qilish funksiyasi ushbu modulga kiritilmagan.

## Rollar

- `student`, `teacher`, `tyutor`, `xodim`: faol xonalarni ko'rish, bron so'rovi yuborish, o'z bronlarini ko'rish va boshlanmagan bronni bekor qilish.
- `admin`: barcha xonalar va bronlarni boshqarish.
- `dekanat`: `userScope()` orqali o'z fakulteti doirasidagi, mas'ul bo'limga biriktirilgan xonalar va bronlarni boshqarish.

## Funksiyalar

- Xona turlari: `kompyuter`, `laboratoriya`, `maruza`.
- Xona CRUD, faollashtirish/faolsizlantirish.
- Bron yuborish, bronlar ro'yxati va tafsilotlari.
- Bronni tasdiqlash yoki sabab bilan rad etish.
- Bronni bekor qilish.
- Xona uchun yopiq vaqt oralig'ini belgilash.
- Sig'im, ish vaqti, sana, yopiq vaqt va bronlar kesishishini tekshirish.
- Har bir muhim amal audit jurnaliga yoziladi; bron holati o'zgarganda mavjud `bildirishnomalar` outbox'iga xabar qo'shiladi.

## Marshrutlar

| Method | URL | Ruxsat |
|---|---|---|
| GET | `/xona_bron` | Kirgan barcha rollar |
| GET | `/xona_bron/:id` | Kirgan barcha rollar |
| GET | `/xona_bron/jadval/:id` | Kirgan barcha rollar (`/xona_bron/:id` ga yo'naltiradi) |
| GET, POST | `/xona_bron/yangi` | Kirgan barcha rollar |
| GET | `/xona_bron/mening` | Kirgan barcha rollar (faqat o'z bronlari) |
| GET | `/xona_bron/bron/:id` | Egasi, admin yoki vakolatli dekanat |
| POST | `/xona_bron/bron/:id/bekor` | Egasi yoki admin |
| GET | `/admin/xona_bron/resurslar` | Admin, dekanat |
| GET, POST | `/admin/xona_bron/resurslar/yangi` | Admin, dekanat |
| GET, POST | `/admin/xona_bron/resurslar/:id/tahrir` | Admin, vakolatli dekanat |
| POST | `/admin/xona_bron/resurslar/:id/status` | Admin, vakolatli dekanat |
| GET | `/admin/xona_bron/bronlar` | Admin, dekanat |
| POST | `/admin/xona_bron/bronlar/:id/tasdiq` | Admin, vakolatli dekanat |
| POST | `/admin/xona_bron/bronlar/:id/rad` | Admin, vakolatli dekanat |
| GET, POST | `/admin/xona_bron/yopiq-vaqtlar` | Admin, dekanat |
| POST | `/admin/xona_bron/yopiq-vaqtlar/:id/och` | Admin, vakolatli dekanat |

## Database

`migrations/001_init.sql` quyidagi jadvallarni yaratadi:

- `xona_bron_resurslar` — xonalar katalogi.
- `xona_bronlar` — foydalanuvchi bron so'rovlari.
- `xona_bron_tarix` — bron holatlari tarixi.
- `xona_bron_yopiq_vaqtlar` — foydalanish mumkin bo'lmagan vaqtlar.

Asosiy `users` va `bolimlar` jadvallari faqat `FOREIGN KEY` uchun ishlatiladi. Asosiy jadvallarga o'zgartirish kiritilmaydi. Bron so'rovi tranzaksiyada resurs qatorini `FOR UPDATE` bilan qulflaydi va kesishuvchi `kutilmoqda`/`tasdiqlandi` bronlarni tekshiradi.

## Sozlash va ishga tushirish

```bash
npm install
npm run migrate      # asosiy + plagin migratsiyalari (xona_bron/001_init)
npm run seed         # demo foydalanuvchilar va bo'limlar
npm run seed:xona    # demo xonalar (faqat lokal/staging)
npm run dev          # http://localhost:3000
```

Demo loginlar: `talaba1` (talaba), `dekan_at` (AT dekanati, AT xonalarini boshqaradi), `dekan_iq` (boshqa fakultet), `admin`. Parol `parol123` (admin uchun `.env` dagi `ADMIN_PAROL`).

Xona qo'shishda "Mas'ul bo'lim" tanlanadi: bronlarni shu bo'lim fakultetining dekanati tasdiqlaydi. Bo'limi yo'q xonani faqat admin boshqaradi.

## Biznes qoidalari

- Bron faqat xonaning ish vaqti ichida, kelajak vaqtga va sig'imdan oshmaydigan odam soniga beriladi.
- Vaqt oralig'i `[boshlanish, tugash)` — ketma-ket bronlar (11:00 tugaydi, 11:00 boshlanadi) kesishmaydi.
- `kutilmoqda` va `tasdiqlandi` holatidagi bronlar vaqtni band qiladi; rad etilgan/bekor qilingan bronlar bo'shatadi.
- Bron `FOR UPDATE` qulf bilan tranzaksiyada tekshiriladi, shuning uchun bir vaqtda kelgan ikki so'rovdan faqat biri o'tadi.
- Yopiq vaqtga bron qilib bo'lmaydi; bron bor vaqtni yopib bo'lmaydi.
- Barcha sana/vaqt Toshkent vaqtida (`today()`, `nowTime()`).

## Tekshiruv

- `npm test` (alohida `TEST_DATABASE_URL` bazasi kerak) — plagin testlari `tests/xona_bron.test.js`.
- `npm run lint`.

## Asosiy kodga takliflar

Taqdim etilgan `dekanat-app-v2` ichida `src/plugins/` yuklovchisi yo'q edi, shuning uchun plagin o'z-o'zidan ishlamasdi. Loyihani lokalda (`localhost:3000`) ishlatish uchun asosiy kodga quyidagi **integratsiya o'zgarishlari** kiritilgan. Plagin papkasi ularsiz o'zgarmaydi, o'qituvchi esa o'zining yuklovchisini ishlatsa bo'ladi:

- `src/lib/plugins.js` (yangi): `src/plugins/*/index.js` ni topadi, `res.render('<plagin>/...')` ni plagin `views/` papkasiga yo'naltiradi, `public/` ni `/p/<plagin>/` ostida beradi, menyu havolalarini (`res.locals.pluginNav`) rolga qarab tayyorlaydi, plagin migratsiyalarini ro'yxatlaydi.
- `src/app.js`: `pluginLocals()` (menyu) va `mountPlugins(app)` chaqiruvlari qo'shilgan.
- `src/views/layouts/main.hbs`: `{{#each pluginNav}}` bilan plagin havolalari chiqariladi.
- `src/db/migrate.js`: asosiy migratsiyalardan keyin plagin migratsiyalarini (`<plagin>/NNN_nomi`) bajaradi.
- `eslint.config.js`: `src/plugins/*/public/**` brauzer JS fayllari uchun `browser` globallari.
- `package.json`: `npm test` plagin testlarini ham ishga tushiradi; `seed:xona` skripti.

Yana bir taklif: Handlebars'da `turi`, `sigim`, `sana` nomli helper'lar mavjud, shuning uchun `{{turi}}` kabi oddiy ifodalar o'zgaruvchi emas, helper'ni chaqiradi. Plaginda bunday o'zgaruvchilar `{{this.turi}}` shaklida yoziladi. Helper nomlarini ko'proq o'ziga xos qilib o'zgartirish tavsiya etiladi.
