# Backlog — fix one by one

Everything critical/high from QA is fixed and covered by `tests/smoke_test.py`. These are the remaining items,
roughly in priority order. Each is small and independent — good one-at-a-time tasks for Claude Code.

## Before / right after launch
1. **Content**: real prices, stock, TRN, product names/Arabic spelling, photos for `gift-tray` and `box-500`
   (they reuse other images in `public/js/store.js` SEED). Prefer editing in Admin → Products once live.
2. ~~**Shop header copy**~~ — DONE 20 Nov (per-category intro).
3. **Payment label for pick-up**: `TT.payLabel('cod')` says "Cash on delivery" even for pick-up orders
   (store.js `payLabel`, used in checkout + admin). Show "Pay at pick-up" when `fulfil==='pickup'`.
   *DONE 20 Nov: admin `payName()` + website checkout/confirmation/WhatsApp text say "Cash/Card at pick-up".*
4. ~~**Unknown category URL**~~ — DONE 20 Nov (redirects to `#/shop/all`).
5. ~~**POS split payment**~~ — DONE 20 Nov: shows the change to give and saves it as a cash sale.
6. **Order list scroll**: every route change scrolls to top, so Back doesn't restore the shop list position
   (index.html `route()`).
7. ~~**Newsletter form**~~ — DONE 20 Nov: saved to `subscribers` (create-only rule); Admin → Clients → Newsletter CSV.
8. ~~**Board on 820px tablets**~~ — DONE 20 Nov: 2×2 board from 761 to 1100 px.

## Open after 22 Nov 2026 (handover list)
- **Customer confirmation emails**: need a Resend account (API key as secret `RESEND_API_KEY` + its DNS records), or
  Cloudflare Email Sending onboarded for the domain in the dashboard. Boutique notifications already work.
- **Morning sales summary schedule**: Cloudflare needs the account's Workers page opened once (creates the workers.dev
  name); then `cd mail-worker && npx wrangler deploy` registers the 09:00 cron. On demand it already works
  (`POST /api/mailtest?summary=1` as staff).
- **Google**: add the site in Search Console (HTML-file or meta-tag verification) and submit `/sitemap.xml`; create the
  Google Business Profile (address, hours, phone, photos).
- **Shop facts in Admin → Settings**: full address, TRN. Opening hours and a Google Maps link can be stored as
  `settings.hours` / `settings.mapUrl` (read by `functions/[[path]].js` for Google) — no form fields yet.
- **Stock**: real counts for the 9 opening pieces (they went in with a placeholder of 10; the dragée jar is negative).
- **Photos** for the 18 chocolates added from the 22 Nov stock count (they show the monogram and are POS-only).
- **Staff logins**: new passwords chosen by the owner (secret `STAFF_LOGINS`, then redeploy).

## Later upgrades
- **Stripe checkout on the website** (waiting for the client's Stripe account) — add an `/api/checkout` route that
  creates a Stripe Checkout Session from server-side prices + a webhook that marks the order paid.
- ~~Automatic order emails~~ — DONE 20 Nov: Resend from the API (new order → shop + customer, enquiry → shop).
- Admin loads every order at start; after ~5,000 orders load only the last 12 months (`/api/db/orders?since=`).
- Arabic version of the website (RTL).
- Google Analytics / Meta Pixel.
- Sequential tax-invoice numbers (order numbers are unique, `S261119-ABCDE`, but not consecutive):
  a Postgres sequence in the API.
- Collapsible order summary on mobile checkout.

## How to work an item with Claude Code
1. Open the repo in VS Code, start Live Server (or `cd public && python -m http.server 5500`).
2. Ask Claude Code: "Fix backlog item 3" — it reads CLAUDE.md for context.
3. Run `python tests/smoke_test.py` and check both pages in the browser (phone width too).
4. Commit, then `npx wrangler pages deploy` when ready to publish.
