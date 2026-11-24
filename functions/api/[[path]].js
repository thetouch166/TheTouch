/* THE TOUCH — API on Cloudflare Pages Functions  →  https://<site>/api/*
   Database : Neon Postgres. One table of JSON documents, so orders / products / shifts keep exactly the
              same field names as before (see CLAUDE.md "Shapes"). Talks to Neon over HTTPS — no npm packages.
   Photos   : Cloudflare KV (binding PHOTOS_KV), or R2 (binding PHOTOS) when it is switched on — uploaded from
              Admin → Products, served at /media/…
   Email    : new web order / event enquiry → the boutique inbox through the mail worker (mail-worker/, service
              binding MAIL — Cloudflare Email, no outside account). Customer confirmation emails go through Resend
              when RESEND_API_KEY is set.

   Secrets (Cloudflare → Workers & Pages → the-touch → Settings → Variables and secrets):
     DATABASE_URL    Neon connection string (pooled)                                         required
     STAFF_LOGINS    the developer's owner login(s), always able to sign in:  email:Password1; email2:Password2   required
                     Everyone else is created in Admin → Settings → Security (stored hashed in the database).
     RESEND_API_KEY  Resend API key                              optional (no key = no emails to customers)
     STRIPE_SECRET_KEY      Stripe secret key (sk_live_… / sk_test_…)   optional (no key = no card payment online)
                            After setting it: redeploy, then POST /api/pay/setup as the owner (checks the account, creates the webhook).
     STRIPE_PUBLISHABLE_KEY Stripe publishable key (pk_live_… / pk_test_…, same mode as the secret key)   optional: with it the card
                            form opens inside our own order page; without it the customer pays on Stripe's page
     STRIPE_WEBHOOK_SECRET  optional: signing secret of the Stripe webhook (whsec_…). Without it every webhook message is
                            checked by reading the payment again from Stripe, so it is not needed for safety.
   Plain vars (wrangler.toml): MAIL_FROM, SHOP_EMAIL
*/

const COLS = ['products', 'settings', 'orders', 'enquiries', 'shifts', 'stock', 'subscribers', 'quotes', 'companies'];
const OWNER_COLS = ['subscribers', 'quotes', 'companies'];   // read and written by the owner only
const PUBLIC_READ = ['products', 'settings'];             // the website reads these (edge-cached)
const PUBLIC_CREATE = ['orders', 'enquiries', 'subscribers'];
const ID = /^[A-Za-z0-9_\-]{1,80}$/;
const NOW = () => Date.now();
const DAY = 864e5;

/* ---------- Neon over HTTPS (same protocol as @neondatabase/serverless) ---------- */
function neon(env) {
  const cs = env.DATABASE_URL;
  const host = new URL(cs.replace(/^postgres(ql)?:/, 'https:')).hostname;
  const endpoint = 'https://' + host.replace(/^[^.]+\./, 'api.') + '/sql';
  const post = async body => {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Neon-Connection-String': cs, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || 'Neon HTTP ' + r.status); e.code = j.code; throw e; }
    return j;
  };
  const withSchema = async fn => {
    try { return await fn(); }
    catch (e) { if (e.code !== '42P01') throw e; await post({ queries: SCHEMA.map(q => ({ query: q, params: [] })) }); return fn(); }
  };
  return {
    q: (query, params) => withSchema(() => post({ query, params: (params || []).map(v => v == null ? null : String(v)) })),
    tx: list => withSchema(() => post({ queries: list.map(([query, params]) => ({ query, params: (params || []).map(v => v == null ? null : String(v)) })) }))
  };
}
const SCHEMA = [
  `create table if not exists docs (col text not null, id text not null, data jsonb not null default '{}', updated bigint not null, deleted boolean not null default false, primary key (col, id))`,
  `create index if not exists docs_sync on docs (col, updated)`,
  `create table if not exists login_fail (ip text not null, at bigint not null)`,
  `create index if not exists login_fail_ip on login_fail (ip, at)`
];

/* ---------- helpers ---------- */
const HDR = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (o, status) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { status: status || 200, headers: HDR });
const err = (status, msg) => json({ error: msg }, status);
const te = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

function staffList(env) {
  return String(env.STAFF_LOGINS || '').split(/[;\n]/).map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf(':'); return i > 0 ? { email: s.slice(0, i).trim().toLowerCase(), pass: s.slice(i + 1).trim() } : null;
  }).filter(x => x && x.email && x.pass);
}
async function hmacKey(env) {
  const secret = env.SESSION_SECRET || ('tt|' + (env.STAFF_LOGINS || '') + '|' + (env.DATABASE_URL || ''));
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function makeToken(env, email) {
  const body = b64u(te.encode(JSON.stringify({ e: email, t: NOW(), x: NOW() + 30 * DAY })));
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), te.encode(body)));
}
/* → { email, role: 'owner' | 'cashier', name, id, source } or null. Removed / switched-off accounts and sessions from
   before a password change are refused (accounts are re-read from the database at most every 30 seconds). */
async function whoIs(req, env, db) {
  const m = /^Bearer\s+([\w-]+)\.([\w-]+)$/.exec(req.headers.get('Authorization') || ''); if (!m) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(m[2]), te.encode(m[1]))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(m[1])));
    if (!(p.x > NOW())) return null;
    if (staffList(env).some(s => s.email === p.e)) return { email: p.e, role: 'owner', name: '', source: 'config' };
    const u = (await staffDb(db)).find(s => s.email === p.e && s.active !== false);
    if (u && (p.t || 0) >= (u.pwAt || 0)) return { email: p.e, role: u.role === 'owner' ? 'owner' : 'cashier', name: u.name || '', id: u.id, source: 'admin' };
    return null;
  } catch (e) { return null; }
}

/* ---------- staff accounts (Admin → Settings → Security) ----------
   Kept in the database (docs, col 'staff' — not reachable through /api/db). Passwords are never stored: only a salted
   PBKDF2 hash that is also keyed with a secret kept outside the database, so a copy of the database alone cannot be
   used to guess them. Owner = everything. Cashier = sales, orders, shifts and stock counts only (cashierCan). */
