# The Touch — Website, Admin & POS

Luxury chocolate boutique in Abu Dhabi ("The Touch", @the.touch.chocolates). This repo holds the customer
website, the admin panel and the in-store POS. **Launch target: 20 Nov 2026.** Owner/dev: Natinael Eliyas.

Design reference: bateel.com (elegant, airy, premium). Every change must keep that luxury feel.

## Stack (keep it this way)
- Plain static files: **vanilla HTML + CSS + JavaScript, no framework, no build step, no npm dependencies.**
- Hosting: Cloudflare Pages (upload the `public/` folder only).
- Database: Firebase Firestore + Firebase Auth (email/password for staff), loaded from the gstatic CDN
  (compat SDK v10) only when `public/js/config.js` sets `window.TT_FIREBASE`.
- Without a Firebase config the app runs in **offline mode** (localStorage on one device) — used for dev/tests.

## Layout
```
public/                 ← deploy this folder (Cloudflare Pages "Upload assets")
  index.html            customer website (single-page app, hash routes)
  admin.html            admin panel + POS (single file)
  js/config.js          Firebase web config (null = offline mode)
  js/store.js           shared data layer + catalogue seed + utils  → window.TT
  img/                  product photos (square, near-white bg) + logos
firestore.rules         security rules to paste into Firebase → Firestore → Rules
docs/SETUP.md           go-live guide (Firebase, Cloudflare, email, printer, daily routine)
docs/LAUNCH-CHECKLIST.md  tomorrow's checklist (tick as you go)
docs/BACKLOG.md         known issues + later upgrades
tests/smoke_test.py     Playwright end-to-end smoke test (offline mode)
tests/fake_firebase.js  in-memory Firebase stand-in to test live mode without an account
```

## Run locally
- VS Code: install the recommended **Live Server** extension → right-click `public/index.html` → "Open with Live Server"
  (settings already point Live Server at `public/`). Or: `cd public && python -m http.server 5500`.
- Website: http://localhost:5500/index.html · Admin/POS: http://localhost:5500/admin.html (offline PIN **1234**).
- Reset local data: Admin → Settings → "Reset demo data", or clear localStorage keys starting with `tt_`.

## Data layer — `public/js/store.js` (window.TT)
- `TT.DB` = backend with the SAME API in both modes: `init, all(col), get(col,id), put(col,obj), patch(col,id,part),
  inc(col,id,field,delta), del(col,id), watch(col,cb) → unsubscribe, signIn, signOut, isAdmin`, plus `DB.mode`
  (`'local'` | `'live'`). Always go through `TT.DB`; never call localStorage/Firestore directly for business data.
- Collections: `products`, `orders`, `settings` (doc id `main`), `enquiries`, `shifts`.
- `TT.boot({admin})` loads settings + products (seeds the catalogue when empty). `TT.U` = utils
  (`money, r2, uid, orderNo, esc, vatPart, lineTotal, qtyLabel, dayKey, fmtTime, compressImage`).
- `TT.cleanOrder(o)` normalises/sanitises every order read by the admin (protects against malformed or
  malicious web orders; flags `o.tampered` when totals don't match lines). Keep it in the admin's orders watcher.
- Prices are **AED, VAT-inclusive (5%)**: `vat = total − total/1.05` (`U.vatPart`). Use `U.r2` for money math.

### Shapes (do not rename fields — stored data and Firestore rules depend on them)
- **product**: `{id, sku, name, ar, cat, unit:'kg'|'pc', price, stock, img, desc, active, featured, updated}`
  — `unit:'kg'` → price per kg, stock in kg, sold by grams.
- **order**: `{id, no, channel:'web'|'pos', status:'new'|'confirmed'|'preparing'|'ready'|'completed'|'cancelled',
  created, customer:{name,phone,email}, fulfil:'instore'|'pickup'|'delivery', emirate, area, address, date, slot,
  gift:{to,phone,msg}, notes, items:[{pid,name,unit,price,grams,qty,disc}], subtotal, discount, delivery, total, vat,
  payment:{method, paid, cash, card, other, tendered, change, ref, paidAt, paidShift}, stockApplied, cashier, shiftId}`
- **shift**: `{id, cashier, openedAt, float, status, closedAt, counted, expected, cash, card, other, variance}`
- Stock rule: POS sales deduct at sale; web orders deduct when moved past `new`; cancel/void restores
  (`applyStock` in admin.html, guarded by `order.stockApplied`).

## admin.html map (search these section comments)
`/* === HOME / DASHBOARD === */` renderHome · `/* === POS === */` renderPOS, drawTiles, drawTicket, weighModal,
customItem, detailsModal, custModal, discModal, heldModal, startPay, payModal, doneModal, receiptHTML ·
`/* === ORDERS === */` renderOrders, drawBoard, drawList, orderHTML, bindOrder, markPaid, setStatus ·
`/* === PRODUCTS === */` renderProducts, productModal · REPORTS renderReports, exportCSV · CLIENTS clientStats ·
EVENTS renderEvents · SETTINGS renderSettings. Shared helpers at the top: toast, modal, ask (in-app confirm —
never use window.confirm/alert), chime, waLink, applyStock, shift functions (openShiftModal, closeShiftModal).

## index.html map
Router `route()` on `location.hash`: `#/` pageHome · `#/shop/<cat>` pageShop · `#/p/<id>` pageProduct ·
`#/checkout` pageCheckout · `#/order/<no>` pageOrder · `#/story` · `#/events` · `#/delivery`.
Cart = `Cart` object in localStorage `tt_cart`; `syncCart()` re-prices lines from the live catalogue before
checkout. Dates/cut-offs use Dubai time via `dxbNow()`.

## Conventions
- Brand: burgundy `#40050e`, gold `#cd9754`, caramel `#9c6036`, cocoa `#39261f`, cream `#f8f3ec`;
  fonts Cormorant Garamond (headings) + Montserrat (body). CSS variables live in each file's `:root`.
- Escape every user/DB string you render with `U.esc()` / `esc()`.
- Mobile-first; tap targets ≥ 44px; test at 390×844, 820×1180, 1180×820, 1440×900.
- Keep each file self-contained (inline CSS/JS). No new libraries without asking.
- Make small, focused changes; don't reformat whole files (they are long single files).

## Testing
- `pip install playwright && playwright install chromium`, start the local server on port 5500, then
  `python tests/smoke_test.py` (website order → admin → POS sale → shift close; prints PASS/FAIL).
- Live mode without an account: see `tests/smoke_test.py --live` (serves `fake_firebase.js` instead of the CDN).
- After any change: run the smoke test and check the browser console for errors on both pages.

## Go-live (see docs/LAUNCH-CHECKLIST.md)
1. Domain → Cloudflare nameservers (do first; DNS can take hours)
2. Firebase project, publish `firestore.rules`, enable Email/Password, add staff users, paste config in `public/js/config.js`
3. Cloudflare Pages → upload `public/` → custom domains `thetouch.ae` + `www` → add both in Firebase Authorized domains
4. Email Routing `hello@thetouch.ae` → Gmail; Gmail "Send mail as"
5. Real prices, TRN, stock in Admin; shop laptop install + printer; run the launch test
