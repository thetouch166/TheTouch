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

## Later upgrades
- Online card payment at checkout (payment gateway: e.g. Network International, Stripe, Tap) — today customers
  choose cash/card on delivery or a payment link sent on WhatsApp.
- Automatic order emails (Firebase "Trigger Email" extension needs the paid Blaze plan, or a Cloudflare Worker).
- Arabic version of the website (RTL).
- Google Analytics / Meta Pixel.
- Sequential tax-invoice numbers (order numbers are unique, `S261119-ABCDE`, but not consecutive):
  Firestore counter doc + transaction.
- Collapsible order summary on mobile checkout.

## How to work an item with Claude Code
1. Open the repo in VS Code, start Live Server (or `cd public && python -m http.server 5500`).
2. Ask Claude Code: "Fix backlog item 3" — it reads CLAUDE.md for context.
3. Run `python tests/smoke_test.py` and check both pages in the browser (phone width too).
4. Commit, then re-upload `public/` to Cloudflare Pages when ready to publish.
