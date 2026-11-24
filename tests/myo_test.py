# Local end-to-end test of "Make your own box": the builder on a phone, the bag, the order with the chocolate of every line,
# the admin, stock per chosen chocolate, and the price rebuilt on the server for card payment.
# Needs the same servers as pay_test.py (`node tests/mock_stripe.js` + `npx wrangler pages dev --port 8788`, test database).
# Run: python tests/myo_test.py <folder for screenshots>
import sys, json, time, urllib.request
from playwright.sync_api import sync_playwright
B, MOCK, out = 'http://127.0.0.1:8788', 'http://127.0.0.1:8799', sys.argv[1]
T = str(int(time.time()))[-5:]
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
S0 = api('GET', '/api/db/settings/main', token=tok)[1]; myo0, pay0 = S0.get('myo'), S0.get('onlinePayments')
kg = [p for p in api('GET', '/api/db/products', token=tok)[1]['rows'] if p.get('unit') == 'kg' and p.get('active') is not False and p.get('img') and 'monogram' not in p['img'] and (p.get('stock') or 0) > 3]
offer = [p['id'] for p in kg[:5]]; name = {p['id']: p['name'] for p in kg}; price = {p['id']: p['price'] for p in kg}
MYO = {'on': True, 'title': 'Make your own box', 'intro': 'Nine lines, each one a chocolate you choose.', 'name': 'Signature box', 'grams': 1100, 'lines': 9, 'per': 7,
       'mode': 'fixed', 'kgPrice': 0, 'price': 315, 'fee': 0, 'round': 0, 'maxSame': 9, 'items': offer, 'favourites': offer[:3]}
