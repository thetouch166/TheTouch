/* THE TOUCH — API on Cloudflare Pages Functions  →  https://<site>/api/*
   Database : Neon Postgres. One table of JSON documents, so orders / products / shifts keep exactly the
              same field names as before (see CLAUDE.md "Shapes"). Talks to Neon over HTTPS — no npm packages.
   Photos   : Cloudflare KV (binding PHOTOS_KV), or R2 (binding PHOTOS) when it is switched on — uploaded from
              Admin → Products, served at /media/…
   Email    : Resend — new web order → boutique + customer, new event enquiry → boutique.

   Secrets (Cloudflare → Workers & Pages → the-touch → Settings → Variables and secrets):
     DATABASE_URL    Neon connection string (pooled)                                         required
     STAFF_LOGINS    who can open the admin:  owner@thetouch.ae:Password1; shop@thetouch.ae:Password2  required
     RESEND_API_KEY  Resend API key                                             optional (no key = no emails)
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
  const body = b64u(te.encode(JSON.stringify({ e: email, x: NOW() + 30 * DAY })));
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), te.encode(body)));
}
async function whoIs(req, env) {
  const m = /^Bearer\s+([\w-]+)\.([\w-]+)$/.exec(req.headers.get('Authorization') || ''); if (!m) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(m[2]), te.encode(m[1]))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(m[1])));
    if (!(p.x > NOW())) return null;
    return staffList(env).some(s => s.email === p.e) ? p.e : null;   // removed from STAFF_LOGINS = signed out
  } catch (e) { return null; }
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
      ['cod', 'card_on_delivery', 'link'].includes(p.method) && Array.isArray(d.items) && d.items.length > 0 && d.items.length < 50 &&
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
    const staff = await whoIs(req, env);

    if (a === 'login' && M === 'POST') {
      const ip = req.headers.get('CF-Connecting-IP') || 'local';
      const [n] = (await db.q('select count(*) from login_fail where ip=$1 and at>$2', [ip, NOW() - 15 * 6e4])).rows[0];
      if (+n >= 10) return err(429, 'Too many attempts — try again in 15 minutes');
      const b = await readJSON(req, 2000); const email = String(b.email || '').trim().toLowerCase();
      const user = staffList(env).find(s => s.email === email);
      if (user && await sameText(user.pass, b.pass || '')) return json({ token: await makeToken(env, email), email });
      await db.tx([['insert into login_fail (ip, at) values ($1,$2)', [ip, NOW()]], ['delete from login_fail where at<$1', [NOW() - DAY]]]);
      return err(401, 'Wrong email or password');
    }
    if (a === 'me') return staff ? json({ email: staff }) : err(401, 'Sign in');

    if (a === 'sync' && M === 'GET') {   // admin: everything that changed since a moment
      if (!staff) return err(401, 'Sign in');
      const cols = String(url.searchParams.get('cols') || '').split(',').filter(c => COLS.includes(c));
      const since = Math.max(0, +url.searchParams.get('since') || 0); const t = NOW();
      if (!cols.length) return json({ t, rows: [] });
      const r = await db.q('select col, id, deleted, data::text from docs where col = any($1::text[]) and updated > $2', ['{' + cols.join(',') + '}', since]);
      return json('{"t":' + t + ',"rows":[' + r.rows.map(([c, i, del, d]) => '{"c":' + JSON.stringify(c) + ',"id":' + JSON.stringify(i) + ',"d":' + (del === 't' ? 'null' : d) + '}').join(',') + ']}');
    }

    if (a === 'upload' && M === 'POST') {   // admin: product photo → R2
      if (!staff) return err(401, 'Sign in');
      if (!env.PHOTOS && !env.PHOTOS_KV) return err(503, 'Photo storage is not connected');
      const type = (req.headers.get('Content-Type') || '').split(';')[0];
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type]; if (!ext) return err(415, 'JPEG, PNG or WebP only');
      const buf = await req.arrayBuffer(); if (!buf.byteLength || buf.byteLength > 5e6) return err(413, 'Photo must be under 5 MB');
      const key = 'p/' + NOW().toString(36) + '-' + crypto.randomUUID().slice(0, 8) + '.' + ext;
      if (env.PHOTOS) await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
      else await env.PHOTOS_KV.put(key, buf, { metadata: { type } });
      return json({ url: '/media/' + key });
    }

    if (a !== 'db' || !COLS.includes(col) || (id && !ID.test(id))) return err(404, 'Not found');

    /* read */
    if (M === 'GET' && !id) {
      if (!staff && !PUBLIC_READ.includes(col)) return err(401, 'Sign in');
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
      await db.q(`insert into docs (col,id,data,updated,deleted) values ($1,$2,$3::jsonb,$4,false)
        on conflict (col,id) do update set data = case when docs.deleted then excluded.data else docs.data || excluded.data end, updated=excluded.updated, deleted=false`,
        [col, id, JSON.stringify(Object.assign({ id }, part)), NOW()]);
      if (PUBLIC_READ.includes(col)) await purge(url.origin, col);
      return json({ ok: true });
    }
    if (M === 'POST' && op === 'inc') {   // atomic +/− (stock)
      const b = await readJSON(req, 500); const f = String(b.field || ''); const delta = Number(b.delta);
      if (!/^[A-Za-z0-9_]{1,40}$/.test(f) || !isFinite(delta)) return err(400, 'Bad increment');
      await db.q(`update docs set data = jsonb_set(data, array[$3::text], to_jsonb(round(coalesce(nullif(data->>$3::text,'')::numeric,0) + $4::numeric, 2))), updated=$5
        where col=$1 and id=$2 and not deleted`, [col, id, f, delta, NOW()]);
      if (PUBLIC_READ.includes(col)) await purge(url.origin, col);
      return json({ ok: true });
    }
    if (M === 'DELETE') {   // soft delete so other screens see it disappear; the content itself is wiped
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

/* ---------- emails (Resend) ---------- */
const H = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AED = n => 'AED ' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const lineTotal = l => Math.max(0, Math.round(((l.unit === 'kg' ? l.price * l.grams / 1000 : l.price) * l.qty - (l.disc || 0)) * 100) / 100);
const qtyLabel = l => l.unit === 'kg' ? (l.grams >= 1000 ? l.grams / 1000 + ' kg' : l.grams + ' g') + (l.qty > 1 ? ' × ' + l.qty : '') : '× ' + l.qty;
const PAY = { cod: 'Cash on delivery', card_on_delivery: 'Card on delivery', link: 'Payment link' };
const payName = o => { const m = (o.payment || {}).method; const s = PAY[m] || m; return o.fulfil === 'pickup' ? s.replace('on delivery', 'at pick-up') : s; };
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
  if (!env.RESEND_API_KEY) return;
  let s = {}; try { const r = await db.q("select data::text from docs where col='settings' and id='main'"); if (r.rows.length) s = JSON.parse(r.rows[0][0]); } catch (e) { }
  const shop = env.SHOP_EMAIL || s.email; const reply = okEmail(s.email) ? s.email : undefined;
  const btn = (href, label) => `<p style="margin:26px 0 0;text-align:center"><a href="${H(href)}" style="display:inline-block;background:#1a1412;color:#d9b77e;text-decoration:none;padding:13px 26px;font-size:13px;letter-spacing:2px">${label}</a></p>`;
  const jobs = [];
  if (col === 'orders') {
    const c = d.customer || {};
    if (okEmail(shop)) jobs.push(send(env, {
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
    jobs.push(send(env, {
      to: [shop], subject: `New event enquiry · ${d.name || ''} · ${d.type || ''}`,
      html: frame(`<div style="font-family:Georgia,serif;font-size:22px;margin-bottom:16px">New event enquiry</div><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">${f('Name', d.name)}${f('Mobile', d.phone)}${f('Event', d.type)}${f('Date', d.date && nice(d.date))}${f('Guests', d.guests)}${f('Budget', d.budget)}${f('Message', d.msg)}</table>${btn(origin + '/admin.html', 'OPEN THE ADMIN')}`, s)
    }));
  }
  await Promise.all(jobs);
}
