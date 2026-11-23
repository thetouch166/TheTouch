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
     STRIPE_WEBHOOK_SECRET  signing secret of the Stripe webhook → https://<site>/api/pay/webhook  (whsec_…)
   Plain vars (wrangler.toml): MAIL_FROM, SHOP_EMAIL
*/

const COLS = ['products', 'settings', 'orders', 'enquiries', 'shifts', 'stock', 'subscribers'];
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
const publicDoc = (col, d) => { if (col === 'settings') delete d.pin; return d; };

/* ---------- router ---------- */
export async function onRequest(ctx) {
  const { request: req, env } = ctx;
  const url = new URL(req.url);
  const seg = (Array.isArray(ctx.params.path) ? ctx.params.path : [ctx.params.path]).filter(Boolean);
  const [a, col, id, op] = seg; const M = req.method;
  try {
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
    if (a === 'me') return who ? json({ email: who.email, role: who.role, name: who.name, source: who.source }) : err(401, 'Sign in');
    if (a === 'staff') return await staffApi(ctx, db, who, col);
    if (a === 'password' && M === 'POST') return await changePassword(ctx, db, who);

    if (a === 'mailtest' && M === 'POST') {   // admin: check that the boutique inbox receives mail (?summary=1 → yesterday's sales summary)
      if (!staff) return err(401, 'Sign in'); if (!owner) return err(403, OWNER_ONLY);
      if (url.searchParams.get('summary')) {
        if (!env.MAIL) return json({ ok: false, error: 'The mail worker is not connected' });
        const r = await env.MAIL.fetch('https://mail/summary', { method: 'POST' }); return json(await r.text());
      }
      return json(await sendShop(env, { to: [env.SHOP_EMAIL], subject: 'Test email from The Touch admin', html: frame(`<div style="font-family:Georgia,serif;font-size:22px;margin-bottom:10px">It works</div><p style="font-size:14px;line-height:1.7;margin:0;color:#5a4a3f">This inbox receives an email for every new website order and event enquiry. Sent by ${H(staff)}.</p>`, {}) }));
    }

    if (a === 'sync' && M === 'GET') {   // admin: everything that changed since a moment
      if (!staff) return err(401, 'Sign in');
      const cols = String(url.searchParams.get('cols') || '').split(',').filter(c => COLS.includes(c) && (owner || c !== 'subscribers'));
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

    if (a === 'pay') return await pay(ctx, db, col, url);

    if (a !== 'db' || !COLS.includes(col) || (id && !ID.test(id))) return err(404, 'Not found');

    /* read */
    if (M === 'GET' && !id) {
      if (!staff && !PUBLIC_READ.includes(col)) return err(401, 'Sign in');
      if (staff && !owner && col === 'subscribers') return err(403, OWNER_ONLY);
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
        await db.q(`insert into docs (col,id,data,updated,deleted) values ($1,$2,$3::jsonb,$4,false)
          on conflict (col,id) do update set data=excluded.data, updated=excluded.updated, deleted=false`, [col, id, JSON.stringify(d), NOW()]);
        if (PUBLIC_READ.includes(col)) await purge(url.origin, col);
        return json({ ok: true });
      }
      if (!PUBLIC_CREATE.includes(col) || !publicCreateOk(col, d)) return err(403, 'Not allowed');
      const r = await db.q('insert into docs (col,id,data,updated) values ($1,$2,$3::jsonb,$4) on conflict (col,id) do nothing', [col, id, JSON.stringify(d), NOW()]);
      if (!r.rowCount) return err(409, 'Already exists');
      if (col === 'orders' || col === 'enquiries') ctx.waitUntil(notify(env, db, col, d, url.origin).catch(e => console.error('email', e)));
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
async function stripe(env, method, path, params) {
  const init = { method, headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY } };
  if (params) { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(params).toString(); }
  const r = await fetch((env.STRIPE_API || 'https://api.stripe.com') + '/v1' + path, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('stripe', method, path, r.status, j.error && j.error.message); throw Object.assign(new Error('The payment service did not answer — please try again'), { status: 502 }); }
  return j;
}
async function getDoc(db, col, id) { const r = await db.q('select data::text from docs where col=$1 and id=$2 and not deleted', [col, id]); return r.rows.length ? JSON.parse(r.rows[0][0]) : null; }
/* the order's lines and total from the catalogue's own prices (same sums as the website: store.js lineTotal / deliveryFee) */
async function priceOrder(db, o) {
  const [pr, st] = await Promise.all([db.q("select data::text from docs where col='products' and not deleted"), db.q("select data::text from docs where col='settings' and id='main'")]);
  const prods = {}; pr.rows.forEach(([d]) => { const p = JSON.parse(d); prods[p.id] = p; }); const s = st.rows.length ? JSON.parse(st.rows[0][0]) : {};
  const lines = [];
  for (const l of (Array.isArray(o.items) ? o.items : [])) {
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
async function settle(ctx, db, session, origin) {
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
async function pay(ctx, db, op, url) {
  const { request: req, env } = ctx; const M = req.method;
  if (op === 'webhook' && M === 'POST') {
    if (!env.STRIPE_WEBHOOK_SECRET) return err(503, 'The webhook secret is not set');
    const body = await req.text();
    if (!await stripeSigOk(env.STRIPE_WEBHOOK_SECRET, req.headers.get('Stripe-Signature'), body)) return err(400, 'Bad signature');
    let ev; try { ev = JSON.parse(body); } catch (e) { return err(400, 'Bad json'); }
    if (ev && (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded')) await settle(ctx, db, ev.data && ev.data.object, url.origin);
    return json({ received: true });
  }
  if (!env.STRIPE_SECRET_KEY) return err(503, 'Card payment is not available yet');
  if (op === 'checkout' && M === 'POST') {
    const b = await readJSON(req, 500); const id = String(b.id || ''); if (!ID.test(id)) return err(400, 'Bad order');
    const o = await getDoc(db, 'orders', id);
    if (!o || o.channel !== 'web' || o.status === 'cancelled' || !(o.payment && o.payment.method === 'card_online') || !(NOW() - Number(o.created) < 2 * DAY)) return err(404, 'Order not found');
    if (o.payment.paid) return json({ paid: true, no: o.no });
    const p = await priceOrder(db, o);
    if (!p || Math.abs(p.total - Number(o.total)) > 0.01) return err(409, 'The prices have changed — please place your order again');
    const q = {
      mode: 'payment', client_reference_id: id, 'metadata[order_id]': id, 'metadata[order_no]': o.no,
      success_url: url.origin + '/order/' + o.no + '?paid=1&sid={CHECKOUT_SESSION_ID}', cancel_url: url.origin + '/order/' + o.no + '?pay=cancelled',
      'payment_intent_data[description]': 'The Touch order ' + o.no, 'payment_intent_data[metadata][order_no]': o.no, 'payment_intent_data[metadata][order_id]': id
    };
    const mail = (o.customer || {}).email; if (okEmail(mail)) q.customer_email = mail.trim();
    p.lines.concat(p.delivery > 0 ? [{ name: 'Delivery' + (o.emirate ? ' · ' + o.emirate : ''), amount: p.delivery }] : []).forEach((l, i) => {
      q[`line_items[${i}][quantity]`] = '1'; q[`line_items[${i}][price_data][currency]`] = 'aed';
      q[`line_items[${i}][price_data][unit_amount]`] = String(fils(l.amount)); q[`line_items[${i}][price_data][product_data][name]`] = l.name;
    });
    const s = await stripe(env, 'POST', '/checkout/sessions', q);
    if (!s.url) return err(502, 'The payment page could not be opened');
    return json({ url: s.url });
  }
  if (op === 'confirm' && M === 'GET') {
    const sid = String(url.searchParams.get('sid') || ''); if (!/^cs_[A-Za-z0-9_]{6,200}$/.test(sid)) return err(400, 'Bad session');
    return json(await settle(ctx, db, await stripe(env, 'GET', '/checkout/sessions/' + sid), url.origin));
  }
  return err(404, 'Not found');
}

/* ---------- emails ---------- */
const H = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AED = n => 'AED ' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const lineTotal = l => Math.max(0, Math.round(((l.unit === 'kg' ? l.price * l.grams / 1000 : l.price) * l.qty - (l.disc || 0)) * 100) / 100);
const qtyLabel = l => l.unit === 'kg' ? (l.grams >= 1000 ? l.grams / 1000 + ' kg' : l.grams + ' g') + (l.qty > 1 ? ' × ' + l.qty : '') : '× ' + l.qty;
const PAY = { cod: 'Cash on delivery', card_on_delivery: 'Card on delivery', link: 'Payment link', card_online: 'Card online' };
const payName = o => { const p = o.payment || {}, m = p.method; const s = PAY[m] || m; return (o.fulfil === 'pickup' ? s.replace('on delivery', 'at pick-up') : s) + (m === 'card_online' ? (p.paid ? ' — paid' : ' — waiting for payment') : ''); };
const nice = d => { const x = new Date(String(d || '') + 'T12:00:00'); return isNaN(x) ? (d || '') : x.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }); };
const okEmail = e => typeof e === 'string' && /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i.test(e.trim());

async function send(env, msg) {
  if (!env.RESEND_API_KEY) return;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ from: env.MAIL_FROM || 'The Touch <orders@thetouchchocolate.com>' }, msg))
  });
  if (!r.ok) console.error('resend', r.status, (await r.text()).slice(0, 300));
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
  const rows = (o.items || []).map(l => `<tr><td style="padding:8px 0;border-bottom:1px solid #f0e7da">${H(l.name)}<div style="font-size:12px;color:#8a7766">${H(qtyLabel(l))}</div></td><td align="right" style="padding:8px 0;border-bottom:1px solid #f0e7da;white-space:nowrap">${AED(lineTotal(l))}</td></tr>`).join('');
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
async function notify(env, db, col, d, origin) {
  if (!env.RESEND_API_KEY && !env.MAIL) return;
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
    if (okEmail(c.email)) {
      const wa = String(s.whatsapp || '').replace(/\D/g, '');
      jobs.push(send(env, {
        to: [c.email.trim()], subject: `Your order ${d.no} — The Touch`, reply_to: reply,
        html: frame(`<div style="font-family:Georgia,serif;font-size:24px;margin-bottom:8px">Thank you${c.name ? ', ' + H(String(c.name).split(' ')[0]) : ''}</div>
<p style="font-size:14px;line-height:1.7;margin:0 0 20px;color:#5a4a3f">We have received your order <b>${H(d.no)}</b>. Our concierge will confirm it with you shortly on WhatsApp.</p>${orderTable(d)}${orderFacts(d)}${wa ? btn('https://wa.me/' + wa + '?text=' + encodeURIComponent('Hello, about my order ' + d.no), 'MESSAGE US ON WHATSAPP') : ''}`, s)
      }));
    }
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
