# The Touch — Website, Admin & POS

Luxury chocolate boutique in Abu Dhabi ("The Touch", @the.touch.chocolates). This repo holds the customer
website, the admin panel and the in-store POS. **Launch target: 20 Nov 2026.** Owner/dev: Natinael Eliyas.

Design reference: bateel.com (elegant, airy, premium). Every change must keep that luxury feel.

## Stack (keep it this way)
- Plain static files: **vanilla HTML + CSS + JavaScript, no framework, no build step, no npm dependencies.**
- Hosting: Cloudflare Pages, deployed with `npx wrangler pages deploy` (wrangler.toml → `public/` + `functions/`).
- API: `functions/api/[[path]].js` (Pages Functions) → **Neon Postgres over HTTPS (no driver package)**, photos in
  **Cloudflare KV** (binding `PHOTOS_KV`, served by `functions/media/`; R2 binding `PHOTOS` is optional and used when
  switched on). Public access rules live in the API (`publicCreateOk`).
- Staff sign-in: accounts are made in **Admin → Settings → Security** (database, col `staff`, hashed passwords; not
  reachable through /api/db) with a role: **owner** (everything) or **cashier** (sales, orders, shifts, stock counts —
  enforced in the API by `cashierCan`, the admin only hides the screens: `body.cashier`, `CASHIER()`). The `STAFF_LOGINS`
  secret (email:password; …) holds the developer owner login(s) that always work. Sessions = HMAC token in localStorage
  `tt_tok` (30 days; a password change or removal signs the person out). Endpoints: `/api/login`, `/api/me`, `/api/staff`,
  `/api/password`. Changing DATABASE_URL invalidates the admin-made passwords (the hash is keyed with it) — set
  `PASSWORD_PEPPER` first if the database ever moves.
- Email: boutique notifications (new web order, event enquiry, morning sales summary) go to the shop inbox through
  the **mail worker** (`mail-worker/`, Worker `the-touch-mail`, service binding `MAIL`, Cloudflare Email — no outside
  account). Customer confirmation emails go through **Resend** once `RESEND_API_KEY` is set. Cloudflare Email Routing
  forwards `hello@` and `orders@thetouchchocolate.com` to the shop Gmail.
- Card payment online: **Stripe Checkout** (no library — plain HTTPS calls). The website saves the order unpaid, `POST /api/pay/checkout`
  rebuilds the amount from our own prices and returns Stripe's payment page; the order is marked paid by the webhook
  `POST /api/pay/webhook` and by `GET /api/pay/confirm` on the confirmation page (`settle()`, runs once). Payment method id
  `card_online`, money stored in `payment.other`. One secret is enough: `STRIPE_SECRET_KEY` (set by the shop itself with
  `npx wrangler pages secret put STRIPE_SECRET_KEY --project-name the-touch`, then redeploy and `POST /api/pay/setup` as the owner: it
  checks the account and creates Stripe's webhook). Without `STRIPE_WEBHOOK_SECRET` (optional) every webhook message is treated as a
  hint and the payment is read again from Stripe. Switched on for customers in Admin → Settings → Online payment options →
  "Card online". Refunds are made in the Stripe dashboard.
- Order page + payment link: every website order carries a random `key`; `/order/<no>?k=<key>` is the customer's own page (thank-you,
  invoice, "Pay by card"), filled from `GET /api/order/<no>?k=` when opened on another device (no phone / e-mail / address in it).
  Admin → order → **Payment link** calls `POST /api/pay/link` (staff): it stores `payment.linkTotal/linkAt/linkBy` (= this exact total is
  approved for card payment, 30 days) and returns the link to send on WhatsApp; `/api/pay/checkout` then accepts `{no,k}`. A website
  order can never set those fields itself (`publicCreateOk`).
- Card form on our own page: with `STRIPE_PUBLISHABLE_KEY` set (same mode as the secret key) `/api/pay/checkout {embed:true}` returns `{clientSecret, pk}` and the
  order page mounts Stripe's embedded Checkout (`ui_mode=embedded_page`, Stripe.js `https://js.stripe.com/endive/stripe.js`, `createEmbeddedCheckoutPage`;
  `startCardPayment`, `openPayForm`, `closePayForm`). Without the key, or if Stripe refuses, the customer pays on Stripe's page as before.
- Companies (B2B): **quotation → approval → invoice → payment → receipt**. Owner only: collections `quotes` + `companies` (Admin → Quotes). A sent
  quotation has a private page `/quote/<no>?k=<key>` (`pageQuote`; API `GET /api/quote/<no>?k=`, `POST /api/quote/<no>/approve|decline?k=`, once only).
  "Create invoice" turns an approved quotation into an order with `channel:'b2b'`, `company`, `quoteNo`, `po` (number `INV…`), which is sent and paid
  like a payment link; the paid order page offers "Print / save receipt" (`invoiceHTML(o,true)`; admin `invoiceA4(o,true)`).
  All three company documents use the boutique's own layout (the client's Word sample): **`TT.docHTML(kind, doc, settings, {bank})` + `TT.DOC_CSS` in
  `js/store.js`** — one renderer for the admin print and the company's pages (class names start with `td` so the site's styles cannot touch them).
  Legal name, payment terms, numbering (`quoteStart`, `invoiceStart` → `2026-005`, `INV-2026-001`, `nextDocNo`) and the bank details are edited in
  Admin → Settings → Company documents. `settings.bank` is removed from the public copy of the settings (`publicDoc`) and reaches a company only
  through its own quotation / invoice page. Never put real bank details in the code or the tests.
