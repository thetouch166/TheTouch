# The Touch — Website, Admin & POS

Luxury chocolate boutique in Abu Dhabi ("The Touch", @the.touch.chocolates). This repo holds the customer
website, the admin panel and the in-store POS. **Launch target: 20 Nov 2026.** Owner/dev: Natinael Eliyas.

Design reference: bateel.com (elegant, airy, premium). Every change must keep that luxury feel.

## Stack (keep it this way)
- Plain static files: **vanilla HTML + CSS + JavaScript, no framework, no build step, no npm dependencies.**
- Hosting: Cloudflare Pages, deployed with `npx wrangler pages deploy` (wrangler.toml → `public/` + `functions/`).
- API: `functions/api/[[path]].js` (Pages Functions) → **Neon Postgres over HTTPS (no driver package)**, photos in
  **R2** (binding `PHOTOS`, served by `functions/media/`), emails via **Resend**. Staff auth = `STAFF_LOGINS` secret
  (email:password; …) → HMAC token in localStorage `tt_tok`. Public access rules live in the API (`publicCreateOk`).
- `public/js/config.js` sets `window.TT_API='/api'` (live) except on port 5500 → **offline mode** (localStorage) for dev/tests.

## Layout
```
public/                 ← the static site (wrangler deploys it together with functions/)
  index.html            customer website (single-page app, hash routes)
  admin.html            admin panel + POS (single file)
  js/config.js          TT_API: '/api' live · null offline (port 5500)
  js/store.js           shared data layer + catalogue seed + utils  → window.TT
  img/                  product photos (square, near-white bg) + logos
functions/api/[[path]].js   API: Neon (table docs(col,id,data jsonb,updated,deleted)), auth, rules, R2 upload, Resend
functions/media/[[path]].js R2 photos at /media/p/… (immutable cache)
wrangler.toml           Cloudflare Pages project, R2 binding, MAIL_FROM / SHOP_EMAIL
docs/SETUP.md           go-live guide (Cloudflare, Neon, R2, Resend, printer, daily routine)
docs/LAUNCH-CHECKLIST.md  tomorrow's checklist (tick as you go)
docs/BACKLOG.md         known issues + later upgrades
tests/smoke_test.py     Playwright end-to-end smoke test (offline; --live against wrangler pages dev)
```

## Run locally
- VS Code: install the recommended **Live Server** extension → right-click `public/index.html` → "Open with Live Server"
  (settings already point Live Server at `public/`). Or: `cd public && python -m http.server 5500`.
- Website: http://localhost:5500/index.html · Admin/POS: http://localhost:5500/admin.html (offline PIN **1234**).
- Reset local data: Admin → Settings → "Reset demo data", or clear localStorage keys starting with `tt_`.

## Data layer — `public/js/store.js` (window.TT)
- `TT.DB` = backend with the SAME API in both modes: `init, all(col), get(col,id), put(col,obj), patch(col,id,part),
  inc(col,id,field,delta), del(col,id), watch(col,cb) → unsubscribe, signIn, signOut, isAdmin`, plus `DB.mode`
  (`'local'` | `'live'`), `upload(dataUrl)→url` (R2 in live, data URL offline). Always go through `TT.DB`.
- Live `watch` = initial load + admin polls `/api/sync?since=` every 5 s (paused while the tab is hidden), website
  re-reads products every 60 s (edge-cached 60 s, purged on staff writes). Writes apply locally at once (optimistic).
- Collections: `products`, `orders`, `settings` (doc id `main`), `enquiries`, `shifts`, `stock` (stock movement log), `subscribers` (newsletter `{id,email,created,source}`; public create-only).
- `TT.boot({admin})` loads settings + products (seeds the catalogue when empty). `TT.U` = utils
  (`money, r2, uid, orderNo, esc, vatPart, lineTotal, qtyLabel, dayKey, fmtTime, compressImage`).
