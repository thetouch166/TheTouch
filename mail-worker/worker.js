/* THE TOUCH — mail worker (Cloudflare Worker "the-touch-mail")
   Sends the boutique its own emails through Cloudflare Email, with no outside mail account:
     • POST /send     — called by the website's API (service binding MAIL) for a new web order or event enquiry
     • POST /summary  — yesterday's sales summary, on demand (Admin → API /api/mailtest?summary=1)
     • every morning at 09:00 Abu Dhabi time — yesterday's sales summary (cron in wrangler.toml)
   Mail always goes to the boutique inbox (SHOP_INBOX, a verified Email Routing address) — never to an address
   that arrives in a request — so this worker cannot be used to email anyone else. It has no public address:
   only the website's API can call it. Customer emails are sent by the API through Resend (see functions/api).
   Deploy:  cd mail-worker && npx wrangler deploy        Secret: DATABASE_URL (same Neon string as the website) */

const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const H = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AED = n => 'AED ' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const okEmail = e => typeof e === 'string' && /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i.test(e.trim());
// plain-text version of an HTML email (some mail apps show only this; it also helps deliverability)
const toText = html => String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li|\/table)[^>]*>/gi, '\n').replace(/<\/t[dh]>/gi, '  ').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function deliver(env, m) {
  const msg = { to: env.SHOP_INBOX, from: { email: env.MAIL_FROM, name: 'The Touch' }, subject: String(m.subject || 'The Touch').slice(0, 200), html: String(m.html || ''), text: m.text || toText(m.html) || String(m.subject || '') };
  if (okEmail(m.replyTo)) msg.replyTo = m.replyTo.trim();
  const r = await env.EMAIL.send(msg);
  return { ok: true, id: (r && r.messageId) || '' };
}

