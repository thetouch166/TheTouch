# The Touch — Website, Admin & POS · Go-live guide

## How it runs
| Part | Service | Cost |
|---|---|---|
| Website + admin + API, worldwide CDN | **Cloudflare Pages** (+ Pages Functions in `functions/`) | Free |
| Orders, products, shifts, stock, clients | **Neon** Postgres (region Frankfurt) | Free plan, or Launch ≈ USD 5–10 a month |
| Product photos uploaded in the admin | **Cloudflare R2** bucket `the-touch-photos` | Free up to 10 GB (card needed to activate) |
| Order and enquiry emails | **Resend**, from `orders@thetouchchocolate.com` | Free up to 3,000 a month |
| Receiving mail at `hello@thetouchchocolate.com` | **Cloudflare Email Routing** → Gmail | Free |

The browser never talks to the database directly. `functions/api/[[path]].js` checks every request.
- The public can only read products and settings (the PIN is hidden). It can only create a web order (unpaid, status *new*), an event enquiry or a newsletter sign-up.
- Everything else needs a staff sign-in.
- The database table is created automatically on the first request.

## Secrets (Cloudflare → Workers & Pages → the-touch → Settings → Variables and secrets → Add → type **Secret**)
| Name | Value |
|---|---|
| `DATABASE_URL` | Neon → project → **Connect** → *Connection pooling ON* → the `postgresql://…` string |
| `STAFF_LOGINS` | Who can open the admin. Format: `owner@thetouch.ae:LongPassword1; shop@thetouch.ae:LongPassword2`. Use a `;` between people and no `;` inside passwords. Removing someone signs them out everywhere. |
| `RESEND_API_KEY` | Resend → API Keys → Create (Sending access, domain thetouchchocolate.com) |

`MAIL_FROM` and `SHOP_EMAIL` are plain settings in `wrangler.toml`. After changing a secret, deploy again (or Deployments → ⋯ → Retry deployment).

## Deploy / update the site (from this folder, on the dev laptop)
```
npx wrangler login                     # once: a browser opens, click Allow
npx wrangler pages deploy              # uploads public/ + functions/ (settings come from wrangler.toml)
```
- Once only, before the first deploy:
  - `npx wrangler pages project create the-touch --production-branch main`
  - `npx wrangler r2 bucket create the-touch-photos`
- Drag-and-drop upload in the dashboard does **not** include the API. Always deploy with the command above.
- Prices, products, stock and settings are changed in the admin. They don't need a re-deploy.

## Custom domain
Workers & Pages → the-touch → **Custom domains** → Set up a domain → `thetouchchocolate.com`, then again for `www.thetouchchocolate.com`. The domain must already be on Cloudflare. The padlock (HTTPS) appears by itself within minutes.

## Email
- **Sending (Resend):**
  1. resend.com → Domains → Add domain → `thetouchchocolate.com` (region Ireland).
  2. Add the DNS records it shows in Cloudflare → DNS. Use *DNS only* (grey cloud). If Resend offers to configure Cloudflare automatically, use that instead.
  3. Wait for "Verified", then create the API key (above).
  4. Also add a TXT record `_dmarc` = `v=DMARC1; p=none;` so Gmail trusts the emails.
- **Receiving (hello@):** Cloudflare → thetouchchocolate.com → **Email → Email Routing** → Get started → create address `hello` → destination = the client's Gmail → verify the Gmail link.
- What gets sent:
  - A new web order emails `SHOP_EMAIL` with all details and an "Open the admin" button, and emails the customer (if they gave an email) a thank-you with the order summary and a WhatsApp button.
  - A new event enquiry emails `SHOP_EMAIL`.

## Local development
- **Offline demo** (no accounts): `cd public && python -m http.server 5500` → http://localhost:5500/admin.html (PIN **1234**). On port 5500 everything is saved in this browser only.
- **With the real API:**
  1. Create `.dev.vars` in the repo root (git-ignored) with `DATABASE_URL="…a TEST Neon database…"` and `STAFF_LOGINS="owner@thetouch.ae:secret123"`.
  2. Run `npx wrangler pages dev --port 8788` → http://127.0.0.1:8788.
  3. Run `python tests/smoke_test.py --live`.

  Never point local tests at the shop's database.

## What's in the folder
| File | What it is |
|---|---|
| `public/index.html` | Customer website (shop, gifting, events, checkout) |
| `public/admin.html` | Admin panel + POS (open on the shop laptop/tablet) |
| `public/js/config.js` | Live (`/api`) on the real site, offline on port 5500 |
| `public/js/store.js` | Shared catalogue, settings, data layer |
| `public/img/` | Product photos and logos |
| `functions/api/[[path]].js` | The API: Neon database, security checks, photo upload, Resend emails |
| `functions/media/[[path]].js` | Serves uploaded photos from R2 (cached for a year) |
| `wrangler.toml` | Cloudflare project settings (R2 binding, email addresses) |

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
- [ ] Online card payments: today customers choose cash/card on delivery or pick-up, or a payment link sent on WhatsApp. Stripe checkout is added once the client's Stripe account is approved.
