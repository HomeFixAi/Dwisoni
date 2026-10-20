# Replit Agent ga yuboriladigan xabar (nusxa qilib joylang)

Bu loyiha deyarli tayyor. Avval `replit.md` va `README_UZ.md` ni o'qi.
Kodni qayta yozma, refaktor qilma, dizaynni o'zgartirma. Faqat sozlash va ishga tushirish:
1. pnpm install
2. Postgres bazasini yarat va `pnpm --filter @workspace/db run push` ni ishga tushir
3. Clerk autentifikatsiyasini sozla
4. typecheck qil, API server va panelni ishga tushir; faqat ishga tushishni to'sadigan xatolarni tuzat
5. Qaysi Secrets ni men o'zim kiritishim kerakligini ayt (token va kalitlarni chatda so'rama)
6. Deployment ni Reserved VM (always-on) qilib sozla, Autoscale emas

Boshqa hech narsani o'zgartirma. Tugagach nima qilganingni qisqa yoz.
