# The Touch — Go-Live Checklist (20 Nov 2026)

Order for the day: **3A (domain) → 2 (Firebase) → 1 (content) → 3B–C (upload + domain) → 4 (email) → 5 (shop) → 6 (launch test) → 7 (go live)**.
Start with the domain: a nameserver change can take up to 24 hours.

## 1. Fixes and content
All known bugs are fixed and tested. What's left is real content from the client.
- [ ] Real **price list** (pralines per kg, bars and gifts per piece)
- [ ] **VAT TRN** → Admin → Settings (receipts say "RECEIPT" until it's set, then "TAX INVOICE")
- [ ] Delivery fees per emirate, free-delivery minimum (now AED 300 in Abu Dhabi), same-day cut-off (now 2 PM)
- [ ] WhatsApp number for orders (now +971 52 663 3823), email, Instagram, boutique address
- [ ] Product list: missing items, names, Arabic spelling, which are "Signature"
- [ ] Starting **stock** (kg for pralines, pieces for the rest)
- [ ] Optional: real photos for the gift tray and the 500 g box
- [ ] Change the offline PIN 1234 / create real staff logins (live mode)

## 2. Database — Firebase (~20 min, free)
1. console.firebase.google.com → Add project `the-touch` (Analytics off), on the client's Google account.
2. Build → Firestore Database → Create (Production mode, region near UAE).
3. Firestore → Rules → paste `firestore.rules` from this repo → Publish.
4. Authentication → Get started → Email/Password → Enable.
5. Authentication → Users → Add user for the owner and each staff member.
6. Project settings → Your apps → Web `</>` → copy `firebaseConfig`.
7. Paste it into `public/js/config.js` as `window.TT_FIREBASE = { ... };`
- [ ] Project created · [ ] Rules published · [ ] Email/Password on · [ ] Staff users added · [ ] Key pasted

## 3. Domain + hosting — Cloudflare
**A. Domain to Cloudflare (do first)**: dash.cloudflare.com → Add a domain → Free plan → copy the 2 nameservers → set them at the registrar → wait for "Active".
**B. Upload**: Workers & Pages → Create application → Pages → Upload assets → project `the-touch` → drag the **`public/` folder** → Deploy (live at `the-touch.pages.dev`).
**C. Connect**: Pages project → Custom domains → add `thetouch.ae` and `www.thetouch.ae`. Then Firebase → Authentication → Settings → Authorized domains → add both + `the-touch.pages.dev`.
- [ ] Nameservers changed · [ ] Domain Active · [ ] Site on pages.dev · [ ] Custom domains + padlock · [ ] Firebase authorized domains

Updating later: Pages project → Create new deployment → drag `public/` again. Prices/products/settings are changed in the admin, no re-upload.

## 4. Email — hello@thetouch.ae (~15 min, free)
Receive: Cloudflare → domain → Email → Email Routing → enable → verify the Gmail destination → Routes → Create address `hello` → Send to the Gmail. Test from a different account.
Send: Gmail account with 2-Step Verification → App password → Gmail Settings → Accounts and Import → Send mail as → `hello@thetouch.ae`, SMTP `smtp.gmail.com`, port 587, Gmail address + app password → confirm the code.
- [ ] Forwarding works · [ ] Send-as works · [ ] Email updated in Admin → Settings
(For full separate mailboxes use a paid provider such as Google Workspace instead.)

## 5. Shop setup (~30 min)
- [ ] Shop laptop/tablet: open `https://thetouch.ae/admin.html` in Chrome, sign in
- [ ] Chrome → Install app (full-screen POS)
- [ ] Allow notifications, volume up (new-order chime)
- [ ] 80 mm receipt printer: test print (margins None, headers off, always use this printer)
- [ ] Card machine: charge on terminal, then press Card in POS
- [ ] Optional USB barcode scanner + product codes
- [ ] Open a real shift; show staff the routine (docs/SETUP.md)

## 6. Launch test (two devices: shop laptop + your phone)
- [ ] Admin shows **Live · synced**
- [ ] `https://thetouch.ae` and `www` load with padlock
- [ ] Phone: delivery order (cash on delivery, gift message) → laptop chimes, order on board
- [ ] Confirm → stock down; Cancel → stock back
- [ ] Pick-up order → Completed → record payment as Card
- [ ] Event enquiry appears under Events
- [ ] POS cash sale with change; printed receipt shows TRN + "TAX INVOICE"
- [ ] Change a price in admin → product page shows it
- [ ] Close shift → expected cash matches the drawer
- [ ] Email to hello@ reaches Gmail
- [ ] Void test orders, set real stock, open a fresh shift

If something fails, check: key in `public/js/config.js` → rules published → domain in Firebase Authorized domains → staff user exists.

## 7. Go live + first week
- [ ] Announce on Instagram, link in bio, WhatsApp Business profile
- [ ] Daily: work the Orders board, close shift + day-end report
- [ ] Weekly: Settings → Backup, Reports → Export CSV
- [ ] Watch low stock on Home
