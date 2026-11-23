# Local end-to-end test of card payment. Needs: `node tests/mock_stripe.js` (stands in for Stripe), `npx wrangler pages dev --port 8788`
# with STRIPE_SECRET_KEY="sk_test_mock", STRIPE_API="http://127.0.0.1:8799", STRIPE_WEBHOOK_SECRET="whsec_mock_local" in .dev.vars (test database).
# Run: python tests/pay_test.py <folder for screenshots>
import sys, json, urllib.request
from playwright.sync_api import sync_playwright
B, MOCK, out = 'http://127.0.0.1:8788', 'http://127.0.0.1:8799', sys.argv[1]
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
st, settings = api('GET', '/api/db/settings/main', token=tok); before = settings.get('onlinePayments')
api('PATCH', '/api/db/settings/main', {'onlinePayments': ['card_online', 'cod', 'card_on_delivery', 'link']}, tok)

def checkout(pg, name):
    pg.goto(B + '/p/kunafah'); pg.wait_for_timeout(1200); pg.click('#add'); pg.wait_for_timeout(400)
    pg.goto(B + '/checkout'); pg.wait_for_timeout(1200)
    pg.fill('input[name=name]', name); pg.fill('input[name=phone]', '0501234567'); pg.fill('input[name=email]', 'client@example.com')
    pg.fill('input[name=area]', 'Al Reem Island'); pg.fill('input[name=address]', 'Tower 1, flat 2')

