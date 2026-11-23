# Card payment with ONLY the Stripe key set (no webhook secret), the way the shop runs it, and POST /api/pay/setup.
# Needs: `node tests/mock_stripe.js`, `npx wrangler pages dev --port 8788` with STRIPE_SECRET_KEY="sk_test_mock",
# STRIPE_API="http://127.0.0.1:8799" and NO STRIPE_WEBHOOK_SECRET in .dev.vars (test database).   Run: python tests/pay_setup_test.py
import json, time, urllib.request
B, MOCK = 'http://127.0.0.1:8788', 'http://127.0.0.1:8799'
ok = True
def check(name, cond, extra=''):
    global ok; ok = ok and bool(cond); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra != '' else ''))
def api(method, path, body=None, token=None, base=B):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header('Content-Type', 'application/json')
    if token: req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=40) as r: return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or '{}')
        except Exception: return e.code, {}
tok = api('POST', '/api/login', {'email': 'owner@thetouch.ae', 'pass': 'secret123'})[1]['token']
order = lambda oid: api('GET', '/api/db/orders/' + oid, token=tok)[1]
hook = lambda ev: api('POST', '/api/pay/webhook', ev)

# setup: owner only, checks the account, makes the webhook once
check('setup needs a sign-in', api('POST', '/api/pay/setup', {})[0] == 401)
n0 = len(api('GET', '/_hooks', base=MOCK)[1])
st, s1 = api('POST', '/api/pay/setup', {}, tok)
check('setup: account read, payment page opens in AED', st == 200 and s1.get('ok') is True and (s1.get('account') or {}).get('charges') is True and (s1.get('checkout') or {}).get('currency') == 'aed', json.dumps(s1))
check('setup: test key is reported as not live, unsigned mode', s1.get('live') is False and s1.get('signed') is False)
st, s2 = api('POST', '/api/pay/setup', {}, tok); hooks = api('GET', '/_hooks', base=MOCK)[1]
check('setup: webhook made once, second run finds it', s2.get('webhook') == 'already there' and len(hooks) == max(n0, 1) and hooks[-1]['url'].endswith('/api/pay/webhook') and len(hooks[-1]['enabled_events']) == 2, json.dumps(hooks))
check('setup answer holds no secret', 'whsec' not in json.dumps(s1) + json.dumps(s2) and 'sk_test' not in json.dumps(s1))

# a website order paid by card
prods = [p for p in api('GET', '/api/db/products')[1]['rows'] if p.get('active') is not False and p.get('web') is not False and p.get('price', 0) > 4]
p = prods[0]; kg = p.get('unit') == 'kg'; amt = round(p['price'] / 2, 2) if kg else p['price']   # half a kilo, or one piece
oid = 'o_ps' + str(int(time.time())); no = 'W-PS' + str(int(time.time()))[-6:]
o = {'id': oid, 'no': no, 'channel': 'web', 'status': 'new', 'created': int(time.time() * 1000), 'customer': {'name': 'Setup Tester', 'phone': '0501234567', 'email': ''},
     'fulfil': 'pickup', 'emirate': 'Abu Dhabi', 'area': '', 'address': '', 'date': '', 'slot': '', 'gift': {}, 'notes': '',
     'items': [{'pid': p['id'], 'name': p['name'], 'unit': p.get('unit'), 'price': p['price'], 'grams': 500 if kg else 0, 'qty': 1, 'disc': 0}],
     'subtotal': amt, 'discount': 0, 'delivery': 0, 'total': amt, 'vat': round(amt - amt / 1.05, 2), 'payment': {'method': 'card_online', 'paid': False}, 'stockApplied': False}
r = api('PUT', '/api/db/orders/' + oid, o); check('order saved the way the website saves it (no sign-in)', r[0] == 200, str(r))
st, c = api('POST', '/api/pay/checkout', {'id': oid}); sid = (c.get('url') or '').rsplit('/', 1)[-1]
check('payment page opened', st == 200 and sid.startswith('cs_'), json.dumps(c))
ev = lambda sess: {'id': 'evt_x', 'type': 'checkout.session.completed', 'data': {'object': sess}}
claim = {'id': sid, 'payment_status': 'paid', 'client_reference_id': oid, 'metadata': {'order_id': oid}, 'currency': 'aed', 'amount_total': round(amt * 100)}
r = hook(ev(claim)); check('made-up "paid" message for an unpaid payment changes nothing', order(oid)['payment'].get('paid') is False, str(r))
r = hook(ev(dict(claim, id='cs_test_doesnotexist123'))); check('message about an unknown payment is refused', r[0] == 400 and order(oid)['payment'].get('paid') is False, str(r))
r = hook(ev(dict(claim, id='not-a-session'))); check('message with a bad id is refused', r[0] == 400, str(r))
urllib.request.urlopen(urllib.request.Request(MOCK + '/pay/' + sid, method='GET')).read()   # the client pays on Stripe's page (returns to the site)
o2 = order(oid)
if not o2['payment'].get('paid'):   # normally the return to the order page settles it; here we want the webhook to do it
    r = hook(ev({'id': sid})); o2 = order(oid); check('real paid payment: the webhook message marks the order paid', r[0] == 200 and o2['payment'].get('paid') is True, str(r))
else: check('real paid payment: order is paid', True)
pa = o2['payment']; check('paid as Card online, full amount, with Stripe reference', pa.get('method') == 'card_online' and abs(pa.get('other', 0) - o['total']) < 0.001 and str(pa.get('ref', '')).startswith('pi_'), json.dumps(pa))
r = hook(ev({'id': sid})); check('same message again changes nothing', r[0] == 200 and order(oid)['payment'].get('paidAt') == pa.get('paidAt'))
api('DELETE', '/api/db/orders/' + oid, token=tok)
print('ALL PASS' if ok else 'SOME FAILED')