/* ---------- yesterday's sales (Neon over HTTPS, same table as the website) ---------- */
async function rows(env, query, params) {
  const cs = env.DATABASE_URL; if (!cs) throw new Error('DATABASE_URL is not set');
  const host = new URL(cs.replace(/^postgres(ql)?:/, 'https:')).hostname;
  const r = await fetch('https://' + host.replace(/^[^.]+\./, 'api.') + '/sql', { method: 'POST', headers: { 'Neon-Connection-String': cs, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true' }, body: JSON.stringify({ query, params: (params || []).map(String) }) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || 'database ' + r.status);
  return (j.rows || []).map(([d]) => JSON.parse(d));
}
const DXB = 4 * 3600e3;   // Abu Dhabi is UTC+4 all year
async function summary(env, now) {
  const today = Math.floor((now + DXB) / 864e5) * 864e5 - DXB; const from = today - 864e5;   // yesterday, midnight to midnight in Abu Dhabi
  const [orders, products, waiting] = await Promise.all([
    rows(env, "select data::text from docs where col='orders' and not deleted and (data->>'created')::bigint >= $1 and (data->>'created')::bigint < $2", [from, today]),
    rows(env, "select data::text from docs where col='products' and not deleted", []),
    rows(env, "select data::text from docs where col='orders' and not deleted and data->>'status'='new' and data->>'channel'='web'", [])
  ]);
  const sold = orders.filter(o => o.status !== 'cancelled'); const sum = f => sold.reduce((a, o) => a + (Number(f(o)) || 0), 0);
  const paid = o => (o.payment && o.payment.paid) ? o.payment : {};
  const items = {}; sold.forEach(o => (o.items || []).forEach(l => { const k = l.name || '?'; const amt = Math.max(0, ((l.unit === 'kg' ? l.price * l.grams / 1000 : l.price) * l.qty) - (l.disc || 0)); const it = items[k] || (items[k] = { n: 0, g: 0, amt: 0 }); it.amt += amt; if (l.unit === 'kg') it.g += (l.grams || 0) * (l.qty || 1); else it.n += l.qty || 0; }));
  const top = Object.keys(items).sort((a, b) => items[b].amt - items[a].amt).slice(0, 8);
  const low = products.filter(p => p.active !== false && (Number(p.stock) || 0) < (p.min != null && p.min !== '' && isFinite(+p.min) ? +p.min : (p.unit === 'kg' ? 2 : 5))).sort((a, b) => (a.stock || 0) - (b.stock || 0));
  const day = new Date(from + DXB).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const row = (k, v, b) => `<tr><td style="padding:6px 0;${b ? 'font-weight:bold;font-size:17px' : 'color:#6d5a4c'}">${k}</td><td align="right" style="padding:6px 0;${b ? 'font-weight:bold;font-size:17px' : ''}">${v}</td></tr>`;
  const h = t => `<div style="font-family:Georgia,serif;font-size:17px;margin:26px 0 8px;color:#40050e">${t}</div>`;
  const stockOf = p => p.unit === 'kg' ? (Math.round((p.stock || 0) * 100) / 100) + ' kg' : (p.stock || 0) + ' pcs';
  const inner = `<div style="font-family:Georgia,serif;font-size:23px;margin-bottom:4px">Sales summary</div><div style="color:#8a7766;font-size:13px;margin-bottom:18px">${H(day)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
${row('Total sales', AED(sum(o => o.total)), true)}${row('Number of sales', sold.length + (orders.length - sold.length ? ' (+' + (orders.length - sold.length) + ' cancelled)' : ''))}
${row('In the boutique (POS)', sold.filter(o => o.channel !== 'web').length)}${row('Website orders', sold.filter(o => o.channel === 'web').length)}
${row('Cash collected', AED(sum(o => paid(o).cash)))}${row('Card collected', AED(sum(o => paid(o).card)))}${row('Link / online', AED(sum(o => paid(o).other)))}</table>
${top.length ? h('Best sellers') + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${top.map(k => row(H(k) + ' <span style="color:#8a7766">· ' + (items[k].g ? (items[k].g >= 1000 ? Math.round(items[k].g / 10) / 100 + ' kg' : items[k].g + ' g') : '× ' + items[k].n) + '</span>', AED(items[k].amt))).join('')}</table>` : '<p style="font-size:14px;color:#6d5a4c;margin-top:18px">No sales were recorded on this day.</p>'}
${waiting.length ? h('Website orders waiting for confirmation') + `<p style="font-size:14px;margin:0">${waiting.map(o => H(o.no) + ' · ' + H((o.customer || {}).name || '') + ' · ' + AED(o.total)).join('<br>')}</p>` : ''}
${low.length ? h('Low or out of stock') + `<p style="font-size:14px;margin:0;line-height:1.7">${low.slice(0, 25).map(p => H(p.name) + ' <span style="color:#8a7766">· ' + H(stockOf(p)) + '</span>').join('<br>')}${low.length > 25 ? '<br>… and ' + (low.length - 25) + ' more' : ''}</p>` : ''}
<p style="margin:28px 0 0;text-align:center"><a href="${H(env.SITE_URL)}/admin.html" style="display:inline-block;background:#1a1412;color:#d9b77e;text-decoration:none;padding:13px 26px;font-size:13px;letter-spacing:2px">OPEN THE ADMIN</a></p>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4ede4;padding:28px 12px;font-family:Helvetica,Arial,sans-serif;color:#39261f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffdf9;border:1px solid #e6d8c3">
<tr><td style="background:#1a1412;padding:26px 30px;text-align:center"><div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:3px;color:#d9b77e">THE TOUCH</div>
<div style="font-size:10px;letter-spacing:3px;color:#a88e6a;margin-top:6px">LUXURY CHOCOLATES · ABU DHABI</div></td></tr><tr><td style="padding:30px">${inner}</td></tr></table></td></tr></table></body></html>`;
  return { subject: `Sales summary · ${day} · ${AED(sum(o => o.total))} · ${sold.length} sale${sold.length === 1 ? '' : 's'}`, html };
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return json({ ok: false, error: 'Not found' }, 404);
    try {
      if (path === '/summary') return json(await deliver(env, await summary(env, Date.now())));
      if (path === '/send') { const m = await request.json(); if (!m || !m.subject || !m.html) return json({ ok: false, error: 'subject and html are required' }, 400); return json(await deliver(env, m)); }
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (e) { console.error('mail', path, e && e.message, e && e.code); return json({ ok: false, error: String((e && e.message) || e).slice(0, 300), code: e && e.code }, 502); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(summary(env, event.scheduledTime || Date.now()).then(m => deliver(env, m)).catch(e => console.error('daily summary', e && e.message, e && e.code)));
  }
};
