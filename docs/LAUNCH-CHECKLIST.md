# The Touch — Go-Live Checklist (20 Nov 2026)

Order: **3A (domain → Cloudflare) → 2 (Neon) → 3B (R2) → 3C (deploy + secrets) → 3D (custom domain) → 4 (email) → 1 (content) → 5 (shop) → 6 (launch test) → 7 (go live)**.
Start with the domain: a nameserver change can take a few hours. Full details: `docs/SETUP.md`.

## 1. Fixes and content
All known bugs are fixed and tested. What's left is real content from the client.
- [ ] Real **price list** (pralines per kg, bars and gifts per piece)
- [ ] **VAT TRN** → Admin → Settings (receipts say "RECEIPT" until it's set, then "TAX INVOICE")
- [ ] Delivery fees per emirate, free-delivery minimum (now AED 300 in Abu Dhabi), same-day cut-off (now 2 PM)
- [ ] WhatsApp number for orders (now +971 52 663 3823), email, Instagram, boutique address
- [ ] Product list: missing items, names, Arabic spelling, which are "Signature"
- [ ] Starting **stock** (kg for pralines, pieces for the rest)
- [ ] Optional: real photos for the gift tray and the 500 g box
- [ ] Real staff logins in `STAFF_LOGINS` (email:password for the owner and each staff member)

## 2. Database — Neon (~10 min)
1. console.neon.tech → sign up (client's business email) → **New project** `the-touch`, AWS, region **Europe (Frankfurt)**.
2. **Connect** → Connection pooling ON → copy the `postgresql://…` string (keep it private).
3. Recommended: Billing → **Launch** (pay-as-you-go, no minimum). On the Free plan a POS tablet left on 24/7 can use up the monthly hours.
- [ ] Project created · [ ] Connection string saved · [ ] Plan chosen

## 3. Domain + hosting — Cloudflare
**A. Domain to Cloudflare (do first)**: dash.cloudflare.com → Add a domain → Free plan → copy the 2 nameservers → set them at the registrar (turn DNSSEC off there first) → wait for "Active".
**B. R2 for photos**: R2 Object Storage → activate (card on file, 10 GB free) → Create bucket `the-touch-photos`, location Automatic.
**C. Deploy**: on the dev laptop in this folder: `npx wrangler login` → `npx wrangler pages project create the-touch --production-branch main` → `npx wrangler pages deploy`. Then Workers & Pages → the-touch → Settings → Variables and secrets → add **Secrets** `DATABASE_URL`, `STAFF_LOGINS` (`owner@thetouch.ae:Password; …`), `RESEND_API_KEY` → deploy once more.
**D. Connect**: the-touch → Custom domains → add `thetouch.ae` and `www.thetouch.ae`.
- [ ] Nameservers changed · [ ] Domain Active · [ ] R2 bucket · [ ] Deployed (`the-touch.pages.dev`) · [ ] Secrets set · [ ] Custom domains + padlock

Updating later: `npx wrangler pages deploy` from this folder (drag-and-drop does not include the API). Prices/products/settings are changed in the admin — no re-deploy.

## 4. Email (~20 min, free)
Send (order emails): resend.com → Domains → Add `thetouch.ae` → add the shown records in Cloudflare DNS (DNS only) or use Resend's Cloudflare auto-setup → Verified → API Keys → Create (Sending access) → paste as `RESEND_API_KEY`. Add TXT `_dmarc` = `v=DMARC1; p=none;`.
Receive: Cloudflare → domain → Email → Email Routing → enable → verify the Gmail destination → create address `hello` → send to the Gmail.
Reply as hello@ from Gmail (optional): Gmail with 2-Step Verification → App password → Settings → Accounts → Send mail as → `hello@thetouch.ae`, SMTP `smtp.gmail.com`, port 587.
- [ ] Resend domain verified · [ ] API key set · [ ] hello@ forwarding works · [ ] Test order email arrives (shop + customer)

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
- [ ] Email to hello@ reaches Gmail · new web order emails the shop + the customer
- [ ] Void test orders, set real stock, open a fresh shift

If something fails: Workers & Pages → the-touch → Deployments → latest → **Functions → Real-time logs**, and check the three secrets are set (then deploy again). Admin says *Wrong email or password* → check `STAFF_LOGINS`.

## 7. Go live + first week
- [ ] Announce on Instagram, link in bio, WhatsApp Business profile
- [ ] Daily: work the Orders board, close shift + day-end report
- [ ] Weekly: Settings → Backup, Reports → Export CSV
- [ ] Watch low stock on Home