with sync_playwright() as pw:
    b = pw.chromium.launch(); errs = []
    ctx = b.new_context(viewport={'width': 1280, 'height': 900}); pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))

    # A. pay successfully and return to the confirmation page
    checkout(pg, 'Card Tester')
    check('card is offered first and selected', pg.evaluate("document.querySelector('#pay input:checked').value") == 'card_online', pg.evaluate("[...document.querySelectorAll('#pay input')].map(i=>i.value).join(',')"))
    check('button says "Continue to payment"', pg.inner_text('#place').strip().lower() == 'continue to payment', pg.inner_text('#place'))
    pg.screenshot(path=out + '/pay-checkout.png', full_page=True)
    pg.click('#place'); pg.wait_for_url('**/order/**', timeout=30000); pg.wait_for_timeout(2500)
    check('returned to the confirmation page with a session', 'paid=1' in pg.url and 'sid=cs_' in pg.url, pg.url)
    check('page says the payment was received', 'Payment received' in pg.inner_text('#payBox') and 'paid' in pg.inner_text('#okH').lower(), pg.inner_text('#payBox'))
    pg.screenshot(path=out + '/pay-paid.png')
    last = pg.evaluate("JSON.parse(sessionStorage.tt_last)"); o = order(last['id']); p = o['payment']
    check('order is paid in the database', p.get('paid') is True and p.get('method') == 'card_online' and abs(p.get('other', 0) - o['total']) < 0.001 and p.get('cash') == 0 and str(p.get('ref', '')).startswith('pi_'), json.dumps(p))
    sess = json.loads(urllib.request.urlopen(MOCK + '/_sessions').read())
    s0 = [s for s in sess if s['client_reference_id'] == last['id']][0]
    check('amount sent to Stripe = order total (in fils), from server prices', s0['amount_total'] == round(o['total'] * 100) and s0['currency'] == 'aed', f"{s0['amount_total']} · {s0['_names']}")
    check('customer email passed to Stripe', s0['customer_email'] == 'client@example.com')
    check('confirm again does not change anything', api('GET', '/api/pay/confirm?sid=' + s0['id'])[1].get('paid') is True and order(last['id'])['payment']['paidAt'] == p['paidAt'])

    # B. customer leaves the payment page → order saved, unpaid, "pay now" → then Stripe's webhook marks it paid
    pg2 = ctx.new_page(); pg2.on('pageerror', lambda e: errs.append(str(e)))
    pg2.route('**/pay/cs_*', lambda route: route.continue_(url=route.request.url.replace('/pay/', '/cancel/')))
    checkout(pg2, 'Cancel Tester'); pg2.click('#place'); pg2.wait_for_url('**/order/**', timeout=30000); pg2.wait_for_timeout(1500)
    check('cancelled payment returns to the order page', 'pay=cancelled' in pg2.url and 'not completed' in pg2.inner_text('#payBox') and pg2.locator('#payNow').count() == 1, pg2.inner_text('#payBox').replace('\n', ' '))
    pg2.screenshot(path=out + '/pay-cancelled.png')
    last2 = pg2.evaluate("JSON.parse(sessionStorage.tt_last)")
    check('order is saved and unpaid', order(last2['id'])['payment'].get('paid') is False)
    s1 = [s for s in json.loads(urllib.request.urlopen(MOCK + '/_sessions').read()) if s['client_reference_id'] == last2['id']][0]
    bad = api('POST', f"/_hook/{s1['id']}?to={B}&secret=x&bad=1", {}, base=MOCK)[1]
    check('webhook with a wrong signature is refused', bad.get('status') == 400 and order(last2['id'])['payment'].get('paid') is False, str(bad))
    good = api('POST', f"/_hook/{s1['id']}?to={B}&secret=whsec_mock_local", {}, base=MOCK)[1]
    check('signed webhook marks the order paid', good.get('status') == 200 and order(last2['id'])['payment'].get('paid') is True, str(good))
    pg2.unroute('**/pay/cs_*'); pg2.click('#payNow'); pg2.wait_for_timeout(2000)
    check('"Pay by card now" on an already-paid order shows it as paid (no second charge)', 'Payment received' in pg2.inner_text('#payBox'), pg2.inner_text('#payBox'))

    # C. the amount cannot be changed from the browser
    tam = dict(last2); tam.update({'id': 'o_tamper1', 'no': 'W-TAMPER1', 'total': 1.0, 'subtotal': 1.0, 'delivery': 0, 'payment': {'method': 'card_online', 'paid': False}})
    check('tampered order can be saved (as today) …', api('PUT', '/api/db/orders/o_tamper1', tam)[0] in (200, 409))
    check('… but cannot be paid for 1 dirham', api('POST', '/api/pay/checkout', {'id': 'o_tamper1'})[0] == 409)
    check('cash-on-delivery order cannot open a card payment', api('POST', '/api/pay/checkout', {'id': 'o_none'})[0] == 404)
    check('public cannot mark an order paid by writing it', api('PATCH', '/api/db/orders/' + last2['id'], {'payment': {'paid': True}})[0] == 401)

    # D. admin sees it
    a = ctx.new_page(); a.on('pageerror', lambda e: errs.append(str(e)))
    a.goto(B + '/admin.html'); a.wait_for_timeout(1500); a.fill('#lemail', 'owner@thetouch.ae'); a.fill('#lpass', 'secret123'); a.click('#emailUI button'); a.wait_for_timeout(3500)
    info = a.evaluate("(()=>{const o=ORDERS.find(x=>x.id==='%s');return o?{paid:o.payment.paid,label:payName(o),other:o.payment.other,tampered:!!o.tampered}:null})()" % last['id'])
    check('admin shows the order as paid by "Card online"', info and info['paid'] is True and info['label'] == 'Card online' and not info['tampered'], json.dumps(info))
    a.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())"); a.evaluate("go('settings')"); a.wait_for_timeout(900)
    check('settings has the "Card online" switch', a.locator('#pmeth .chip[data-p=card_online]').count() == 1 and 'on' in a.get_attribute('#pmeth .chip[data-p=card_online]', 'class'))
    check('no JS errors', not errs, '; '.join(errs)[:300])
    b.close()
for oid in ('o_tamper1',): api('DELETE', '/api/db/orders/' + oid, token=tok)
api('PATCH', '/api/db/settings/main', {'onlinePayments': before or ['cod', 'card_on_delivery', 'link']}, tok)
print('ALL PASS' if ok else 'SOME FAILED')
