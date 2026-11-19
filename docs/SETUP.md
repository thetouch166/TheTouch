# The Touch — Website, Admin & POS · Go-live guide

## ⚡ Final 3 steps (account → key → domain)
1. **Account:** go to console.firebase.google.com and create the project `the-touch`. Enable **Firestore** (paste the rules below) and **Authentication → Email/Password**. Add a staff user under Authentication → Users.
2. **Key:** open Project settings → Your apps → Web app, copy `firebaseConfig`, and paste it into `public/js/config.js` as `window.TT_FIREBASE = {…}`. This web key is meant to be public; the rules below keep orders and admin data private.
3. **Domain:** drag the `public/` folder onto Cloudflare Pages (Workers & Pages → Create → Pages → Upload assets) or app.netlify.com/drop. In Netlify go to Domain management → Add a domain (e.g. `thetouch.ae`) and add the DNS records Netlify shows you at your domain registrar. HTTPS turns on automatically. Then in Firebase go to Authentication → Settings → **Authorized domains** → add `thetouch.ae` and `www.thetouch.ae`.

**Test after going live:** open `https://yourdomain/admin.html` on the shop laptop, sign in, and open a shift. On your phone, place an order on `https://yourdomain`. The laptop should chime within about 2 seconds. Then set the real prices in Products and the TRN in Settings.


## What's in the folder
| File | What it is |
|---|---|
| `public/index.html` | Customer website (shop, gifting, events, checkout) |
| `public/admin.html` | Admin panel + POS (open on the shop laptop/tablet) |
| `public/js/config.js` | Switch between Offline mode and Live mode |
| `public/js/store.js` | Shared catalogue, prices, settings, data layer |
| `public/img/` | Product photos and logos |

**Admin login (offline mode): PIN `1234`.** Change it in Admin → Settings.

---

## Two modes

**Offline mode (default, works right now)**
Everything is saved inside the browser on that one device. The POS works fully on the shop laptop, even without internet.
⚠️ In this mode, orders placed on a customer's phone **do not** reach the shop laptop. Customers can still tap "Send order on WhatsApp" after checkout, so you won't lose orders.

**Live mode (recommended before launch, about 15 minutes, free)**
Website orders appear on the admin screen instantly, with a sound alert, on any device.

### Switch to Live mode (Firebase, free Spark plan)
1. Go to https://console.firebase.google.com → **Add project** → name it `the-touch` (Analytics: off).
2. **Build → Firestore Database → Create database** → Production mode → region `europe-west` or `me-central` (closest to the UAE).
3. **Firestore → Rules**: paste the rules below → **Publish**.
4. **Build → Authentication → Get started → Email/Password → Enable.** Then **Users → Add user** (for example `admin@thetouch.ae` + a strong password). Add one user per staff member.
5. **Project settings (⚙) → Your apps → Web `</>`** → register the app → copy the `firebaseConfig` object.
6. Paste it into `public/js/config.js` as `window.TT_FIREBASE = { ... }`.
7. Open `admin.html` and sign in with the email and password. The catalogue is created automatically the first time.
8. Deploy (see below). Open the website, place a test order, and watch it arrive in Admin → Orders.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    function staff() { return request.auth != null; }
    match /products/{id}  { allow read: if true;  allow write: if staff(); }
    match /settings/{id}  { allow read: if true;  allow write: if staff(); }
    match /orders/{id} {
      allow create: if staff() || (
        request.resource.data.channel == 'web' &&
        request.resource.data.status == 'new' &&
        request.resource.data.stockApplied == false &&
        request.resource.data.payment.paid == false &&
        request.resource.data.payment.method in ['cod', 'card_on_delivery', 'link'] &&
        request.resource.data.items is list && request.resource.data.items.size() > 0 && request.resource.data.items.size() < 50 &&
        request.resource.data.total is number && request.resource.data.total > 0
      );
      allow read, update, delete: if staff();
    }
    match /enquiries/{id} {
      allow create: if true;
      allow read, update, delete: if staff();
    }
    match /shifts/{id} { allow read, write: if staff(); }
  }
}
```

---

## Put the website online (pick one)
- **Netlify (easiest):** go to https://app.netlify.com/drop and drag the `public/` folder in. You get a link right away. Then go to Domain settings → add `thetouch.ae` (or your domain) and update DNS at your registrar.
- **Firebase Hosting:** run `npm i -g firebase-tools` → `firebase login` → `firebase init hosting` (public dir = this folder) → `firebase deploy`.

The site is static HTML, so it's very fast and has no server to maintain.

---

## Shop setup (POS)
- **Laptop/tablet:** open `https://yourdomain/admin.html` in Chrome → menu → **Install app / Add to Home screen**, so it opens full-screen like a till.
- **Receipt printer:** any 80 mm USB or Bluetooth thermal printer (Epson TM-T20, Xprinter, etc.). In Chrome's print dialog, choose the printer, set margins to *None* and turn off headers/footers. Tick "Always use this" for one-tap printing.
- **Card payments:** charge the card on the UTap/e& terminal, then press **Card** in the POS (you can add the approval number).
- **Barcode scanner (optional):** any USB scanner works. Scan into the search box and press Enter. Set each product's code in Products.
- **Sold-by-weight pralines:** tap the product → enter grams (or use the 100/250/500 g/1 kg buttons). Stock is tracked in kg.

## Daily routine (POS v2)
- **Open shift:** after login, enter your name and the opening cash in the drawer. Each laptop or tablet runs its own shift.
- **Walk-in sale:** tap products → **Charge** → Cash / Card / Split.
- **Phone or WhatsApp order:** in the sale panel switch to **Pick-up** or **Delivery** → set date, slot, address, gift message → add the client → **Take order** → take payment now or choose **Pay later**. The order goes to the Orders board.
- **Orders board:** drag nothing, just tap **→ next step** on each card. Use **Send to driver** to share the delivery details on WhatsApp.
- **Collect payment later:** open the order → **Mark as paid** → Cash / Card / Link. It's counted in the current shift.
- **Close shift:** tap the green shift pill → count the cash → the system shows over/short → prints the shift report.

## Daily checklist
1. Morning: Admin → **Orders → Open** to see today's deliveries and pick-ups.
2. New website order → chime + gold banner → **Confirmed** (stock is deducted) → **Preparing** → **Ready/Out for delivery** → **Completed** (it asks whether payment was collected).
3. Closing: **Reports → Today → Day-end report** (print, count the cash, sign).
4. Weekly: **Settings → Backup** (JSON) and **Reports → Export CSV** for the accountant.

## Before launch: please check
- [ ] **Prices are placeholders.** Edit them in Admin → Products (pralines are priced per kg).
- [ ] Add your **VAT TRN** in Settings so it prints on tax invoices.
- [ ] Check delivery fees per emirate, the free-delivery threshold and the same-day cut-off.
- [ ] Confirm the WhatsApp number (currently 971526633823) and the email.
- [ ] Online card payments: today customers choose cash/card on delivery or a payment link sent on WhatsApp (e.g. a UTap/Network/Stripe link). A fully automatic card checkout can be added later with a payment-gateway account.
