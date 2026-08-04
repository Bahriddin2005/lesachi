# LESA mobil ilovasi

Android va iPhone uchun Expo/React Native mobil ilova. Ma’lumotlar qurilmaning lokal SQLite bazasida saqlanadi.

## Ishga tushirish

```bash
npm start
```

Terminaldagi QR kodni telefoningizdagi Expo Go orqali skanerlang. iOS simulyator uchun `npm run ios`, Android emulator uchun `npm run android` ishlating.

Google Chrome’da ochish uchun:

```bash
npm run web
```

## PWA build (Android/iPhone uchun saytdan o‘rnatish)

```bash
npm run build:pwa
```

Tayyor PWA fayllari `dist/` papkasiga chiqadi. Shu papkani Netlify, Vercel yoki boshqa HTTPS hostingga joylashtiring. `dist/` ichida `index.html`, `manifest.json`, `sw.js`, `icon-192.png` va `icon-512.png` bir joyda bo‘ladi. Android Chrome’da “Install app” orqali o‘rnatiladi; iPhone’da Safari → Share → Add to Home Screen tanlanadi. PWA o‘rnatilishi uchun hosting HTTPS bo‘lishi kerak (localhost test uchun istisno).

## Imkoniyatlar

- Yangi mijoz va ijara yaratish
- Cheklanmagan miqdorda anjom turi qo‘shish
- Real-time ijara qarzi
- Qisman va to‘liq qaytarish
- Qaytarilgan miqdor hisobini muzlatish
- Yakunlangan ijaralar tarixi
- Native Share oynasi orqali elektron chek ulashish
- Har bir yangi ijara va qaytarishdan keyin avtomatik chek
- Chekni PDF qilib yuklab olish yoki Files/Downloads orqali saqlash
- Chekni printerda chop etish
- Mijoz raqami va tayyor matn bilan SMS oynasini ochish
- SMS, Telegram yoki WhatsApp birlamchi kanal sozlamasi
- SQLite ma’lumotlar bazasi

SMS/Telegram/WhatsApp’ga avtomatik server orqali yuborish uchun production backend va provayder API kalitlari alohida ulanadi.
