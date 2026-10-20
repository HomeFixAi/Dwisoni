# Deutsch Grammatik Test Bot

Nemis tili o'rganuvchi Telegram guruhi (10 kishi, kitob: Grammatik Aktiv) uchun kunlik avtomatik test boti + admin veb panel.

## MUHIM QOIDALAR (Agent uchun)
- Bu loyiha TAYYOR. Kodni qayta yozma, refaktor qilma, dizaynni o'zgartirma. Faqat SOZLASH va ishga tushirish.
- Faqat ishga tushishga to'sqinlik qiladigan xatolarni tuzat. Boshqa "yaxshilash" kerak emas.
- Token va kalitlarni chatga yozdirma: foydalanuvchi ularni Secrets ga o'zi kiritadi.
- Stack: pnpm workspaces, Node 24, TypeScript, Express 5 (API), React + Vite (panel), PostgreSQL + Drizzle, Clerk (login).

## Holat (tekshirilgan)
- `artifacts/api-server`: typecheck va build o'tadi.
- `artifacts/deutsch-grammatik-bot` (panel): typecheck va build o'tadi (Clerk v6 uchun `SignedIn/SignedOut` -> `<Show when="signed-in|signed-out">` ga almashtirilgan).
- Haqiqiy Telegram, baza va OpenRouter bilan hali SINALMAGAN. Birinchi ishga tushirishda kichik muammolar bo'lishi mumkin.

## Bot nima qiladi
1. Har kuni `dailyTime` (standart 20:00, Asia/Tashkent) da guruhga "✅ Qatnashaman" tugmali xabar yuboradi.
2. Kamida 3 kishi bossa test boshlanadi, aks holda bekor qilinadi.
3. AI (OpenRouter) mavzu bo'yicha 4 variantli savollar tuzadi, ikkinchi marta mustaqil tekshiradi, avvalgi savollarni takrorlamaydi.
4. Savollar guruhga bittadan yuboriladi, har kimning javobi alohida saqlanadi.
5. Admin panel: natijalar, ishtirokchi bo'yicha, foizlar, reyting, tarix, savol bo'yicha javoblar. Mavzular panelda oldindan kiritiladi (sana + mavzu + kitob betlari).
6. Kitobni Telegramdan yuklash: admin botga shaxsiy chatda PDF yuboradi, matn sahifa-sahifa bazaga (`quiz_book_pages`) saqlanadi, mavzudagi betlar savol tuzishda manba bo'ladi.
   - Telegram bot 20 MB dan katta faylni yuklab ola olmaydi: katta PDF ni bo'laklarga bo'lib ketma-ket yuborish kerak.
   - Buyruqlar: `/kitob`, `/offset N`, `/kitob_tozalash`.
   - Skaner (rasm) PDF dan matn chiqmaydi (OCR yo'q). Foydalanuvchi OCRmyPDF qiladi.

## Kerakli Secrets
- `TELEGRAM_BOT_TOKEN` (BotFather)
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODELS` (ixtiyoriy, vergul bilan, birinchisi asosiy; standart: `meta-llama/llama-3.3-70b-instruct:free,google/gemma-4-31b-it:free`)
- `DATABASE_URL` (Replit Postgres)
- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` (kod Replit boshqaradigan Clerk proxy bilan ishlaydi: `middlewares/clerkProxyMiddleware.ts`)

## Sening vazifang (faqat shular)
1. `pnpm install`
2. Postgres yarat, `pnpm --filter @workspace/db run push` (jadvallar, jumladan yangi `quiz_book_pages`, yaratiladi)
3. Clerk autentifikatsiyasini shu loyiha uchun sozla
4. `pnpm run typecheck`, so'ng API server va panelni ishga tushir; faqat ishga tushishni to'sadigan xatolarni tuzat
5. Foydalanuvchi qaysi Secrets ni o'zi kiritishi kerakligini ayt
6. Deployment: botga 24/7 ishlaydigan tur kerak (Reserved VM / always-on). Autoscale EMAS: bot long-polling va 20 soniyalik taymer bilan ishlaydi, server uxlasa bot to'xtaydi.

## Ishga tushirish
- Dev: `pnpm --filter @workspace/api-server run dev` (API; `PORT` env majburiy, production da 8080)
- Panel: `pnpm --filter @workspace/deutsch-grammatik-bot run dev`
- Build: `pnpm run build`
- API health: `/api/healthz`

## Foydalanuvchi qiladigan qadamlar (sen emas)
- Botni guruhga administrator qilib qo'shish, guruhda `/setup` yuborish
- Panelda "ulanish kodi" yaratib, guruhda `/link KOD` yuborish
- Panelda har kun uchun mavzu kiritish
- Kitob PDF ni botga yuborish

## Eslatmalar
- Telegram `getUpdates` (long polling) ishlatiladi, webhook emas. Bir token bilan faqat BITTA server ishlashi kerak.
- Bot faqat sozlangan guruhda ishlaydi; admin buyruqlari faqat `quiz_bot_admins` ro'yxatidagilar uchun.
- `settings.aiModel` har ishga tushishda `OPENROUTER_MODELS` ning birinchi modeliga moslashtiriladi.