const PW_ITER = 15000;
let staffMemo = { at: 0, list: null };
async function staffDb(db, fresh) {
  if (!fresh && staffMemo.list && NOW() - staffMemo.at < 30000) return staffMemo.list;
  const r = await db.q("select data::text from docs where col='staff' and not deleted");
  staffMemo = { at: NOW(), list: r.rows.map(([d]) => JSON.parse(d)) }; return staffMemo.list;
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function passHash(env, pass, salt, iter) {
  const k = await crypto.subtle.importKey('raw', te.encode(String(pass)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(String(salt)), iterations: iter || PW_ITER }, k, 256);
  const pepper = await crypto.subtle.importKey('raw', te.encode('ttpw|' + (env.PASSWORD_PEPPER || env.DATABASE_URL || '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', pepper, bits));
}
function weakPass(pass, email) {
  if (pass.length < 8) return 'Use at least 8 characters';
  if (pass.length > 200) return 'This password is too long';
  if (!/[A-Za-z]/.test(pass) || !/\d/.test(pass)) return 'Use letters and numbers';
  const low = pass.toLowerCase(), name = String(email || '').split('@')[0].toLowerCase();
  if ((name.length > 2 && low.includes(name)) || /^(password|passw0rd|qwerty|abc123|letmein|welcome|thetouch|chocolate|admin)[\d!@#$]*$/.test(low) || /^(\d)\1+$|^1234567/.test(low)) return 'Choose a password that is harder to guess';
  return '';
}
const OWNER_ONLY = 'Only the owner can do this';
const cashierCan = (op, col, body) =>
  op === 'put' ? ['orders', 'shifts', 'stock'].includes(col) :
  op === 'patch' ? (['orders', 'shifts', 'enquiries'].includes(col) || (col === 'products' && Object.keys(body || {}).every(k => k === 'stock' || k === 'min' || k === 'updated'))) :
  op === 'inc' ? (col === 'products' && body && body.field === 'stock') : false;
async function staffApi(ctx, db, who, id) {
  const { request: req, env } = ctx; const M = req.method;
  if (!who) return err(401, 'Sign in'); if (who.role !== 'owner') return err(403, OWNER_ONLY);
  const list = await staffDb(db, true);
  if (M === 'GET') return json({ rows: staffList(env).map(s => ({ email: s.email, role: 'owner', name: 'Developer login', fixed: true }))
    .concat(list.map(u => ({ id: u.id, email: u.email, name: u.name || '', role: u.role === 'owner' ? 'owner' : 'cashier', active: u.active !== false, lastLogin: u.lastLogin || 0, created: u.created || 0 }))) });
  if (M === 'POST') {   // create (no id) or change (id); a password is needed for a new person and optional afterwards
    const b = await readJSON(req, 2000); const email = String(b.email || '').trim().toLowerCase(); const pass = String(b.pass || '');
    if (!okEmail(email)) return err(400, 'Please enter a valid email');
    if (staffList(env).some(s => s.email === email)) return err(409, 'This email is already a developer login');
    const u = b.id ? list.find(x => x.id === b.id) : null; if (b.id && !u) return err(404, 'Not found');
    if (list.some(x => x.email === email && (!u || x.id !== u.id))) return err(409, 'This email already has an account');
    if (!u && !pass) return err(400, 'Please set a password');
    if (pass) { const bad = weakPass(pass, email); if (bad) return err(400, bad); }
    const role = b.role === 'owner' ? 'owner' : 'cashier';
    if (u && u.email === who.email && role !== 'owner') return err(400, 'You cannot remove your own owner access');
    const doc = Object.assign({}, u || { id: 'u_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20), created: NOW() }, { email, name: String(b.name || '').trim().slice(0, 60), role, active: true, updated: NOW() });
    if (pass) { doc.salt = crypto.randomUUID(); doc.iter = PW_ITER; doc.hash = await passHash(env, pass, doc.salt, doc.iter); doc.pwAt = NOW(); }
    await db.q(`insert into docs (col,id,data,updated,deleted) values ('staff',$1,$2::jsonb,$3,false)
      on conflict (col,id) do update set data=excluded.data, updated=excluded.updated, deleted=false`, [doc.id, JSON.stringify(doc), NOW()]);
    staffMemo.at = 0; return json({ ok: true, id: doc.id });
  }
  if (M === 'DELETE') {
    const u = list.find(x => x.id === id); if (!u) return err(404, 'Not found');
    if (u.email === who.email) return err(400, 'You cannot remove your own account');
    await db.q("update docs set deleted=true, data='{}'::jsonb, updated=$2 where col='staff' and id=$1", [u.id, NOW()]);
    staffMemo.at = 0; return json({ ok: true });
  }
  return err(405, 'Method not allowed');
}
async function changePassword(ctx, db, who) {
  const { request: req, env } = ctx;
  if (!who) return err(401, 'Sign in');
  if (who.source === 'config') return err(400, 'This is a developer login — it cannot be changed here');
  const b = await readJSON(req, 1000); const u = (await staffDb(db, true)).find(x => x.id === who.id); if (!u) return err(404, 'Not found');
  if (!await sameText(u.hash, await passHash(env, b.old || '', u.salt, u.iter))) return err(400, 'The current password is not right');
  const pass = String(b.pass || ''); const bad = weakPass(pass, u.email); if (bad) return err(400, bad);
  const salt = crypto.randomUUID(); const hash = await passHash(env, pass, salt, PW_ITER); const t = NOW();
  await db.q("update docs set data = data || $2::jsonb, updated=$3 where col='staff' and id=$1", [u.id, JSON.stringify({ salt, hash, iter: PW_ITER, pwAt: t }), t]);
  staffMemo.at = 0; return json({ ok: true, token: await makeToken(env, u.email) });   // other devices are signed out; this one stays in
}
async function sameText(a, b) {   // constant-time compare (via hashes)
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', te.encode(String(s)))));
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i]; return d === 0;
}
async function readJSON(req, max) {
  const t = await req.text(); if (t.length > max) throw Object.assign(new Error('too large'), { status: 413 });
  try { const o = JSON.parse(t); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (e) { }
  throw Object.assign(new Error('bad json'), { status: 400 });
}

/* public (website) creates — same checks the Firestore rules had */
function publicCreateOk(col, d) {
  if (col === 'orders') {
    const p = d.payment || {};
    return d.channel === 'web' && d.status === 'new' && d.stockApplied === false && p.paid === false &&
      Object.keys(p).every(k => k === 'method' || k === 'paid') &&   // nothing else: "payment link approved by staff" can only be set by staff
      (d.key == null || KEY.test(d.key)) &&
      ['cod', 'card_on_delivery', 'link', 'card_online'].includes(p.method) && Array.isArray(d.items) && d.items.length > 0 && d.items.length < 50 &&
      typeof d.total === 'number' && d.total > 0;
  }
  if (col === 'enquiries') return true;
  if (col === 'subscribers') return Object.keys(d).every(k => ['id', 'email', 'created', 'source'].includes(k)) && typeof d.email === 'string' && d.email.length < 121;
  return false;
}

/* edge cache for the website's product list + settings (purged when staff save) */
const cacheKey = (origin, col) => new Request(origin + '/api/db/' + col + '?edge=1');
async function purge(origin, col) { try { await caches.default.delete(cacheKey(origin, col)); } catch (e) { } }
const publicDoc = (col, d) => { if (col === 'settings') { delete d.pin; delete d.bank; } return d; };   // bank details: only on a company's own quotation / invoice page

/* "something new happened" signal for admin screens in a background tab: they ask GET /api/ping (no database, so the
   database can sleep) and only load the changes when this time moves. Written when a website order / enquiry arrives
   and when a card payment is received. */
async function touch(env) { try { if (env.PHOTOS_KV) await env.PHOTOS_KV.put('sys:ping', String(NOW())); } catch (e) { } }
async function pinged(env) {
  if (!env.PHOTOS_KV) return 0;
  try { return Number(await env.PHOTOS_KV.get('sys:ping', { cacheTtl: 30 })) || 0; }
  catch (e) { try { return Number(await env.PHOTOS_KV.get('sys:ping')) || 0; } catch (e2) { return 0; } }
}

/* ---------- the customer's own order page: /order/<no>?k=<key> ----------
   The key is a random string saved inside the order when it is placed (or made by POST /api/pay/link). Whoever holds
   the link can read this summary: no phone number, e-mail or street address in it. */
const KEY = /^[A-Za-z0-9]{16,40}$/;
const randKey = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; return [...crypto.getRandomValues(new Uint8Array(22))].map(b => A[b % A.length]).join(''); };
async function orderByNo(db, no, k) {
  if (!ID.test(no) || !KEY.test(k)) return null;
  const r = await db.q("select data::text from docs where col='orders' and not deleted and data->>'no'=$1 limit 5", [no]);
  for (const [d] of r.rows) { const o = JSON.parse(d); if (typeof o.key === 'string' && KEY.test(o.key) && await sameText(o.key, k)) return o; }
  return null;
}
/* staff sent a payment link for exactly this total (POST /api/pay/link) */
const linkOk = o => { const p = (o && o.payment) || {}; return Number(p.linkTotal) > 0 && Math.abs(Number(p.linkTotal) - Number(o.total)) < 0.005 && NOW() - Number(p.linkAt) < 30 * DAY; };
const payable = (env, o) => { const p = o.payment || {}; return !!env.STRIPE_SECRET_KEY && o.status !== 'cancelled' && p.paid !== true && (linkOk(o) || (o.channel === 'web' && p.method === 'card_online' && NOW() - Number(o.created) < 2 * DAY)); };
async function orderView(env, db, no, url) {
  const o = await orderByNo(db, String(no || ''), String(url.searchParams.get('k') || ''));
  if (!o) return err(404, 'Order not found');
  const p = o.payment || {}, n = v => Number(v) || 0;
  const b2b = o.channel === 'b2b' ? (await getDoc(db, 'settings', 'main')) || {} : null;   // a company invoice also shows the bank details
  return json({
    bank: b2b && b2b.bank && typeof b2b.bank === 'object' ? b2b.bank : null, terms: String(o.terms || '').slice(0, 3000),
    no: o.no, created: n(o.created), status: o.status, channel: o.channel, fulfil: o.fulfil, emirate: o.emirate || '', area: o.area || '', date: o.date || '', slot: o.slot || '',
    customer: { name: String((o.customer || {}).name || '') },
    company: o.company && o.company.name ? { name: String(o.company.name).slice(0, 200), trn: String(o.company.trn || '').slice(0, 40), address: String(o.company.address || '').slice(0, 400), contact: String(o.company.contact || '').slice(0, 120) } : null,
    po: String(o.po || '').slice(0, 60), quoteNo: String(o.quoteNo || '').slice(0, 40), paidRef: p.paid === true ? String(p.ref || '').slice(0, 80) : '',
    items: (Array.isArray(o.items) ? o.items : []).slice(0, 100).map(l => ({ name: String(l.name || ''), desc: String(l.desc || '').slice(0, 300), unit: l.unit === 'kg' ? 'kg' : 'pc', price: n(l.price), orig: n(l.orig), grams: n(l.grams), qty: n(l.qty), disc: n(l.disc),
      box: Array.isArray(l.box) && l.box.length ? l.box.slice(0, 12).map(b => ({ name: String((b && b.name) || '').slice(0, 80) })) : undefined })),
    subtotal: n(o.subtotal), discount: n(o.discount), delivery: n(o.delivery), total: n(o.total), vat: n(o.vat),
    payment: { method: p.method, paid: p.paid === true, paidAt: n(p.paidAt) }, canPay: payable(env, o)
  });
}

/* ---------- quotations for companies: /quote/<no>?k=<key> ----------
   The owner writes a quotation in the admin (col quotes, owner only) and sends the company its private link. The company
   reads it there and approves or declines it (the only two things the link can change, and only once). The boutique then
   turns an approved quotation into an invoice: an order with channel 'b2b' that is paid like any payment link. */
async function quoteByNo(db, no, k) {
  if (!ID.test(no) || !KEY.test(k)) return null;
  const r = await db.q("select data::text from docs where col='quotes' and not deleted and data->>'no'=$1 limit 5", [no]);
  for (const [d] of r.rows) { const q = JSON.parse(d); if (typeof q.key === 'string' && KEY.test(q.key) && await sameText(q.key, k)) return q; }
  return null;
}
const dxbDay = () => new Date(NOW() + 4 * 36e5).toISOString().slice(0, 10);   // today's date in Abu Dhabi
const quoteState = q => q.status === 'sent' && /^\d{4}-\d\d-\d\d$/.test(q.validUntil || '') && q.validUntil < dxbDay() ? 'expired' : (['sent', 'approved', 'declined', 'invoiced'].includes(q.status) ? q.status : 'draft');
async function quoteApi(ctx, db, no, op, url) {
  const { request: req, env } = ctx; const M = req.method;
  const q = await quoteByNo(db, String(no || ''), String(url.searchParams.get('k') || ''));
  if (!q || quoteState(q) === 'draft') return err(404, 'Quotation not found');
  const n = v => Number(v) || 0, t = (v, max) => String(v == null ? '' : v).slice(0, max || 300);
  if (M === 'GET' && !op) {
    const c = q.company || {}, a = q.approval || {}; let invoice = null;
    if (q.orderId && ID.test(String(q.orderId))) { const o = await getDoc(db, 'orders', String(q.orderId)); if (o && o.status !== 'cancelled' && KEY.test(o.key || '')) invoice = { no: o.no, k: o.key, paid: !!(o.payment && o.payment.paid) }; }
    const st = (await getDoc(db, 'settings', 'main')) || {};
    return json({
      bank: st.bank && typeof st.bank === 'object' ? st.bank : null,
      no: q.no, created: n(q.created), status: quoteState(q), validUntil: t(q.validUntil, 10), subject: t(q.subject, 200),
      company: { name: t(c.name, 200), trn: t(c.trn, 40), address: t(c.address, 400), contact: t(c.contact, 120) },
      items: (Array.isArray(q.items) ? q.items : []).slice(0, 100).map(l => ({ name: t(l.name), desc: t(l.desc), unit: l.unit === 'kg' ? 'kg' : 'pc', price: n(l.price), orig: n(l.orig), grams: n(l.grams), qty: n(l.qty), disc: n(l.disc) })),
      subtotal: n(q.subtotal), discount: n(q.discount), delivery: n(q.delivery), total: n(q.total), vat: n(q.vat),
      fulfil: q.fulfil === 'pickup' ? 'pickup' : 'delivery', date: t(q.date, 10), notes: t(q.notes, 2000), terms: t(q.terms, 3000),
      approval: a.at ? { at: n(a.at), name: t(a.name, 120), po: t(a.po, 60) } : null, invoice
    });
  }
  if (M === 'POST' && (op === 'approve' || op === 'decline')) {
    const b = await readJSON(req, 3000); const state = quoteState(q);
    if (state === 'expired') return err(409, 'This quotation has expired. Please ask us for a new one.');
    if (state !== 'sent') return err(409, state === 'declined' ? 'This quotation was declined' : 'This quotation is already approved');
    const name = t(b.name, 120).trim(); if (op === 'approve' && name.length < 2) return err(400, 'Please enter your name');
    const part = op === 'approve'
      ? { status: 'approved', approval: { at: NOW(), name, po: t(b.po, 60).trim(), note: t(b.note, 600).trim(), ip: t(req.headers.get('CF-Connecting-IP'), 60) } }
      : { status: 'declined', declined: { at: NOW(), name, reason: t(b.reason, 600).trim() } };
    const r = await db.q("update docs set data = data || $2::jsonb, updated=$3 where col='quotes' and id=$1 and not deleted and data->>'status'='sent'", [String(q.id), JSON.stringify(part), NOW()]);
    if (!r.rowCount) return err(409, 'This quotation was already answered');
    ctx.waitUntil(touch(env));
    const c = q.company || {}, ok = op === 'approve';
    ctx.waitUntil(sendShop(env, {
      to: [env.SHOP_EMAIL], subject: `Quotation ${q.no} ${ok ? 'approved' : 'declined'} · ${c.name || ''} · ${AED(q.total)}`,
      html: frame(`<div style="font-family:Georgia,serif;font-size:22px;margin-bottom:8px">Quotation ${ok ? 'approved' : 'declined'}</div>
<p style="font-size:14px;line-height:1.7;margin:0 0 6px;color:#5a4a3f"><b>${H(c.name || 'The company')}</b> ${ok ? 'approved' : 'declined'} quotation <b>${H(q.no)}</b> (${AED(q.total)}).</p>
<p style="font-size:14px;line-height:1.7;margin:0;color:#5a4a3f">${ok ? 'Approved by ' + H(name) + (part.approval.po ? ' · PO ' + H(part.approval.po) : '') + (part.approval.note ? '<br>“' + H(part.approval.note) + '”' : '') : (name ? 'By ' + H(name) + '. ' : '') + (part.declined.reason ? 'Reason: “' + H(part.declined.reason) + '”' : '')}</p>
<p style="margin:26px 0 0;text-align:center"><a href="${H(url.origin)}/admin.html" style="display:inline-block;background:#1a1412;color:#d9b77e;text-decoration:none;padding:13px 26px;font-size:13px;letter-spacing:2px">${ok ? 'CREATE THE INVOICE' : 'OPEN THE ADMIN'}</a></p>`, {})
    }).catch(() => { }));
    return json({ ok: true, status: part.status });
  }
  return err(404, 'Not found');
}

/* ---------- router ---------- */
export async function onRequest(ctx) {
  const { request: req, env } = ctx;
  const url = new URL(req.url);
  const seg = (Array.isArray(ctx.params.path) ? ctx.params.path : [ctx.params.path]).filter(Boolean);
  const [a, col, id, op] = seg; const M = req.method;
  try {
    if (a === 'ping' && M === 'GET') return json({ t: await pinged(env) });
    if (!env.DATABASE_URL) return err(503, 'DATABASE_URL is not set');
    const db = neon(env);
    const who = await whoIs(req, env, db); const staff = who ? who.email : null; const owner = !!who && who.role === 'owner';

    if (a === 'login' && M === 'POST') {
      const ip = req.headers.get('CF-Connecting-IP') || 'local';
      const b = await readJSON(req, 2000); const email = String(b.email || '').trim().toLowerCase().slice(0, 200); const ekey = 'e:' + email;
      const [n, ne] = (await db.q('select count(*) filter (where ip=$1), count(*) filter (where ip=$3) from login_fail where at>$2 and ip in ($1,$3)', [ip, NOW() - 15 * 6e4, ekey])).rows[0];
      if (+n >= 10 || +ne >= 20) return err(429, 'Too many attempts — try again in 15 minutes');
      const user = staffList(env).find(s => s.email === email);
      if (user && await sameText(user.pass, b.pass || '')) return json({ token: await makeToken(env, email), email, role: 'owner' });
      const acc = user ? null : (await staffDb(db, true)).find(s => s.email === email && s.active !== false && s.hash);
      if (acc && await sameText(acc.hash, await passHash(env, b.pass || '', acc.salt, acc.iter))) {
        ctx.waitUntil(db.q("update docs set data = jsonb_set(data, '{lastLogin}', to_jsonb($2::bigint)) where col='staff' and id=$1", [acc.id, NOW()]).catch(() => { }));
        return json({ token: await makeToken(env, email), email, role: acc.role === 'owner' ? 'owner' : 'cashier' });
      }
      await db.tx([['insert into login_fail (ip, at) values ($1,$2)', [ip, NOW()]], ['insert into login_fail (ip, at) values ($1,$2)', [ekey, NOW()]], ['delete from login_fail where at<$1', [NOW() - DAY]]]);
      return err(401, 'Wrong email or password');
    }
    if (a === 'me') return who ? json({ email: who.email, role: who.role, name: who.name, source: who.source, pay: !!env.STRIPE_SECRET_KEY, mail: !!env.RESEND_API_KEY }) : err(401, 'Sign in');
    if (a === 'staff') return await staffApi(ctx, db, who, col);
    if (a === 'password' && M === 'POST') return await changePassword(ctx, db, who);

    if (a === 'mailtest' && M === 'POST') {   // admin: check that the boutique inbox receives mail (?summary=1 → yesterday's sales summary)
      if (!staff) return err(401, 'Sign in'); if (!owner) return err(403, OWNER_ONLY);
      if (url.searchParams.get('summary')) {
        if (!env.MAIL) return json({ ok: false, error: 'The mail worker is not connected' });
        const r = await env.MAIL.fetch('https://mail/summary', { method: 'POST' }); return json(await r.text());
      }
      const to = String(url.searchParams.get('to') || '').trim();
      if (to) {   // ?to=someone@… → a sample of the customer's confirmation email, through Resend
        if (!okEmail(to)) return err(400, 'Bad email address');
        if (!env.RESEND_API_KEY) return json({ ok: false, error: 'RESEND_API_KEY is not set' });
        const s = (await getDoc(db, 'settings', 'main')) || {};
        const r0 = await db.q("select data::text from docs where col='orders' and not deleted and data->>'channel'='web' order by updated desc limit 1");
        const d = r0.rows.length ? JSON.parse(r0.rows[0][0]) : { no: 'W000000-SAMPLE', items: [{ name: 'Assorted Signature Box', unit: 'pc', price: 315, qty: 1 }], subtotal: 315, delivery: 0, total: 315, vat: 15, fulfil: 'pickup', date: '', payment: { method: 'cod', paid: false }, customer: { name: 'Sample Client' } };
        return json(await send(env, { to: [to], subject: `Your order ${d.no} — The Touch (sample)`, reply_to: okEmail(s.email) ? s.email : undefined, html: customerMail(d, s, siteOf(env, url)) }));
      }
      return json(await sendShop(env, { to: [env.SHOP_EMAIL], subject: 'Test email from The Touch admin', html: frame(`<div style="font-family:Georgia,serif;font-size:22px;margin-bottom:10px">It works</div><p style="font-size:14px;line-height:1.7;margin:0;color:#5a4a3f">This inbox receives an email for every new website order and event enquiry. Sent by ${H(staff)}.</p>`, {}) }));
    }

    if (a === 'sync' && M === 'GET') {   // admin: everything that changed since a moment
      if (!staff) return err(401, 'Sign in');
      const cols = String(url.searchParams.get('cols') || '').split(',').filter(c => COLS.includes(c) && (owner || !OWNER_COLS.includes(c)));
      const since = Math.max(0, +url.searchParams.get('since') || 0); const t = NOW();
      if (!cols.length) return json({ t, rows: [] });
      const r = await db.q('select col, id, deleted, data::text from docs where col = any($1::text[]) and updated > $2', ['{' + cols.join(',') + '}', since]);
      return json('{"t":' + t + ',"rows":[' + r.rows.map(([c, i, del, d]) => '{"c":' + JSON.stringify(c) + ',"id":' + JSON.stringify(i) + ',"d":' + (del === 't' ? 'null' : d) + '}').join(',') + ']}');
    }

    if (a === 'upload' && M === 'POST') {   // admin: product photo → R2
      if (!staff) return err(401, 'Sign in'); if (!owner) return err(403, OWNER_ONLY);
      if (!env.PHOTOS && !env.PHOTOS_KV) return err(503, 'Photo storage is not connected');
      const type = (req.headers.get('Content-Type') || '').split(';')[0];
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type]; if (!ext) return err(415, 'JPEG, PNG or WebP only');
      const buf = await req.arrayBuffer(); if (!buf.byteLength || buf.byteLength > 5e6) return err(413, 'Photo must be under 5 MB');
      const key = 'p/' + NOW().toString(36) + '-' + crypto.randomUUID().slice(0, 8) + '.' + ext;
      if (env.PHOTOS) await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
      else await env.PHOTOS_KV.put(key, buf, { metadata: { type } });
      return json({ url: '/media/' + key });
    }

    if (a === 'pay') return await pay(ctx, db, col, url, who);
    if (a === 'order' && M === 'GET') return await orderView(env, db, col, url);
    if (a === 'quote') return await quoteApi(ctx, db, col, id, url);

    if (a !== 'db' || !COLS.includes(col) || (id && !ID.test(id))) return err(404, 'Not found');

    /* read */
    if (M === 'GET' && !id) {
      if (!staff && !PUBLIC_READ.includes(col)) return err(401, 'Sign in');
      if (staff && !owner && OWNER_COLS.includes(col)) return err(403, OWNER_ONLY);
      const t = NOW(); const edge = !staff;
      if (edge) { try { const hit = await caches.default.match(cacheKey(url.origin, col)); if (hit) return json(await hit.text()); } catch (e) { } }
      const r = await db.q('select data::text from docs where col=$1 and not deleted', [col]);
      const rows = edge ? r.rows.map(([d]) => JSON.stringify(publicDoc(col, JSON.parse(d)))) : r.rows.map(([d]) => d);
      const body = '{"t":' + t + ',"rows":[' + rows.join(',') + ']}';
      if (edge) ctx.waitUntil(caches.default.put(cacheKey(url.origin, col), new Response(body, { headers: { 'Cache-Control': 'public, max-age=60' } })).catch(() => { }));
      return json(body);
    }
    if (M === 'GET') {
      if (!staff && !PUBLIC_READ.includes(col)) return err(401, 'Sign in');
      if (staff && !owner && OWNER_COLS.includes(col)) return err(403, OWNER_ONLY);
      const r = await db.q('select data::text from docs where col=$1 and id=$2 and not deleted', [col, id]);
      if (!r.rows.length) return err(404, 'Not found');
      return json(staff ? r.rows[0][0] : JSON.stringify(publicDoc(col, JSON.parse(r.rows[0][0]))));
    }
    if (!id) return err(405, 'Method not allowed');

    /* write */
    if (M === 'PUT') {
      const d = await readJSON(req, staff ? 1.5e6 : 3.2e4); d.id = id;
      if (staff && !owner && !cashierCan('put', col, d) && !(PUBLIC_CREATE.includes(col) && publicCreateOk(col, d))) return err(403, OWNER_ONLY);
      if (staff) {
        const r = await db.q(`insert into docs (col,id,data,updated,deleted) values ($1,$2,$3::jsonb,$4,false)
          on conflict (col,id) do update set data=excluded.data, updated=excluded.updated, deleted=false returning (xmax = 0)`, [col, id, JSON.stringify(d), NOW()]);
        if (PUBLIC_READ.includes(col)) await purge(url.origin, col);
        // a website order / enquiry placed from a browser that is also signed in to the admin (the owner trying the site, or
        // ordering for a client): it is new and just made, so the boutique and the customer are told exactly as usual
        const isNew = r.rows && r.rows[0] && String(r.rows[0][0]).charAt(0) === 't';
        if (isNew && (col === 'orders' || col === 'enquiries') && publicCreateOk(col, d) && NOW() - Number(d.created) < 10 * 6e4) { ctx.waitUntil(touch(env)); ctx.waitUntil(notify(env, db, col, d, url).catch(e => console.error('email', e))); }
        return json({ ok: true });
      }
      if (!PUBLIC_CREATE.includes(col) || !publicCreateOk(col, d)) return err(403, 'Not allowed');
      const r = await db.q('insert into docs (col,id,data,updated) values ($1,$2,$3::jsonb,$4) on conflict (col,id) do nothing', [col, id, JSON.stringify(d), NOW()]);
      if (!r.rowCount) return err(409, 'Already exists');
      if (col === 'orders' || col === 'enquiries') { ctx.waitUntil(touch(env)); ctx.waitUntil(notify(env, db, col, d, url).catch(e => console.error('email', e))); }
      return json({ ok: true });
    }
    if (!staff) return err(401, 'Sign in');
    if (M === 'PATCH') {   // shallow merge (same as the offline mode); creates the doc if missing
      const part = await readJSON(req, 1.5e6); delete part.id;
      if (!owner && !cashierCan('patch', col, part)) return err(403, OWNER_ONLY);
      await db.q(`insert into docs (col,id,data,updated,deleted) values ($1,$2,$3::jsonb,$4,false)
        on conflict (col,id) do update set data = case when docs.deleted then excluded.data else docs.data || excluded.data end, updated=excluded.updated, deleted=false`,
        [col, id, JSON.stringify(Object.assign({ id }, part)), NOW()]);
      if (PUBLIC_READ.includes(col)) await purge(url.origin, col);
      return json({ ok: true });
    }
    if (M === 'POST' && op === 'inc') {   // atomic +/− (stock)
      const b = await readJSON(req, 500); const f = String(b.field || ''); const delta = Number(b.delta);
      if (!owner && !cashierCan('inc', col, b)) return err(403, OWNER_ONLY);
      if (!/^[A-Za-z0-9_]{1,40}$/.test(f) || !isFinite(delta)) return err(400, 'Bad increment');
      await db.q(`update docs set data = jsonb_set(data, array[$3::text], to_jsonb(round(coalesce(nullif(data->>$3::text,'')::numeric,0) + $4::numeric, 2))), updated=$5
        where col=$1 and id=$2 and not deleted`, [col, id, f, delta, NOW()]);
      if (PUBLIC_READ.includes(col)) await purge(url.origin, col);
      return json({ ok: true });
    }
    if (M === 'DELETE') {   // soft delete so other screens see it disappear; the content itself is wiped
      if (!owner) return err(403, OWNER_ONLY);
      await db.q(`update docs set deleted=true, data='{}'::jsonb, updated=$3 where col=$1 and id=$2`, [col, id, NOW()]);
      if (PUBLIC_READ.includes(col)) await purge(url.origin, col);
      return json({ ok: true });
    }
    return err(405, 'Method not allowed');
  } catch (e) {
    if (e.status) return err(e.status, e.message);
    console.error('api', M, url.pathname, e && e.message, e && e.code);
    return err(e && e.code === '53000' ? 503 : 500, e && e.code === '53000' ? 'Database paused (Neon plan limit)' : 'Server error');
  }
}

/* ---------- card payments (Stripe Checkout) ----------
   The website saves the order first (unpaid), then asks POST /api/pay/checkout for a Stripe payment page.
   The amount is rebuilt here from our own prices — what the browser sent is never charged.
   The order is marked paid by Stripe's webhook (POST /api/pay/webhook) and, as a second path, when the customer
   lands back on the confirmation page (GET /api/pay/confirm?sid=…). Both go through settle(), which acts once.
   Money received online is stored in payment.other (the "Link / online" line of the reports), never as till cash.
   Refunds are made in the Stripe dashboard. */
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const fils = n => Math.round((Number(n) || 0) * 100);
async function stripeRaw(env, method, path, params) {   // never throws on a Stripe error: { ok, status, j, msg }
  const init = { method, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } };
  if (params) { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(params).toString(); }
  const r = await fetch((env.STRIPE_API || 'https://api.stripe.com') + '/v1' + path, init);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j, msg: String((j && j.error && j.error.message) || '').slice(0, 300) };
}
async function stripe(env, method, path, params) {
  const r = await stripeRaw(env, method, path, params);
  if (!r.ok) { console.error('stripe', method, path, r.status, r.msg); throw Object.assign(new Error('The payment service did not answer — please try again'), { status: 502 }); }
  return r.j;
}
async function getDoc(db, col, id) { const r = await db.q('select data::text from docs where col=$1 and id=$2 and not deleted', [col, id]); return r.rows.length ? JSON.parse(r.rows[0][0]) : null; }
/* "Make your own" box: the same settings and sum as store.js (myoCfg / myoPrice), so the amount charged never comes from the browser */
function myoCfg(s) {
  const m = (s && s.myo) || {}, n = (v, d) => { v = Number(v); return isFinite(v) ? v : d; };
  const c = { on: m.on === true, name: String(m.name || 'Signature box').slice(0, 60) };
  c.lines = Math.min(12, Math.max(1, Math.round(n(m.lines, 9)))); c.grams = Math.min(10000, Math.max(100, n(m.grams, 1100)));
  c.mode = ['weight', 'kg', 'fixed'].includes(m.mode) ? m.mode : 'weight'; c.kgPrice = Math.max(0, n(m.kgPrice, 0)); c.price = Math.max(0, n(m.price, 0)); c.fee = Math.max(0, n(m.fee, 0));
  c.round = [0, 1, 5, 10].includes(n(m.round, 0)) ? n(m.round, 0) : 0; c.items = Array.isArray(m.items) ? m.items.map(String) : [];
  return c;
}
function myoPrice(c, prices) {
  const v = c.mode === 'fixed' ? c.price : c.mode === 'kg' ? c.kgPrice * c.grams / 1000 + c.fee : prices.reduce((a, p) => a + (Number(p) || 0) * (c.grams / c.lines) / 1000, 0) + c.fee;
  return c.mode !== 'fixed' && c.round > 0 ? Math.ceil(v / c.round - 1e-9) * c.round : r2(v);
}
const boxText = l => l && Array.isArray(l.box) && l.box.length ? l.box.map((b, i) => (i + 1) + ' ' + String((b && b.name) || '').slice(0, 80)).join(' · ') : '';
/* the order's lines and total from the catalogue's own prices (same sums as the website: store.js lineTotal / deliveryFee) */
async function priceOrder(db, o) {
  const [pr, st] = await Promise.all([db.q("select data::text from docs where col='products' and not deleted"), db.q("select data::text from docs where col='settings' and id='main'")]);
  const prods = {}; pr.rows.forEach(([d]) => { const p = JSON.parse(d); prods[p.id] = p; }); const s = st.rows.length ? JSON.parse(st.rows[0][0]) : {};
  const lines = [];
  for (const l of (Array.isArray(o.items) ? o.items : [])) {
    if (l && l.pid === 'myo') {   // a box the customer filled: every line must be a chocolate the boutique offers for it, the price is worked out here
      const c = myoCfg(s), box = Array.isArray(l.box) ? l.box : [], n = Math.round(Number(l.qty)); if (!c.on || box.length !== c.lines || !(n >= 1 && n <= 50)) return null;
      const ps = box.map(b => prods[b && b.pid]); if (ps.some(p => !p || p.active === false || p.unit !== 'kg' || (c.items.length && !c.items.includes(p.id)))) return null;
      const amount = r2(myoPrice(c, ps.map(p => p.price)) * n); if (!(amount > 0)) return null;
      lines.push({ name: (c.name + ' (make your own)').slice(0, 120) + (n > 1 ? ' × ' + n : ''), amount }); continue;
    }
    const p = prods[l && l.pid]; const qty = Math.round(Number(l && l.qty)); const grams = Math.round(Number(l && l.grams) || 0);
    if (!p || p.active === false || p.web === false || !(qty >= 1 && qty <= 200)) return null;
    const kg = p.unit === 'kg'; if (kg && !(grams >= 50 && grams <= 20000)) return null;
    const amount = r2((kg ? p.price * grams / 1000 : p.price) * qty); if (!(amount > 0)) return null;
    lines.push({ name: String(p.name).slice(0, 120) + (kg ? ' · ' + (grams >= 1000 ? grams / 1000 + ' kg' : grams + ' g') : '') + (qty > 1 ? ' × ' + qty : ''), amount });
  }
  if (!lines.length) return null;
  const subtotal = r2(lines.reduce((a, l) => a + l.amount, 0)); const free = Number(s.freeDeliveryOver) > 0 ? Number(s.freeDeliveryOver) : Infinity;
  const delivery = o.fulfil === 'delivery' ? ((subtotal >= free && o.emirate === 'Abu Dhabi') ? 0 : Number((s.delivery || {})[o.emirate] || 0)) : 0;
  return { lines, subtotal, delivery, total: r2(subtotal + delivery) };
}
/* mark the order paid — called by the webhook and by the confirmation page; the database update happens only once */
async function settle(ctx, db, session, url) {
  const origin = url.origin;
  const id = String((session && (session.client_reference_id || (session.metadata || {}).order_id)) || '');
  if (!session || session.payment_status !== 'paid' || !ID.test(id)) return { paid: false };
  const o = await getDoc(db, 'orders', id); if (!o) return { paid: false };
  if (o.payment && o.payment.paid) return { paid: true, no: o.no };
  if (String(session.currency).toLowerCase() !== 'aed' || Number(session.amount_total) !== fils(o.total)) { console.error('stripe amount mismatch', id, session.amount_total, o.total); return { paid: false, no: o.no }; }
  const pay = Object.assign({}, o.payment, { method: 'card_online', paid: true, paidAt: NOW(), cash: 0, card: 0, other: r2(o.total), ref: String(session.payment_intent || session.id).slice(0, 80), session: String(session.id).slice(0, 120) });
  const r = await db.q(`update docs set data = jsonb_set(data, '{payment}', $2::jsonb), updated=$3
    where col='orders' and id=$1 and not deleted and coalesce(data->'payment'->>'paid','false') <> 'true'`, [id, JSON.stringify(pay), NOW()]);
  if (r.rowCount) {
    const c = o.customer || {};
    ctx.waitUntil(touch(ctx.env));
    if (okEmail(c.email) && ctx.env.RESEND_API_KEY) ctx.waitUntil((async () => {   // the customer's receipt
      const s = (await getDoc(db, 'settings', 'main')) || {}; const paid = Object.assign({}, o, { payment: pay });
      await send(ctx.env, { to: [c.email.trim()], subject: `Payment received — order ${o.no} — The Touch`, reply_to: okEmail(s.email) ? s.email : undefined,
        html: frame(`<div style="font-family:Georgia,serif;font-size:24px;margin-bottom:8px">Payment received${c.name ? ', ' + H(String(c.name).split(' ')[0]) : ''}</div>
<p style="font-size:14px;line-height:1.7;margin:0 0 20px;color:#5a4a3f">Thank you. We have received your card payment of <b>${AED(o.total)}</b> for order <b>${H(o.no)}</b>.</p>${orderTable(paid)}${orderFacts(paid)}${KEY.test(o.key || '') ? mailBtn(siteOf(ctx.env, url) + '/order/' + o.no + '?k=' + o.key, 'VIEW YOUR INVOICE') : ''}`, s) });
    })().catch(() => { }));
    ctx.waitUntil(sendShop(ctx.env, { to: [ctx.env.SHOP_EMAIL], reply_to: okEmail(c.email) ? c.email.trim() : undefined, subject: `Payment received · ${o.no} · ${AED(o.total)}`,
      html: frame(`<div style="font-family:Georgia,serif;font-size:22px;margin-bottom:8px">Payment received</div><p style="font-size:14px;line-height:1.7;margin:0 0 6px;color:#5a4a3f">Order <b>${H(o.no)}</b> was paid online by card: <b>${AED(o.total)}</b>.</p><p style="font-size:14px;line-height:1.7;margin:0;color:#5a4a3f">${H(c.name || '')} · ${H(c.phone || '')}</p><p style="margin:26px 0 0;text-align:center"><a href="${H(origin)}/admin.html" style="display:inline-block;background:#1a1412;color:#d9b77e;text-decoration:none;padding:13px 26px;font-size:13px;letter-spacing:2px">OPEN THE ORDER</a></p>`, {}) }).catch(() => { }));
  }
  return { paid: true, no: o.no };
}
async function stripeSigOk(secret, header, body) {
  const t = (/(?:^|,)\s*t=(\d+)/.exec(header || '') || [])[1]; const sigs = [...String(header || '').matchAll(/(?:^|,)\s*v1=([0-9a-f]+)/g)].map(m => m[1]);
  if (!t || !sigs.length || Math.abs(NOW() / 1000 - Number(t)) > 600) return false;
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(t + '.' + body)))].map(b => b.toString(16).padStart(2, '0')).join('');
  for (const s of sigs) if (await sameText(s, mac)) return true;
  return false;
}
/* the publishable key for the on-site card form: only when it belongs to the same mode (test / live) as the secret key */
const pubKey = env => { const pk = String(env.STRIPE_PUBLISHABLE_KEY || '').trim(), sk = String(env.STRIPE_SECRET_KEY || ''); return /^pk_(live|test)_[A-Za-z0-9]{10,}$/.test(pk) && /^pk_live_/.test(pk) === /^(sk|rk)_live_/.test(sk) ? pk : ''; };
const siteOf = (env, url) => /^(localhost|127\.)/.test(url.hostname) ? url.origin : String(env.SITE_URL || url.origin).replace(/\/+$/, '');
async function pay(ctx, db, op, url, who) {
  const { request: req, env } = ctx; const M = req.method;
  /* Stripe's webhook. With STRIPE_WEBHOOK_SECRET set, the signature is checked. Without it the message is only a hint:
     the payment is read again from Stripe with our own key, so a made-up message can never mark an order paid. */
  if (op === 'webhook' && M === 'POST') {
    if (!env.STRIPE_WEBHOOK_SECRET && !env.STRIPE_SECRET_KEY) return err(503, 'Card payment is not connected');
    const body = await req.text(); if (body.length > 300000) return err(413, 'Too large');
    if (env.STRIPE_WEBHOOK_SECRET && !await stripeSigOk(env.STRIPE_WEBHOOK_SECRET, req.headers.get('Stripe-Signature'), body)) return err(400, 'Bad signature');
    let ev; try { ev = JSON.parse(body); } catch (e) { return err(400, 'Bad json'); }
    if (ev && (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded')) {
      let s = ev.data && ev.data.object;
      if (!env.STRIPE_WEBHOOK_SECRET) {
        const sid = String((s && s.id) || ''); if (!/^cs_[A-Za-z0-9_]{6,200}$/.test(sid)) return err(400, 'Bad session');
        const r = await stripeRaw(env, 'GET', '/checkout/sessions/' + sid);
        if (r.status === 404) return err(400, 'Unknown session');   // not one of ours: nothing to retry
        if (!r.ok) return err(502, 'The payment service did not answer');   // Stripe sends the message again later
        s = r.j;
      }
      await settle(ctx, db, s, url);
    }
    return json({ received: true });
  }
  if (!env.STRIPE_SECRET_KEY) return err(503, op === 'link' ? 'Card payment is not connected yet (Stripe). Once it is, this button sends the client a payment link.' : 'Card payment is not available yet');
  /* owner, once after the key is set: checks the Stripe account, opens (and closes) a payment page in AED the way the website
     does, and makes sure Stripe's webhook points at this site. Returns no secret. */
  if (op === 'setup' && M === 'POST') {
    if (!who) return err(401, 'Sign in'); if (who.role !== 'owner') return err(403, OWNER_ONLY);
    const site = siteOf(env, url), hook = site + '/api/pay/webhook';
    const out = { live: /^(sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY)), signed: !!env.STRIPE_WEBHOOK_SECRET, hook };
    const a = await stripeRaw(env, 'GET', '/account');
    if (a.status === 401) return json(Object.assign(out, { ok: false, step: 'key', error: 'Stripe did not accept the key', detail: a.msg }));
    out.account = a.ok ? { name: ((a.j.settings || {}).dashboard || {}).display_name || (a.j.business_profile || {}).name || '', country: a.j.country, currency: a.j.default_currency, charges: a.j.charges_enabled, payouts: a.j.payouts_enabled } : { unreadable: a.status };
    const s = await stripeRaw(env, 'POST', '/checkout/sessions', {
      mode: 'payment', success_url: site + '/?check={CHECKOUT_SESSION_ID}', cancel_url: site + '/', 'metadata[check]': '1',
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'aed', 'line_items[0][price_data][unit_amount]': '200',
      'line_items[0][price_data][product_data][name]': 'Connection check (not an order)'
    });
    if (!s.ok) return json(Object.assign(out, { ok: false, step: 'checkout', error: 'Stripe cannot open a payment page on this account yet', detail: s.msg }));
    out.checkout = { currency: s.j.currency, methods: s.j.payment_method_types, live: s.j.livemode };
    await stripeRaw(env, 'POST', '/checkout/sessions/' + s.j.id + '/expire', {});
    const EV = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
    const l = await stripeRaw(env, 'GET', '/webhook_endpoints?limit=100');
    if (!l.ok) return json(Object.assign(out, { ok: false, step: 'webhook', error: 'Stripe did not show its webhooks', detail: l.msg }));
    const have = (l.j.data || []).find(w => w.url === hook && w.status === 'enabled' && EV.every(e => (w.enabled_events || []).includes(e) || (w.enabled_events || []).includes('*')));
    if (!have) {
      const c = await stripeRaw(env, 'POST', '/webhook_endpoints', { url: hook, 'enabled_events[0]': EV[0], 'enabled_events[1]': EV[1], description: 'The Touch website: marks orders paid' });
      if (!c.ok) return json(Object.assign(out, { ok: false, step: 'webhook', error: 'Stripe did not create the webhook', detail: c.msg }));
    }
    /* on-site card form: is the publishable key there, and does Stripe know our domain (needed for Apple Pay / Google Pay / Link in the form)? */
    out.form = pubKey(env) ? 'on the site' : env.STRIPE_PUBLISHABLE_KEY ? 'publishable key does not match the secret key (test / live)' : 'no publishable key: Stripe\'s own page is used';
    const host = new URL(site).hostname;
    if (pubKey(env) && !/^(localhost|127\.)/.test(host)) {
      const d = await stripeRaw(env, 'GET', '/payment_method_domains?limit=100&domain_name=' + encodeURIComponent(host));
      let dom = d.ok ? (d.j.data || []).find(x => x.domain_name === host) : null;
      if (d.ok && !dom) { const c = await stripeRaw(env, 'POST', '/payment_method_domains', { domain_name: host }); dom = c.ok ? c.j : null; if (!c.ok) out.domainError = c.msg; }
      if (dom) out.wallets = { domain: dom.domain_name, enabled: dom.enabled, apple_pay: (dom.apple_pay || {}).status, google_pay: (dom.google_pay || {}).status, link: (dom.link || {}).status };
    }
    return json(Object.assign(out, { ok: true, webhook: have ? 'already there' : 'created' }));
  }
  /* staff: "Payment link" on an unpaid order → approves this exact total for card payment and returns the client's link.
     A website order whose total differs from today's catalogue prices needs a second, confirmed call (force). */
  if (op === 'link' && M === 'POST') {
    if (!who) return err(401, 'Sign in');
    const b = await readJSON(req, 500); const id = String(b.id || ''); if (!ID.test(id)) return err(400, 'Bad order');
    const o = await getDoc(db, 'orders', id); if (!o || o.status === 'cancelled') return err(404, 'Order not found');
    if (o.payment && o.payment.paid) return err(409, 'This order is already paid');
    const total = r2(o.total); if (!(total >= 2)) return err(400, 'The amount is too small for a card payment');
    const sum = r2((Array.isArray(o.items) ? o.items : []).reduce((a, l) => a + lineTotal(l), 0) - (Number(o.discount) || 0) + (Number(o.delivery) || 0));
    if (Math.abs(sum - total) > 0.01) return err(409, 'The total of this order does not match its items — check the order first');
    if (o.channel === 'web' && !b.force) { const p = await priceOrder(db, o); if (!p || Math.abs(p.total - total) > 0.01) return json({ check: true, total, catalogue: p ? p.total : null }); }
    const key = KEY.test(o.key || '') ? o.key : randKey();
    const payment = Object.assign({}, o.payment, { linkTotal: total, linkAt: NOW(), linkBy: who.email });
    const r = await db.q(`update docs set data = data || $2::jsonb, updated=$3 where col='orders' and id=$1 and not deleted and coalesce(data->'payment'->>'paid','false') <> 'true'`, [id, JSON.stringify({ key, payment }), NOW()]);
    if (!r.rowCount) return err(409, 'This order is already paid');
    return json({ url: siteOf(env, url) + '/order/' + o.no + '?k=' + key, total, no: o.no });
  }
  if (op === 'checkout' && M === 'POST') {
    const b = await readJSON(req, 500); let o = null, id = '';
    if (b.no) { o = await orderByNo(db, String(b.no), String(b.k || '')); id = o ? String(o.id) : ''; }   // from the order page (payment link)
    else { id = String(b.id || ''); if (!ID.test(id)) return err(400, 'Bad order'); o = await getDoc(db, 'orders', id); }
    if (!o || !ID.test(id) || o.status === 'cancelled') return err(404, 'Order not found');
    if (o.payment && o.payment.paid) return json({ paid: true, no: o.no });
    let p;
    if (linkOk(o)) {   // staff approved this total: charge it as it stands (itemised when the lines add up to it)
      const lines = (Array.isArray(o.items) ? o.items : []).map(l => ({ name: String(l.name || 'Item').slice(0, 120) + (l.unit === 'kg' ? ' · ' + (l.grams >= 1000 ? l.grams / 1000 + ' kg' : l.grams + ' g') : '') + (l.qty > 1 ? ' × ' + l.qty : ''), amount: lineTotal(l) })).filter(l => l.amount > 0);
      const delivery = r2(o.delivery); const whole = Math.abs(r2(lines.reduce((a, l) => a + l.amount, 0) + delivery) - r2(o.total)) < 0.005 && lines.length > 0 && lines.length <= 60;
      p = whole ? { lines, delivery, total: r2(o.total) } : { lines: [{ name: 'The Touch order ' + o.no, amount: r2(o.total) }], delivery: 0, total: r2(o.total) };
    } else {
      if (o.channel !== 'web' || !(o.payment && o.payment.method === 'card_online') || !(NOW() - Number(o.created) < 2 * DAY)) return err(404, 'Order not found');
      p = await priceOrder(db, o);
      if (!p || Math.abs(p.total - Number(o.total)) > 0.01) return err(409, 'The prices have changed — please place your order again');
    }
    const kq = KEY.test(o.key || '') ? '&k=' + o.key : '';
    const back = url.origin + '/order/' + o.no + '?paid=1&sid={CHECKOUT_SESSION_ID}' + kq;
    const q = {
      mode: 'payment', client_reference_id: id, 'metadata[order_id]': id, 'metadata[order_no]': o.no,
      'payment_intent_data[description]': 'The Touch order ' + o.no, 'payment_intent_data[metadata][order_no]': o.no, 'payment_intent_data[metadata][order_id]': id
    };
    const mail = (o.customer || {}).email; if (okEmail(mail)) q.customer_email = mail.trim();
    p.lines.concat(p.delivery > 0 ? [{ name: 'Delivery' + (o.emirate ? ' · ' + o.emirate : ''), amount: p.delivery }] : []).forEach((l, i) => {
      q[`line_items[${i}][quantity]`] = '1'; q[`line_items[${i}][price_data][currency]`] = 'aed';
      q[`line_items[${i}][price_data][unit_amount]`] = String(fils(l.amount)); q[`line_items[${i}][price_data][product_data][name]`] = l.name;
    });
    /* the card form inside our own page (Stripe "embedded" Checkout): needs the publishable key, and the page must ask for it (embed).
       Anything else — or Stripe refusing it — falls back to Stripe's own payment page. */
    const pk = pubKey(env);
    if (b.embed && pk) {
      const e = await stripeRaw(env, 'POST', '/checkout/sessions', Object.assign({}, q, { ui_mode: 'embedded_page', return_url: back }));
      if (e.ok && e.j.client_secret) return json({ clientSecret: e.j.client_secret, pk });
      console.error('stripe embedded form', e.status, e.msg);
    }
    const s = await stripe(env, 'POST', '/checkout/sessions', Object.assign({}, q, { success_url: back, cancel_url: url.origin + '/order/' + o.no + '?pay=cancelled' + kq }));
    if (!s.url) return err(502, 'The payment page could not be opened');
    return json({ url: s.url });
  }
  if (op === 'confirm' && M === 'GET') {
    const sid = String(url.searchParams.get('sid') || ''); if (!/^cs_[A-Za-z0-9_]{6,200}$/.test(sid)) return err(400, 'Bad session');
    return json(await settle(ctx, db, await stripe(env, 'GET', '/checkout/sessions/' + sid), url));
  }
  return err(404, 'Not found');
}