api('PATCH', '/api/db/settings/main', {'myo': MYO, 'onlinePayments': ['cod', 'card_online', 'card_on_delivery', 'link']}, tok)
per_line = round(1100 / 9, 2)
order_of = lambda who: next((o for o in api('GET', '/api/db/orders', token=tok)[1]['rows'] if (o.get('customer') or {}).get('name') == who), None)

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); errs = []
        m = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True).new_page(); m.on('pageerror', lambda e: errs.append('phone: ' + str(e)[:200]))

        # 1. the builder: only the chocolates chosen in the admin, the admin's price
        m.goto(B + '/make-your-own'); m.wait_for_selector('#mgrid .mch', timeout=30000); m.wait_for_timeout(800)
        check('the builder offers exactly the chocolates chosen in the admin', sorted(m.evaluate("[...document.querySelectorAll('#mgrid .mch')].map(e=>e.dataset.p)")) == sorted(offer))
        check('the price comes from the admin', '315' in m.inner_text('#mpr'), m.inner_text('#mpr'))
        m.click('#mset button[data-set="fav"]'); m.wait_for_selector('#madd', timeout=25000); m.wait_for_timeout(1500)
        check('a full box offers "Add my box to the bag" with its price', '315' in m.inner_text('#madd'), m.inner_text('#madd'))
        m.screenshot(path=out + '/myo-ready-phone.png')

        # 2. the bag
        m.click('#madd'); m.wait_for_selector('#cart.open .ci .bx', timeout=10000); m.wait_for_timeout(500)
        check('the bag holds one line for the box, with what is inside', m.inner_text('#cart .ci .n') == 'Signature box (make your own)' and name[offer[0]] in m.inner_text('#cart .ci .bx') and '315' in m.inner_text('#cart .ci .p'), m.inner_text('#cart .ci .bx'))
        bag = m.evaluate("JSON.parse(localStorage.tt_cart)")
        check('the bag line keeps the chocolate of every line and its grams', len(bag) == 1 and bag[0]['pid'] == 'myo' and len(bag[0]['box']) == 9 and all(abs(x['g'] - per_line) < 0.01 and x['pid'] in offer for x in bag[0]['box']), json.dumps(bag[0]['box'][:2]))
        m.screenshot(path=out + '/myo-bag-phone.png')
        box = bag[0]['box']; used = {}
        for x in box: used[x['pid']] = used.get(x['pid'], 0) + 1

        # 3. "Change" opens the same box again, and adding it replaces the line (no second box)
        m.click('#cart .ci .bx a'); m.wait_for_selector('#madd', timeout=25000); m.wait_for_timeout(900)
        check('"Change" opens the builder with the same nine lines', m.url.endswith('/make-your-own') and m.locator('.lane.full').count() == 9)
        m.click('#madd'); m.wait_for_selector('#cart.open .ci', timeout=10000); m.wait_for_timeout(400)
        check('adding the changed box replaces the old one', len(m.evaluate("JSON.parse(localStorage.tt_cart)")) == 1 and m.evaluate("JSON.parse(localStorage.tt_cart)[0].qty") == 1)

        # 4. checkout and the order
        who = 'Box Tester ' + T
        m.goto(B + '/checkout'); m.wait_for_selector('#place', timeout=20000); m.wait_for_timeout(900)
        check('checkout lists the box with its contents', 'Signature box (make your own)' in m.inner_text('#sumItems') and name[offer[0]] in m.inner_text('#sumItems'), m.inner_text('#sumItems')[:120].replace('\n', ' '))
        m.fill('input[name=name]', who); m.fill('input[name=phone]', '0501234567'); m.fill('input[name=email]', 'box@example.com'); m.click('#mode button[data-m=pickup]')
        m.check('#pay input[value=cod]'); m.click('#place'); m.wait_for_url('**/order/**', timeout=30000); m.wait_for_selector('#invc', timeout=20000); m.wait_for_timeout(1200)
        o = order_of(who); l = (o or {}).get('items', [{}])[0]
        check('the order is saved with the box and every line', bool(o) and l.get('pid') == 'myo' and l.get('price') == 315 and o['subtotal'] == 315 and o['total'] == 315 and [x['pid'] for x in l.get('box', [])] == [x['pid'] for x in box], json.dumps(l)[:160])
        want = ' · '.join(f'{i + 1} {x["name"]}' for i, x in enumerate(box))
        check('the customer invoice names the chocolate of every line', want in m.inner_text('#invc'), m.inner_text('#invc')[:200].replace('\n', ' '))
        st, v = api('GET', f"/api/order/{o['no']}?k={o['key']}")
        check('the order page on another device gets the lines too (names only)', st == 200 and [x['name'] for x in v['items'][0]['box']] == [x['name'] for x in box] and 'pid' not in v['items'][0]['box'][0])
        m.screenshot(path=out + '/myo-order-phone.png', full_page=True)

        # 5. the admin: the lines on the order, stock by chocolate
        a = b.new_context(viewport={'width': 1440, 'height': 900}).new_page(); a.on('pageerror', lambda e: errs.append('admin: ' + str(e)[:200]))
        a.goto(B + '/admin.html'); a.wait_for_selector('input[type=email], #view', timeout=30000)
        if a.locator('input[type=email]').count():
            a.fill('input[type=email]', 'owner@thetouch.ae'); a.fill('input[type=password]', 'secret123'); a.keyboard.press('Enter')
        a.wait_for_function("typeof ORDERS!=='undefined'&&ORDERS.some(o=>o.id==='%s')" % o['id'], timeout=40000); a.wait_for_timeout(800)
        a.evaluate("document.querySelectorAll('#modalRoot [data-close]').forEach(b=>b.click())"); a.wait_for_timeout(300)
        check('the order is not flagged as altered', a.evaluate("!ORDERS.find(o=>o.id==='%s').tampered" % o['id']))
        a.evaluate("go('orders')"); a.wait_for_timeout(500); a.evaluate("openOrder('%s')" % o['id']); a.wait_for_selector('.bxl li', timeout=10000)
        check('the admin order lists the nine lines in order', a.evaluate("[...document.querySelectorAll('.bxl li')].map(e=>e.textContent)") == [x['name'] for x in box])
        a.screenshot(path=out + '/myo-admin-order.png')
        s0 = {pid: a.evaluate("prod('%s').stock" % pid) for pid in used}
        a.evaluate("document.querySelectorAll('#modalRoot [data-close]').forEach(b=>b.click())"); a.wait_for_timeout(300)
        a.evaluate("void setStatus(ORDERS.find(o=>o.id==='%s'),'confirmed')" % o['id']); a.wait_for_timeout(3000)
        s1 = {pid: a.evaluate("prod('%s').stock" % pid) for pid in used}
        check('confirming the order takes each chocolate out of stock by its lines', all(abs((s0[p] - s1[p]) - round(used[p] * per_line / 1000, 2)) < 0.011 for p in used), json.dumps({p: round(s0[p] - s1[p], 3) for p in used}))
        a.evaluate("void setStatus(ORDERS.find(o=>o.id==='%s'),'cancelled')" % o['id']); a.click("#modalRoot button:has-text('Cancel order')", timeout=8000); a.wait_for_timeout(3000)
        check('cancelling puts it back', all(abs(a.evaluate("prod('%s').stock" % p) - s0[p]) < 0.011 for p in used))
        a.evaluate("document.querySelectorAll('#modalRoot [data-close]').forEach(b=>b.click());go('myo')"); a.wait_for_selector('#my_on', timeout=10000)
        check('the admin screen can open and close the page', a.is_enabled('#my_on') and a.is_checked('#my_on'))

        # 6. card payment: the amount is worked out on the server, never taken from the browser
        def web_order(oid, line_price, total):
            return {'id': oid, 'no': 'W' + T + oid[-3:].upper(), 'channel': 'web', 'status': 'new', 'created': int(time.time() * 1000), 'stockApplied': False, 'fulfil': 'pickup', 'customer': {'name': 'Card Box ' + T, 'phone': '0501234567', 'email': 'box@example.com'},
                    'items': [{'pid': 'myo', 'name': 'Signature box (make your own)', 'unit': 'pc', 'price': line_price, 'grams': 0, 'qty': 1, 'disc': 0, 'box': box}], 'subtotal': total, 'discount': 0, 'delivery': 0, 'total': total, 'vat': round(total - total / 1.05, 2), 'payment': {'method': 'card_online', 'paid': False}}
        api('PUT', '/api/db/orders/omyo' + T + 'ok1', web_order('omyo' + T + 'ok1', 315, 315))
        st, r = api('POST', '/api/pay/checkout', {'id': 'omyo' + T + 'ok1'})
        sess = json.loads(urllib.request.urlopen(MOCK + '/_sessions').read().decode())
        mine = [s for s in sess if s.get('client_reference_id') == 'omyo' + T + 'ok1']
        check('card payment for the box charges the admin price', st == 200 and bool(r.get('url') or r.get('clientSecret')) and len(mine) == 1 and mine[0]['amount_total'] == 31500, f'{st} {json.dumps(r)[:80]} {[s.get("amount_total") for s in mine]}')
        api('PUT', '/api/db/orders/omyo' + T + 'lo1', web_order('omyo' + T + 'lo1', 10, 10))
        st, r = api('POST', '/api/pay/checkout', {'id': 'omyo' + T + 'lo1'})
        check('a box sent with another price is refused for card payment', st == 409, f'{st} {json.dumps(r)[:80]}')
        bad = web_order('omyo' + T + 'bx1', 315, 315); bad['items'][0]['box'] = box[:8] + [{'pid': 'not-a-chocolate', 'name': 'x', 'g': per_line}]
        api('PUT', '/api/db/orders/' + bad['id'], bad); st, r = api('POST', '/api/pay/checkout', {'id': bad['id']})
        check('a box with something that is not offered is refused', st == 409, f'{st}')

        # 7. by weight: the price follows the chosen chocolates; closed: gone from the website and not payable
        api('PATCH', '/api/db/settings/main', {'myo': dict(MYO, mode='weight', fee=20, round=5)}, tok)
        exp = sum(price[x['pid']] * (1100 / 9) / 1000 for x in box) + 20; exp = -(-exp // 5) * 5
        api('PUT', '/api/db/orders/omyo' + T + 'wt1', web_order('omyo' + T + 'wt1', exp, exp)); st, r = api('POST', '/api/pay/checkout', {'id': 'omyo' + T + 'wt1'})
        check('by weight + packaging, rounded up to 5: same sum on the server', st == 200, f'{st} expected {exp} {json.dumps(r)[:90]}')
        m.goto(B + '/make-your-own'); m.wait_for_selector('#madd', timeout=25000); m.wait_for_timeout(600)
        check('the website shows that same price', ('%g' % exp) in m.inner_text('#madd').replace(',', ''), m.inner_text('#madd'))
        m.click('#madd'); m.wait_for_selector('#cart.open .ci .bx', timeout=10000); m.wait_for_timeout(300)   # a box waits in the bag while the owner closes the page
        api('PATCH', '/api/db/settings/main', {'myo': dict(MYO, on=False)}, tok)
        st, r = api('POST', '/api/pay/checkout', {'id': 'omyo' + T + 'ok1'})
        check('closed in the admin: a box can no longer be paid by card', st == 409, f'{st}')
        m.goto(B + '/'); m.wait_for_selector('.occs .occ', timeout=30000); m.wait_for_timeout(1500); m.evaluate("openDrawer('cart')"); m.wait_for_timeout(700)
        check('closed in the admin: no invitation on the home page, the bag drops the box', m.locator('.hmyo').count() == 0 and m.evaluate("(JSON.parse(localStorage.tt_cart||'[]')).filter(i=>i.pid==='myo').length") == 0)
        m.goto(B + '/make-your-own'); m.wait_for_timeout(2500)
        check('closed in the admin: the page says it is being prepared', 'being prepared' in m.inner_text('main'))
        check('no JS errors', not errs, '; '.join(errs)[:400])
        b.close()
finally:
    # tidy the test database
    api('PATCH', '/api/db/settings/main', {'myo': myo0 if myo0 is not None else dict(MYO, on=False), 'onlinePayments': pay0 if pay0 is not None else ['cod', 'card_on_delivery', 'link']}, tok)
    for o in api('GET', '/api/db/orders', token=tok)[1].get('rows', []):
        if str(o.get('id', '')).startswith('omyo' + T) or (o.get('customer') or {}).get('name') in ('Box Tester ' + T, 'Card Box ' + T): api('DELETE', '/api/db/orders/' + o['id'], token=tok)
print('ALL PASS' if ok else 'SOME FAILED')
