# Local end-to-end test of the order page (invoice), the payment link, the WhatsApp order message and the admin's new-order alert.
# Needs the same local servers as pay_test.py: `node tests/mock_stripe.js` and `npx wrangler pages dev --port 8788` (test database, mock Stripe in .dev.vars).
# Run: python tests/order_link_test.py <folder for screenshots>
import sys, json, time, urllib.request, urllib.parse
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
api('PATCH', '/api/db/settings/main', {'onlinePayments': ['cod', 'card_on_delivery', 'link']}, tok)
made = []

with sync_playwright() as pw:
    b = pw.chromium.launch(); errs = []
    ctx = b.new_context(viewport={'width': 1280, 'height': 900}); ctx.grant_permissions(['clipboard-read', 'clipboard-write'])

    # admin first, so that the new order arrives while it is open (as in the shop)
    a = ctx.new_page(); a.on('pageerror', lambda e: errs.append('admin: ' + str(e)))
    a.goto(B + '/admin.html'); a.wait_for_selector('#lemail'); a.fill('#lemail', 'owner@thetouch.ae'); a.fill('#lpass', 'secret123'); a.click('#emailUI button')
    a.wait_for_function("typeof ORDERS!=='undefined' && seenOrders!==null", timeout=40000)
    a.wait_for_timeout(900); a.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())")
    a.evaluate("(()=>{window.__rings=0;const c=window.chime;window.chime=function(f){window.__rings++;return c(f)}})()")

    # 1. the customer orders (cash at pick-up) → order page with the invoice
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append('web: ' + str(e)))
    pg.goto(B + '/p/kunafah'); pg.wait_for_selector('#add'); pg.click('#add'); pg.wait_for_timeout(400)
    pg.goto(B + '/checkout'); pg.wait_for_selector('#cof')
    pg.fill('input[name=name]', 'Link Tester'); pg.fill('input[name=phone]', '0501234567'); pg.fill('input[name=email]', 'client@example.com')
    pg.click('#mode button[data-m=pickup]'); pg.fill('input[name=notes]', 'Gold ribbon please')
    pg.click('#place'); pg.wait_for_url('**/order/**', timeout=30000); pg.wait_for_selector('#invc', timeout=20000); pg.wait_for_timeout(1500)
    last = pg.evaluate("JSON.parse(sessionStorage.tt_last)"); made.append(last['id']); no, key = last['no'], last.get('key', '')
    check('order page address carries the private key', ('k=' + key) in pg.url and len(key) >= 16, pg.url.split('/order/')[-1])
    inv = pg.inner_text('#invc')
    check('invoice shows number, client, item, total and payment state', no in inv and 'Link Tester' in inv and 'Kunafah' in inv and 'AWAITING PAYMENT' in inv.upper() and 'VAT' in inv, inv.replace('\n', ' | ')[:230])
    check('no card payment offered on a cash order', pg.locator('#payNow').count() == 0 and 'received' in pg.inner_text('#okH').lower(), pg.inner_text('#okH'))
    wa = urllib.parse.unquote(pg.get_attribute('#waBtn', 'href').split('text=')[1])
    check('WhatsApp message: branded, bold total, order link', '*THE TOUCH*' in wa and ('*' + no + '*') in wa and '*Total:' in wa and ('/order/' + no + '?k=' + key) in wa and 'Gold ribbon please' in wa, wa.replace('\n', ' / ')[:300])
    print('--- WhatsApp message ---\n' + wa + '\n------------------------')
    pg.screenshot(path=out + '/order-invoice.png', full_page=True)
    pg.emulate_media(media='print'); pg.screenshot(path=out + '/order-invoice-print.png', full_page=True)
    vis = pg.evaluate("[!!document.querySelector('header.top')&&getComputedStyle(document.querySelector('header.top')).display, getComputedStyle(document.querySelector('#invc')).display, getComputedStyle(document.querySelector('#waBtn')).display]")
    check('printing shows only the invoice', vis[0] == 'none' and vis[1] != 'none', str(vis)); pg.emulate_media(media='screen')

    # 2. the admin rings and shows the pop-up with the order
    a.bring_to_front(); a.wait_for_selector('.mbox.nal', timeout=25000)
    pop = a.inner_text('.mbox.nal')
    check('admin pop-up shows the new order with its details', no in pop and 'Link Tester' in pop and 'Kunafah' in pop and 'Gold ribbon please' in pop and 'Not paid yet' in pop, pop.replace('\n', ' | ')[:260])
    check('the alert sound was played', a.evaluate("window.__rings") >= 1, a.evaluate("window.__rings"))
    a.screenshot(path=out + '/admin-new-order.png')
    r0 = a.evaluate("window.__rings"); a.wait_for_timeout(5600)
    check('it rings again while the pop-up is open', a.evaluate("window.__rings") > r0, f"{r0} → {a.evaluate('window.__rings')}")
    a.click('.mbox.nal #naok'); a.wait_for_timeout(2500)
    check('"Confirm order" moves it to Confirmed and closes the pop-up', a.locator('.mbox.nal').count() == 0 and order(last['id'])['status'] == 'confirmed', order(last['id'])['status'])
    r1 = a.evaluate("window.__rings"); a.wait_for_timeout(5600)
    check('ringing stops after the pop-up is closed', a.evaluate("window.__rings") == r1)

    # 3. the order page from another device (no memory of the order): key needed, no private details
    st, v = api('GET', f'/api/order/{no}?k={key}')
    check('order summary opens with the key', st == 200 and v.get('no') == no and v.get('canPay') is False and v['customer'].get('name') == 'Link Tester', json.dumps(v)[:160])
    check('summary has no phone, e-mail or id', 'phone' not in json.dumps(v) and 'client@example.com' not in json.dumps(v) and last['id'] not in json.dumps(v))
    check('wrong key / no key → not found', api('GET', f'/api/order/{no}?k=' + 'A' * 22)[0] == 404 and api('GET', f'/api/order/{no}')[0] == 404)
    check('card payment not possible before the boutique sends a link', api('POST', '/api/pay/checkout', {'no': no, 'k': key})[0] == 404)
    forged = dict(last); forged.update({'id': 'o_forged' + str(int(time.time())), 'no': 'W-FORGED1', 'status': 'new', 'payment': {'method': 'cod', 'paid': False, 'linkTotal': last['total'], 'linkAt': int(time.time() * 1000)}})
    check('a website order cannot approve its own payment link', api('PUT', '/api/db/orders/' + forged['id'], forged)[0] == 403)

    # 4. the boutique makes the payment link
    check('payment link needs a signed-in person', api('POST', '/api/pay/link', {'id': last['id']})[0] == 401)
    a.evaluate("go('orders')"); a.wait_for_timeout(600); a.evaluate("openOrder('%s')" % last['id']); a.wait_for_selector('[data-plink]')
    a.click('[data-plink]'); a.wait_for_selector('#plu', timeout=20000)
    link = a.input_value('#plu'); href = urllib.parse.unquote(a.get_attribute('.modal a[href*="wa.me"] >> nth=-1', 'href'))
    check('admin shows the link and a WhatsApp message with it', link == f'{B}/order/{no}?k={key}' and link in href and 'pay securely by card' in href and '971501234567' in href, link)
    a.screenshot(path=out + '/admin-payment-link.png')
    a.click('#plc'); a.wait_for_timeout(300)
    check('"Copy link" copies it', a.evaluate("navigator.clipboard.readText()") == link)
    p = order(last['id'])['payment']
    check('the order remembers the approved amount', abs(p.get('linkTotal', 0) - last['total']) < 0.001 and p.get('paid') is False and p.get('linkBy') == 'owner@thetouch.ae', json.dumps(p))

    # 5. the client opens the link on another device and pays
    ctx2 = b.new_context(viewport={'width': 390, 'height': 844}); ph = ctx2.new_page(); ph.on('pageerror', lambda e: errs.append('phone: ' + str(e)))
    ph.goto(link); ph.wait_for_selector('#payNow', timeout=25000)
    check('link page: payment due, invoice, pay button', 'payment' in ph.inner_text('#okH').lower() and 'Payment due' in ph.inner_text('#payBox') and 'Link Tester' in ph.inner_text('#invc') and ph.locator('#payShare').count() == 1, ph.inner_text('#payBox').replace('\n', ' '))
    ph.screenshot(path=out + '/link-phone-due.png', full_page=True)
    ph.click('#payNow'); ph.wait_for_url('**paid=1**', timeout=30000); ph.wait_for_function("document.querySelector('#payBox') && /Payment received/.test(document.querySelector('#payBox').innerText)", timeout=25000); ph.wait_for_timeout(1200)
    check('after paying: back on the order page, with the key', ('k=' + key) in ph.url and 'sid=cs_' in ph.url, ph.url.split('?')[-1][:80])
    check('page says paid and the invoice says PAID', 'paid' in ph.inner_text('#okH').lower() and 'PAID · CARD ONLINE' in ph.inner_text('#invc').upper() and ph.locator('#payNow').count() == 0, ph.inner_text('#okH'))
    ph.screenshot(path=out + '/link-phone-paid.png', full_page=True)
    o = order(last['id']); p = o['payment']
    check('order is paid in the database as "Card online"', p.get('paid') is True and p.get('method') == 'card_online' and abs(p.get('other', 0) - o['total']) < 0.001, json.dumps(p)[:200])
    s0 = [s for s in json.loads(urllib.request.urlopen(MOCK + '/_sessions').read()) if s['client_reference_id'] == last['id']][0]
    check('amount charged = order total', s0['amount_total'] == round(o['total'] * 100), s0['amount_total'])
    check('paying again is not possible', api('POST', '/api/pay/checkout', {'no': no, 'k': key})[1].get('paid') is True and api('POST', '/api/pay/link', {'id': last['id']}, tok)[0] == 409)
    a.wait_for_function("(ORDERS.find(x=>x.id==='%s')||{payment:{}}).payment.paid===true" % last['id'], timeout=20000); a.wait_for_timeout(400)
    check('admin is told the payment arrived', 'Payment received' in a.inner_text('#toast') and no in a.inner_text('#toast'), a.inner_text('#toast'))

    # 6. background signal + settings
    t0 = api('GET', '/api/ping')[1].get('t', 0)
    check('the "something new" signal works without signing in', isinstance(t0, (int, float)) and t0 > 0, t0)
    a.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())"); a.evaluate("go('settings')"); a.wait_for_selector('#alsnd')
    a.click('#altone button[data-t=bell]'); a.click('#alrep button[data-v=""]')
    saved = a.evaluate("JSON.parse(localStorage.tt_alert)")
    check('sound settings are saved on the device', saved.get('tone') == 'bell' and saved.get('repeat') is False and saved.get('sound') is True, json.dumps(saved))
    a.click('#btest'); a.wait_for_selector('.mbox.nal')
    check('"Test order alert" shows a sample pop-up', 'Test' in a.inner_text('.mbox.nal .mh') and 'only a test' in a.inner_text('.mbox.nal'))
    a.screenshot(path=out + '/admin-alert-test.png'); a.click('.mbox.nal [data-close]')
    a.screenshot(path=out + '/admin-alert-settings.png', full_page=True)
    a.click('#alsnd button[data-v=""]'); r2 = a.evaluate("window.__rings"); a.evaluate("chime()")
    check('sound off = silent', a.evaluate("ALERT.sound") is False)
    a.click('#alsnd button[data-v="1"]'); a.click('#altone button[data-t=chime]'); a.click('#alrep button[data-v="1"]')
    check('no JS errors', not errs, '; '.join(errs)[:400])
    b.close()
for oid in made: api('DELETE', '/api/db/orders/' + oid, token=tok)
api('PATCH', '/api/db/settings/main', {'onlinePayments': before or ['cod', 'card_on_delivery', 'link']}, tok)
print('ALL PASS' if ok else 'SOME FAILED')