- Website menu: **Home · Shop (categories) · Occasions · About · Contact** (`renderNav`; menus open on hover and keyboard focus, the phone uses the drawer).
  **Occasions are managed in the admin** (Products → Occasions: add, rename, Arabic name, photo, order, show/hide, choose products; also chips on the
  product form): `settings.occasions [{id,name,ar,img,desc,on}]` + `product.occasions [ids]`, read through `TT.occasions()`. Pages `/occasions`,
  `/occasion/<id>` (an occasion without products shows a note and the most loved pieces), `/about` (old `/story` still works), `/contact` (details +
  a message form saved in `enquiries` with `type:'Message · …'`, listed in Admin → Events, now titled Enquiries & Messages; `settings.hours`, `settings.mapUrl`).
- New-order alert in the admin: pop-up with the order + sound (`orderAlert`, `showAlert`, `chime`, `ringStart`), settings per device in
  localStorage `tt_alert` (Settings → New-order alert). In a background tab the admin asks `GET /api/ping` every 20 s (KV key `sys:ping`,
  no database) and syncs only when it moved, so alerts keep working while the database can sleep.
- `public/js/config.js` sets `window.TT_API='/api'` (live) except on port 5500 → **offline mode** (localStorage) for dev/tests.

## Layout
```
public/                 ← the static site (wrangler deploys it together with functions/)
  index.html            customer website (single-page app, real paths: /p/<id>, /shop/<cat> …)
  robots.txt _headers _routes.json   search rules · headers for static files · admin + static folders bypass functions
  admin.html            admin panel + POS (single file)
  js/config.js          TT_API: '/api' live · null offline (port 5500)
  js/store.js           shared data layer + catalogue seed + utils  → window.TT
  img/                  product photos (square, near-white bg) + logos
functions/api/[[path]].js   API: Neon (table docs(col,id,data jsonb,updated,deleted)), auth, rules, photo upload, emails
functions/media/[[path]].js uploaded photos at /media/p/… (KV, immutable cache)
functions/[[path]].js       website pages: per-page title/description/canonical, share preview (Open Graph), Google data
                            (JSON-LD), no-script summary, /sitemap.xml, real 404s
functions/_middleware.js    www → main domain, the-touch.pages.dev kept out of search, security headers
mail-worker/            Worker the-touch-mail: boutique emails + 09:00 sales summary (deploy: cd mail-worker && npx wrangler deploy)
wrangler.toml           Cloudflare Pages project: SITE_URL, KV photos, MAIL service binding, MAIL_FROM / SHOP_EMAIL
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
- Live `watch` = initial load + admin polls `/api/sync?since=` every 5 s (tab hidden: `/api/ping` every 20 s, sync only on news), website
  re-reads products every 60 s (edge-cached 60 s, purged on staff writes). Writes apply locally at once (optimistic).
- Collections: `products`, `orders`, `settings` (doc id `main`), `enquiries`, `shifts`, `stock` (stock movement log), `subscribers` (newsletter `{id,email,created,source}`; public create-only),
  `quotes` and `companies` (owner only, see the shapes below).
- `TT.boot({admin})` loads settings + products (seeds the catalogue when empty). `TT.U` = utils
  (`money, r2, uid, orderNo, esc, vatPart, lineTotal, qtyLabel, dayKey, fmtTime, compressImage`).
- `TT.cleanOrder(o)` normalises/sanitises every order read by the admin (protects against malformed or
  malicious web orders; flags `o.tampered` when totals don't match lines). Keep it in the admin's orders watcher.
- Prices are **AED, VAT-inclusive (5%)**: `vat = total − total/1.05` (`U.vatPart`). Use `U.r2` for money math.

### Shapes (do not rename fields — stored data and the API's checks depend on them)
- **product**: `{id, sku, name, ar, cat, unit:'kg'|'pc', price, stock, min, img, desc, active, web, featured, occasions:[occasion ids], updated}`
  — `web:false` = sold in the boutique (POS) only: hidden from the website, its sitemap and saved bags
  — `min` = low-stock alert level (optional; default 2 kg / 5 pcs, see `lowLevel()`)
  — `unit:'kg'` → price per kg, stock in kg, sold by grams.
- **order**: `{id, no, channel:'web'|'pos'|'b2b' (b2b = company invoice: also `company:{id,name,trn,address,contact,phone,email}`, `quoteNo`, `quoteId`, `po`), status:'new'|'confirmed'|'preparing'|'ready'|'completed'|'cancelled',
  created, customer:{name,phone,email}, fulfil:'instore'|'pickup'|'delivery', emirate, area, address, date, slot,
  gift:{to,phone,msg}, notes, items:[{pid,name,unit,price,grams,qty,disc, desc?, orig?}] (desc = second line, orig = list price before a discount; company documents), subtotal, discount, delivery, total, vat,
  payment:{method, paid, cash, card, other, tendered, change, ref, paidAt, paidShift, linkTotal, linkAt, linkBy}, stockApplied, cashier, shiftId, key}`
- **quote**: `{id, no:'Q…', status:'draft'|'sent'|'approved'|'declined'|'invoiced' (shown as expired when sent and past `validUntil`), created, key, company:{…},
  subject, items:[order lines], subtotal, discount, delivery, total, vat, fulfil:'delivery'|'pickup', date, validUntil, notes, terms, sentAt,
  approval:{at,name,po,note,manual,by}, declined:{at,name,reason}, orderId, orderNo, invoicedAt, by}` · **company**: `{id,name,trn,address,contact,phone,email,notes,created}`
- **shift**: `{id, cashier, openedAt, float, status, closedAt, counted, expected, cash, card, other, variance}`
- **stock** (movement log): `{id, pid, name, unit, type:'receive'|'count'|'remove'|'adjust', qty, before, after, note, by, at}`
- Stock rule: POS sales deduct at sale; web orders deduct when moved past `new`; cancel/void restores
  (`applyStock` in admin.html, guarded by `order.stockApplied`).

## admin.html map (search these section comments)
`/* === HOME / DASHBOARD === */` renderHome · `/* === POS === */` renderPOS, drawTiles, drawTicket, weighModal,
customItem, detailsModal, custModal, discModal, heldModal, startPay, payModal, doneModal, receiptHTML · invoice: invoiceCanvas (WhatsApp image), invoiceA4 (print/PDF), invoiceModal ·
`/* === ORDERS === */` renderOrders, drawBoard, drawList, orderHTML, bindOrder, payLink, waClientText, markPaid, setStatus · new-order alert pop-up: orderAlert, showAlert, alertBody ·
`/* === PRODUCTS === */` renderProducts, productModal, stockModal, stockHistory, stockCSV, countSheet · REPORTS renderReports, exportCSV · CLIENTS clientStats ·
EVENTS renderEvents · `/* === QUOTATIONS FOR COMPANIES === */` renderQuotes, companyForm, quoteForm, openQuote, sendQuote, markApproved, quoteToInvoice, invoiceSend, quoteA4, watchQuotes · SETTINGS renderSettings. Shared helpers at the top: toast, modal, ask (in-app confirm —
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
Router `route()` on real paths (History API; `go(path)` to navigate from code, old `#/…` links are converted):
`/` pageHome · `/shop/<cat>` pageShop · `/p/<id>` pageProduct · `/checkout` pageCheckout · `/order/<no>?k=<key>` pageOrder (invoiceHTML, waOrderText) · `/quote/<no>?k=<key>` pageQuote (quoteHTML) ·
`/occasions` pageOccasions · `/occasion/<id>` pageOccasion · `/about` (+ `/story`) pageAbout · `/contact` pageContact · `/events` · `/delivery` · `/privacy` `/terms` `/refunds` pageLegal · anything else pageNotFound.
**A new page or category must be added in three places:** `route()` + `PAGE_META` here, `PAGES`/`CATS` in
`functions/[[path]].js` (server titles, sitemap), and `CATS` in `js/store.js`. Links are written as real paths
(`href="/shop/all"`); `<base href="/">` keeps relative assets working on deep addresses.
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
- Card payment, payment link, order page and new-order alert: `node tests/mock_stripe.js` + the live-mode server, then
  `python tests/pay_test.py <folder>` and `python tests/order_link_test.py <folder>`; sign-in and roles: `python tests/auth_test.py <folder>`.
  `python tests/pay_setup_test.py` covers the shop's real setup (key only): run it with `STRIPE_WEBHOOK_SECRET` commented out in `.dev.vars`.
  `python tests/site_test.py <folder>` covers the website structure (occasions from the admin, menus, About, Contact form, checkout).
  `python tests/quote_test.py <folder>` runs the company flow (company → quotation → approval → invoice → card payment → receipt). The on-site card form
  itself can only be tried against Stripe's test mode (real `sk_test_`/`pk_test_` keys passed with `--binding`), not against the stand-in.
- After any change: run the smoke test and check the browser console for errors on both pages.

## Go-live (see docs/LAUNCH-CHECKLIST.md)
1. Domain → Cloudflare nameservers (do first; DNS can take hours)
2. Neon project (Frankfurt) → pooled connection string
3. `cd mail-worker && npx wrangler deploy` (+ secret DATABASE_URL) → `npx wrangler pages deploy --branch main` →
   secrets DATABASE_URL, STAFF_LOGINS (+ RESEND_API_KEY for customer emails) → custom domains
4. Email Routing `hello@` / `orders@thetouchchocolate.com` → shop Gmail (done); Resend domain verify for customer emails
5. Real prices, TRN, stock in Admin; shop laptop install + printer; run the launch test
6. Website online payments: Stripe — waiting for the client's account