/* ---------- emails ---------- */
const H = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AED = n => { n = Math.round((Number(n) || 0) * 100) / 100; return 'AED ' + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); };
const lineTotal = l => Math.max(0, Math.round(((l.unit === 'kg' ? l.price * l.grams / 1000 : l.price) * l.qty - (l.disc || 0)) * 100) / 100);
const qtyLabel = l => l.unit === 'kg' ? (l.grams >= 1000 ? l.grams / 1000 + ' kg' : l.grams + ' g') + (l.qty > 1 ? ' × ' + l.qty : '') : '× ' + l.qty;
const PAY = { cod: 'Cash on delivery', card_on_delivery: 'Card on delivery', link: 'Payment link', card_online: 'Card online' };
const payName = o => { const p = o.payment || {}, m = p.method; const s = PAY[m] || m; return (o.fulfil === 'pickup' ? s.replace('on delivery', 'at pick-up') : s) + (m === 'card_online' ? (p.paid ? ' — paid' : ' — waiting for payment') : ''); };
const nice = d => { const x = new Date(String(d || '') + 'T12:00:00'); return isNaN(x) ? (d || '') : x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }); };
const okEmail = e => typeof e === 'string' && /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i.test(e.trim());

async function send(env, msg) {   // to customers, through Resend
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY is not set' };
  try {
    const r = await fetch((env.RESEND_API || 'https://api.resend.com') + '/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ from: env.MAIL_FROM || 'The Touch <orders@thetouchchocolate.com>' }, msg))
    });
    if (r.ok) return { ok: true, via: 'resend' };
    const t = (await r.text()).slice(0, 300); console.error('resend', r.status, t); return { ok: false, status: r.status, error: t };
  } catch (e) { console.error('resend', e && e.message); return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
}
const mailBtn = (href, label) => `<p style="margin:26px 0 0;text-align:center"><a href="${H(href)}" style="display:inline-block;background:#1a1412;color:#d9b77e;text-decoration:none;padding:13px 26px;font-size:13px;letter-spacing:2px">${label}</a></p>`;
/* the customer's order confirmation: what they ordered, where and when, and a button to their order page (invoice, card payment) */
function customerMail(d, s, site) {
  const c = d.customer || {}, p = d.payment || {}; const wa = String(s.whatsapp || '').replace(/\D/g, '');
  const page = KEY.test(d.key || '') ? site + '/order/' + d.no + '?k=' + d.key : '';
  const due = p.method === 'card_online' && !p.paid;
  return frame(`<div style="font-family:Georgia,serif;font-size:24px;margin-bottom:8px">Thank you${c.name ? ', ' + H(String(c.name).split(' ')[0]) : ''}</div>
<p style="font-size:14px;line-height:1.7;margin:0 0 20px;color:#5a4a3f">We have received your order <b>${H(d.no)}</b>. ${due ? 'It is confirmed as soon as your card payment is complete.' : 'Our concierge will confirm it with you shortly on WhatsApp.'}</p>${orderTable(d)}${orderFacts(d)}${page ? mailBtn(page, due ? 'COMPLETE YOUR PAYMENT' : 'VIEW YOUR ORDER &amp; INVOICE') : ''}${wa ? `<p style="margin:16px 0 0;text-align:center;font-size:13px"><a href="https://wa.me/${wa}?text=${encodeURIComponent('Hello, about my order ' + d.no)}" style="color:#9c6036">Message us on WhatsApp</a></p>` : ''}`, s);
}
/* boutique inbox: the mail worker when it is connected, otherwise Resend */
async function sendShop(env, msg) {
  try {
    if (env.MAIL) {
      const r = await env.MAIL.fetch('https://mail/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: msg.subject, html: msg.html, replyTo: msg.reply_to }) });
      const t = await r.text(); if (!r.ok) console.error('mail worker', r.status, t.slice(0, 300));
      let j = {}; try { j = JSON.parse(t); } catch (e) { } return { ok: r.ok && j.ok !== false, error: j.error, via: 'cloudflare' };
    }
    if (env.RESEND_API_KEY) { await send(env, msg); return { ok: true, via: 'resend' }; }
    return { ok: false, error: 'No mail service is connected' };
  } catch (e) { console.error('sendShop', e && e.message); return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
}
function frame(inner, s) {
  return `<!doctype html><html><body style="margin:0;background:#f4ede4;padding:28px 12px;font-family:Helvetica,Arial,sans-serif;color:#39261f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffdf9;border:1px solid #e6d8c3">
<tr><td style="background:#1a1412;padding:26px 30px;text-align:center"><div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:3px;color:#d9b77e">THE TOUCH</div>
<div style="font-size:10px;letter-spacing:3px;color:#a88e6a;margin-top:6px">LUXURY CHOCOLATES · ABU DHABI</div></td></tr>
<tr><td style="padding:30px">${inner}</td></tr>
<tr><td style="padding:18px 30px;border-top:1px solid #eee3d3;font-size:12px;color:#8a7766;text-align:center">${H(s.phone || '')}${s.instagram ? ' · @' + H(s.instagram) : ''}<br>${H(s.address || 'Abu Dhabi, United Arab Emirates')}</td></tr>
</table></td></tr></table></body></html>`;
}
function orderTable(o) {
  const rows = (o.items || []).map(l => `<tr><td style="padding:8px 0;border-bottom:1px solid #f0e7da">${H(l.name)}${boxText(l) ? `<div style="font-size:12px;color:#8a7766">${H(boxText(l))}</div>` : ''}<div style="font-size:12px;color:#8a7766">${H(qtyLabel(l))}</div></td><td align="right" style="padding:8px 0;border-bottom:1px solid #f0e7da;white-space:nowrap">${AED(lineTotal(l))}</td></tr>`).join('');
  const t = (k, v, b) => `<tr><td style="padding:4px 0;${b ? 'font-weight:bold;font-size:16px' : 'color:#6d5a4c'}">${k}</td><td align="right" style="padding:4px 0;${b ? 'font-weight:bold;font-size:16px' : ''}">${v}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${rows}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:10px">${t('Subtotal', AED(o.subtotal))}${o.discount ? t('Discount', '−' + AED(o.discount)) : ''}${o.fulfil === 'delivery' ? t('Delivery', o.delivery ? AED(o.delivery) : 'Complimentary') : ''}${t('Total', AED(o.total), 1)}${t('Includes VAT', AED(o.vat))}</table>`;
}
function orderFacts(o) {
  const f = (k, v) => v ? `<tr><td style="padding:3px 14px 3px 0;color:#8a7766;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:3px 0">${v}</td></tr>` : '';
  const c = o.customer || {}, g = o.gift || {};
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:18px">
${f('Order', '<b>' + H(o.no) + '</b>')}${f('Name', H(c.name))}${f('Mobile', H(c.phone))}${f('Email', H(c.email))}
${f(o.fulfil === 'pickup' ? 'Pick-up' : 'Delivery', o.fulfil === 'pickup' ? 'At the boutique' : H([o.address, o.area, o.emirate].filter(Boolean).join(', ')))}
${f('Date', H([nice(o.date), o.slot].filter(Boolean).join(' · ')))}${f('Payment', H(payName(o)))}
${f('Gift', H([g.to && 'To ' + g.to, g.phone, g.msg && '“' + g.msg + '”'].filter(Boolean).join(' · ')))}${f('Notes', H(o.notes))}</table>`;
}
async function notify(env, db, col, d, url) {
  if (!env.RESEND_API_KEY && !env.MAIL) return;
  const origin = url.origin;
  let s = {}; try { const r = await db.q("select data::text from docs where col='settings' and id='main'"); if (r.rows.length) s = JSON.parse(r.rows[0][0]); } catch (e) { }
  const shop = env.SHOP_EMAIL || s.email; const reply = okEmail(s.email) ? s.email : undefined;
  const btn = (href, label) => `<p style="margin:26px 0 0;text-align:center"><a href="${H(href)}" style="display:inline-block;background:#1a1412;color:#d9b77e;text-decoration:none;padding:13px 26px;font-size:13px;letter-spacing:2px">${label}</a></p>`;
  const jobs = [];
  if (col === 'orders') {
    const c = d.customer || {};
    if (okEmail(shop)) jobs.push(sendShop(env, {
      to: [shop], subject: `New web order ${d.no} · ${c.name || ''} · ${AED(d.total)}`, reply_to: okEmail(c.email) ? c.email.trim() : undefined,
      html: frame(`<div style="font-family:Georgia,serif;font-size:22px;margin-bottom:6px">New website order</div><div style="color:#8a7766;font-size:13px;margin-bottom:18px">Confirm it with the client on WhatsApp, then move it on the Orders board.</div>${orderTable(d)}${orderFacts(d)}${btn(origin + '/admin.html', 'OPEN THE ADMIN')}`, s)
    }));
    if (okEmail(c.email)) jobs.push(send(env, { to: [c.email.trim()], subject: `Your order ${d.no} — The Touch`, reply_to: reply, html: customerMail(d, s, siteOf(env, url)) }));
  }
  if (col === 'enquiries' && okEmail(shop)) {
    const f = (k, v) => v ? `<tr><td style="padding:4px 14px 4px 0;color:#8a7766;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:4px 0">${H(v)}</td></tr>` : '';
    jobs.push(sendShop(env, {
      to: [shop], subject: `New event enquiry · ${d.name || ''} · ${d.type || ''}`,
      html: frame(`<div style="font-family:Georgia,serif;font-size:22px;margin-bottom:16px">New event enquiry</div><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">${f('Name', d.name)}${f('Mobile', d.phone)}${f('Event', d.type)}${f('Date', d.date && nice(d.date))}${f('Guests', d.guests)}${f('Budget', d.budget)}${f('Message', d.msg)}</table>${btn(origin + '/admin.html', 'OPEN THE ADMIN')}`, s)
    }));
  }
  await Promise.all(jobs);
}
