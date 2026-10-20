# Replitga ko'chirish (qisqa)

1. Replit → Import from GitHub (yoki zip) → bu loyiha.
2. Replit Database (Postgres) qo'shing → `DATABASE_URL` o'zi paydo bo'ladi.
3. Secrets:
   - `TELEGRAM_BOT_TOKEN` (BotFather)
   - `OPENROUTER_API_KEY`
   - `OPENROUTER_MODELS` (ixtiyoriy) — vergul bilan, birinchisi asosiy: `meta-llama/llama-3.3-70b-instruct:free,google/gemma-4-31b-it:free`
   - `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` (clerk.com da yangi app oching)
4. Shellda: `corepack pnpm install`, so'ng `pnpm --filter @workspace/db run push` (`quiz_book_pages` jadvali uchun) va `npm run db:migrate` (quiz migratsiyalari uchun) bajaring.
5. Lokal Windows ishga tushirish: `.env` faylini loyiha ildiziga joylab, `npm run dev` buyrug'ini bajaring. Run/Deploy muhitida ham shu `.env` qiymatlari sozlangan bo'lsin.
6. Guruhga botni admin qilib qo'shing, guruhda `/setup` yuboring.
7. Botga shaxsiy chatda (admin sifatida) kitob PDF ni yuboring:
   - Telegram botlar uchun fayl chegarasi 20 MB: 80 MB kitobni 4–5 bo'lakka bo'ling (ilovepdf.com → Split PDF) va ketma-ket yuboring.
   - `/kitob` holat, `/offset 6` bosma bet ≠ PDF bet bo'lsa, `/kitob_tozalash` o'chirish.
8. Admin panelda mavzu qo'shganda "Kitob betlari" maydoniga bosma bet raqamini yozing (masalan `45-52`).

MUHIM: bot 24/7 ishlashi kerak. Replit "Autoscale" emas, "Reserved VM" yoki "Always On" tipidagi deployment kerak.
