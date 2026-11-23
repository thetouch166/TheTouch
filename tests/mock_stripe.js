// A tiny stand-in for Stripe, for local tests only (port 8799). It speaks just enough of the Checkout Sessions API:
//   POST /v1/checkout/sessions        → creates a session, returns { id, url }
//   GET  /v1/checkout/sessions/:id    → the session (payment_status paid after the "payment page" was opened)
//   GET  /pay/:id                     → fake payment page: marks the session paid and returns to success_url
//   GET  /cancel/:id                  → fake payment page: customer pressed "back" → cancel_url
//   POST /_hook/:id?to=<api>&secret=  → sends a signed checkout.session.completed webhook to the API (optionally ?bad=1)
//   GET /v1/account · POST /v1/checkout/sessions/:id/expire · GET|POST /v1/webhook_endpoints   → for POST /api/pay/setup (GET /_hooks lists them)
const http = require('http'), crypto = require('crypto');
const sessions = {}, hooks = []; let n = 0;
const send = (res, code, obj, headers) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers || {})); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8799'); let body = '';
  req.on('data', c => body += c).on('end', async () => {
    try {
      if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        if (req.headers.authorization !== 'Bearer sk_test_mock') return send(res, 401, { error: { message: 'bad key' } });
        const p = new URLSearchParams(body); const id = 'cs_test_mock' + (++n) + crypto.randomBytes(4).toString('hex'); let total = 0; const names = [];
        for (let i = 0; p.has(`line_items[${i}][quantity]`); i++) { total += Number(p.get(`line_items[${i}][quantity]`)) * Number(p.get(`line_items[${i}][price_data][unit_amount]`)); names.push(p.get(`line_items[${i}][price_data][product_data][name]`)); if (p.get(`line_items[${i}][price_data][currency]`) !== 'aed') return send(res, 400, { error: { message: 'currency' } }); }
        if (p.get('mode') !== 'payment' || !p.get('success_url').includes('{CHECKOUT_SESSION_ID}') || !total) return send(res, 400, { error: { message: 'bad params' } });
        sessions[id] = { id, object: 'checkout.session', url: 'http://127.0.0.1:8799/pay/' + id, amount_total: total, currency: 'aed', payment_status: 'unpaid', client_reference_id: p.get('client_reference_id'), metadata: { order_id: p.get('metadata[order_id]'), order_no: p.get('metadata[order_no]') }, customer_email: p.get('customer_email'), success_url: p.get('success_url'), cancel_url: p.get('cancel_url'), payment_intent: 'pi_mock_' + n, _names: names };
        return send(res, 200, sessions[id]);
      }
      /* the calls of POST /api/pay/setup */
      if (url.pathname === '/v1/account' && req.method === 'GET') return req.headers.authorization === 'Bearer sk_test_mock' ? send(res, 200, { id: 'acct_mock', country: 'AE', default_currency: 'aed', charges_enabled: true, payouts_enabled: true, settings: { dashboard: { display_name: 'The Touch (mock)' } } }) : send(res, 401, { error: { message: 'Invalid API Key provided' } });
      const ex = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)\/expire$/.exec(url.pathname);
      if (req.method === 'POST' && ex && sessions[ex[1]]) { sessions[ex[1]].status = 'expired'; return send(res, 200, sessions[ex[1]]); }
      if (url.pathname === '/v1/webhook_endpoints' && req.method === 'GET') return send(res, 200, { data: hooks });
      if (url.pathname === '/v1/webhook_endpoints' && req.method === 'POST') { const p = new URLSearchParams(body); const w = { id: 'we_mock' + (hooks.length + 1), url: p.get('url'), status: 'enabled', enabled_events: [p.get('enabled_events[0]'), p.get('enabled_events[1]')].filter(Boolean) }; hooks.push(w); return send(res, 200, Object.assign({ secret: 'whsec_never_used' }, w)); }
      if (url.pathname === '/_hooks') return send(res, 200, hooks);
      const m = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) return sessions[m[1]] ? send(res, 200, sessions[m[1]]) : send(res, 404, { error: { message: 'no such session' } });
      const pg = /^\/(pay|cancel)\/(cs_[A-Za-z0-9_]+)$/.exec(url.pathname);
      if (req.method === 'GET' && pg && sessions[pg[2]]) { const s = sessions[pg[2]]; if (pg[1] === 'pay') s.payment_status = 'paid'; res.writeHead(302, { Location: pg[1] === 'pay' ? s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) : s.cancel_url }); return res.end(); }
      const hk = /^\/_hook\/(cs_[A-Za-z0-9_]+)$/.exec(url.pathname);
      if (req.method === 'POST' && hk && sessions[hk[1]]) {
        const s = sessions[hk[1]]; s.payment_status = 'paid'; const payload = JSON.stringify({ id: 'evt_mock', type: 'checkout.session.completed', data: { object: s } }); const t = Math.floor(Date.now() / 1000);
        const sig = crypto.createHmac('sha256', url.searchParams.get('bad') ? 'wrong-secret' : url.searchParams.get('secret')).update(t + '.' + payload).digest('hex');
        const r = await fetch(url.searchParams.get('to') + '/api/pay/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` }, body: payload });
        return send(res, 200, { status: r.status, body: (await r.text()).slice(0, 200) });
      }
      if (url.pathname === '/_sessions') return send(res, 200, Object.values(sessions));
      send(res, 404, { error: { message: 'not found' } });
    } catch (e) { send(res, 500, { error: { message: String(e.message) } }); }
  });
}).listen(8799, '127.0.0.1', () => console.log('mock stripe on 8799'));