- `TT.cleanOrder(o)` normalises/sanitises every order read by the admin (protects against malformed or
  malicious web orders; flags `o.tampered` when totals don't match lines). Keep it in the admin's orders watcher.
- Prices are **AED, VAT-inclusive (5%)**: `vat = total − total/1.05` (`U.vatPart`). Use `U.r2` for money math.

### Shapes (do not rename fields — stored data and the API's checks depend on them)
- **product**: `{id, sku, name, ar, cat, unit:'kg'|'pc', price, stock, min, img, desc, active, featured, updated}`
  — `min` = low-stock alert level (optional; default 2 kg / 5 pcs, see `lowLevel()`)
  — `unit:'kg'` → price per kg, stock in kg, sold by grams.
- **order**: `{id, no, channel:'web'|'pos', status:'new'|'confirmed'|'preparing'|'ready'|'completed'|'cancelled',
  created, customer:{name,phone,email}, fulfil:'instore'|'pickup'|'delivery', emirate, area, address, date, slot,
  gift:{to,phone,msg}, notes, items:[{pid,name,unit,price,grams,qty,disc}], subtotal, discount, delivery, total, vat,
  payment:{method, paid, cash, card, other, tendered, change, ref, paidAt, paidShift}, stockApplied, cashier, shiftId}`
- **shift**: `{id, cashier, openedAt, float, status, closedAt, counted, expected, cash, card, other, variance}`
- **stock** (movement log): `{id, pid, name, unit, type:'receive'|'count'|'remove'|'adjust', qty, before, after, note, by, at}`
- Stock rule: POS sales deduct at sale; web orders deduct when moved past `new`; cancel/void restores
  (`applyStock` in admin.html, guarded by `order.stockApplied`).

## admin.html map (search these section comments)
`/* === HOME / DASHBOARD === */` renderHome · `/* === POS === */` renderPOS, drawTiles, drawTicket, weighModal,
customItem, detailsModal, custModal, discModal, heldModal, startPay, payModal, doneModal, receiptHTML · invoice: invoiceCanvas (WhatsApp image), invoiceA4 (print/PDF), invoiceModal ·
`/* === ORDERS === */` renderOrders, drawBoard, drawList, orderHTML, bindOrder, markPaid, setStatus ·
`/* === PRODUCTS === */` renderProducts, productModal, stockModal, stockHistory, stockCSV, countSheet · REPORTS renderReports, exportCSV · CLIENTS clientStats ·
EVENTS renderEvents · SETTINGS renderSettings. Shared helpers at the top: toast, modal, ask (in-app confirm —
never use window.confirm/alert), chime, waLink, applyStock, shift functions (openShiftModal, closeShiftModal).

### Admin language & theme (per device, localStorage `tt_lang` / `tt_theme`)
- Arabic/English: UI is written in English; in Arabic mode a MutationObserver (`/* === language === */` block, `AR`
  dictionary + `AR_RX` patterns) translates text, placeholders, aria-labels and titles, and the page is `dir="rtl"`.
  **When you add UI text, add its Arabic to `AR`.** Mark elements that must stay English with `data-en`; receipts,
  invoices, CSVs and printouts (`#printArea`, `.rcpt`, `.inv4`) are never translated. `pn(p)` shows `p.ar` in Arabic.
  CSS uses logical properties (margin-inline-start, text-align:start…) so layouts mirror; `<option>` without a
  `value` is not translated (its text is its value).
- Dark/Light: colours are tokens in `:root` / `:root[data-theme=dark]` (`--card --soft --hd --acc --on-acc …`).
  Use tokens, not hex, for new UI. Product photo wells stay cream; print stays light.

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
- Live mode: `.dev.vars` (test Neon DATABASE_URL + `STAFF_LOGINS="owner@thetouch.ae:secret123"`) →
  `npx wrangler pages dev --port 8788` → `python tests/smoke_test.py --live`. Never use the shop's database for tests.
- After any change: run the smoke test and check the browser console for errors on both pages.

## Go-live (see docs/LAUNCH-CHECKLIST.md)
1. Domain → Cloudflare nameservers (do first; DNS can take hours)
2. Neon project (Frankfurt) → pooled connection string
3. R2 bucket `the-touch-photos` → `wrangler pages deploy` → secrets DATABASE_URL, STAFF_LOGINS, RESEND_API_KEY → custom domains
4. Resend domain verify + Email Routing `hello@thetouchchocolate.com` → Gmail
5. Real prices, TRN, stock in Admin; shop laptop install + printer; run the launch test
6. Website online payments: Stripe — waiting for the client's account
