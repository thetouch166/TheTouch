# Company flow, end to end on the local live-mode server (test database):
# company → quotation → sent link → the company approves on its page → invoice (order, channel b2b) → card payment → receipt.
# Needs: `node tests/mock_stripe.js` and `npx wrangler pages dev --port 8788` (.dev.vars as for pay_test.py).
# Run: python tests/quote_test.py <folder for screenshots>
import sys, json, time, urllib.request
from playwright.sync_api import sync_playwright
B, out = 'http://127.0.0.1:8788', sys.argv[1]
ok = True
def check(name, cond, extra=''):
    global ok; ok = ok and bool(cond); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra != '' else ''), flush=True)
def api(method, path, body=None, token=None):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header('Content-Type', 'application/json')
    if token: req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=40) as r: return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or '{}')
        except Exception: return e.code, {}
own = api('POST', '/api/login', {'email': 'owner@thetouch.ae', 'pass': 'secret123'})[1]['token']
T = str(int(time.time()))[-6:]; CO = 'Falcon Trading LLC ' + T; made = {'quotes': [], 'orders': [], 'companies': []}

# 1. rules: quotations and companies are for the owner only
check('public cannot list quotations or companies', api('GET', '/api/db/quotes')[0] == 401 and api('GET', '/api/db/companies')[0] == 401)
CE = 'cashier.q' + T + '@example.com'
api('POST', '/api/staff', {'email': CE, 'name': 'Quote Cashier', 'role': 'cashier', 'pass': 'Cashier-2026q'}, own)
cash = api('POST', '/api/login', {'email': CE, 'pass': 'Cashier-2026q'})[1].get('token')
check('cashier cannot read or write quotations', bool(cash) and api('GET', '/api/db/quotes', token=cash)[0] == 403 and api('PUT', '/api/db/quotes/q_x' + T, {'no': 'Q-X'}, cash)[0] == 403 and api('GET', '/api/sync?cols=quotes,orders&since=0', token=cash)[0] == 200 and not [r for r in api('GET', '/api/sync?cols=quotes,orders&since=0', token=cash)[1]['rows'] if r['c'] == 'quotes'])
for u in api('GET', '/api/staff', token=own)[1].get('rows', []):
    if u.get('email') == CE: api('DELETE', '/api/staff/' + u['id'], token=own)

prods = [p for p in api('GET', '/api/db/products')[1]['rows'] if p.get('active') is not False]
P = prods[0]; stock0 = api('GET', '/api/db/products/' + P['id'], token=own)[1].get('stock')
link = inv = None

with sync_playwright() as pw:
    b = pw.chromium.launch(); errs = []
    ctx = b.new_context(viewport={'width': 1366, 'height': 900}); a = ctx.new_page()
    a.on('pageerror', lambda e: errs.append('admin: ' + str(e)[:200]))
    a.goto(B + '/admin.html'); a.wait_for_selector('#lemail'); a.fill('#lemail', 'owner@thetouch.ae'); a.fill('#lpass', 'secret123'); a.click('#emailUI button')
    a.wait_for_function("typeof ORDERS!=='undefined' && seenOrders!==null", timeout=60000); a.wait_for_timeout(800)
    a.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())")
    a.click('#rail button[data-v=quotes]'); a.wait_for_selector('#qnew')
    check('Quotations screen opens with its four counters', a.locator('.kpi').count() == 4 and a.inner_text('#vtitle') == 'Quotations', a.inner_text('#vtitle'))

    # 2. a company
    a.click('#cnew'); a.fill('#c_name', CO); a.fill('#c_trn', '100123456700003'); a.fill('#c_contact', 'Mariam Al Falasi'); a.fill('#c_phone', '0501112233'); a.fill('#c_email', 'mariam@example.com'); a.fill('#c_address', 'Office 1204, Corniche Tower, Abu Dhabi')
    a.click('#c_ok'); a.wait_for_timeout(700); a.click('#qtabs button[data-t=companies]'); a.wait_for_timeout(300)
    check('company is saved and listed', CO in a.inner_text('#view'))
    a.screenshot(path=out + '/quote-companies.png')

    # 3. a quotation: one catalogue item (price fills in), one free line, discount and delivery
    a.click('#qtabs button[data-t=quotes]'); a.click('#qnew'); a.wait_for_selector('#q_co')
    a.select_option('#q_co', label=CO); a.fill('#q_subject', 'National Day gifts')
    a.fill('.qline:nth-child(1) .nm', P['name']); a.wait_for_timeout(200)
    filled = a.input_value('.qline:nth-child(1) .pr'); unit = a.input_value('.qline:nth-child(1) .un')
    check('picking a product fills its price and unit', abs(float(filled) - float(P['price'])) < 0.001 and unit == ('kg' if P.get('unit') == 'kg' else 'pc'), f'{filled} {unit}')
    a.fill('.qline:nth-child(1) .nn', '2')
    a.click('#q_add'); a.fill('.qline:nth-child(2) .nm', 'Gold ribbon with company logo'); a.fill('.qline:nth-child(2) .nn', '40'); a.fill('.qline:nth-child(2) .pr', '5')
    a.fill('#q_discount', '10'); a.fill('#q_delivery', '25'); a.fill('#q_notes', 'Delivery to the head office reception.')
    want = round(float(P['price']) * 2 + 200 - 10 + 25, 2)
    shown = a.inner_text('#q_sum .g'); check('form total = lines − discount + delivery', f'{want:,.2f}'.rstrip('0').rstrip('.') in shown.replace('AED', '').strip() or f'{want:,.0f}' in shown, f'{shown} / {want}')
    a.screenshot(path=out + '/quote-form.png')
    a.click('#q_send'); a.wait_for_selector('#shu'); link = a.input_value('#shu')
    check('sending gives the company a private link', '/quote/Q' in link and '?k=' in link, link)
    a.screenshot(path=out + '/quote-send.png'); a.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())"); a.wait_for_timeout(500)
    q = [x for x in api('GET', '/api/db/quotes', token=own)[1]['rows'] if x.get('company', {}).get('name') == CO][0]; made['quotes'].append(q['id'])
    check('quotation saved as sent with the right totals', q['status'] == 'sent' and abs(q['total'] - want) < 0.01 and len(q['items']) == 2 and abs(q['subtotal'] - (float(P['price']) * 2 + 200)) < 0.01, json.dumps({k: q[k] for k in ('status', 'subtotal', 'discount', 'delivery', 'total', 'vat')}))
    check('list shows it as awaiting approval', 'awaiting approval' in a.inner_text('#view').lower())

    # 4. the company's page
    no, k = q['no'], q['key']
    check('wrong key shows nothing', api('GET', f'/api/quote/{no}?k=' + 'A' * 22)[0] == 404)
    pub = api('GET', f'/api/quote/{no}?k={k}')[1]
    check('the public summary has no phone, e-mail or key', 'phone' not in json.dumps(pub) and 'example.com' not in json.dumps(pub) and k not in json.dumps(pub), ','.join(pub.keys()))
    c = b.new_context(viewport={'width': 1280, 'height': 900}).new_page(); c.on('pageerror', lambda e: errs.append('company: ' + str(e)[:200]))
    c.goto(link); c.wait_for_selector('#qaGo', timeout=30000)
    txt = c.inner_text('main')
    check('company sees its quotation: name, items, total', CO in txt and 'Gold ribbon with company logo' in txt and 'National Day gifts' in txt and 'Quotation' in txt, txt[:160].replace('\n', ' '))
    c.screenshot(path=out + '/quote-company-page.png', full_page=True)
    c.click('#qaGo'); c.wait_for_timeout(400)
    check('approval needs a name', api('GET', f'/api/quote/{no}?k={k}')[1]['status'] == 'sent')
    c.fill('#qaName', 'Mariam Al Falasi'); c.fill('#qaPo', 'PO-7781'); c.fill('#qaNote', 'Please deliver before 30 November.'); c.click('#qaGo')
    c.wait_for_function("document.querySelector('#qH')&&/approved/i.test(document.querySelector('#qH').textContent)", timeout=30000)
    check('company page says approved', 'Approved by Mariam Al Falasi' in c.inner_text('#qBox'), c.inner_text('#qBox').replace('\n', ' ')[:120])
    c.screenshot(path=out + '/quote-approved.png')
    check('a second answer is refused', api('POST', f'/api/quote/{no}/decline?k={k}', {'reason': 'x'})[0] == 409 and api('POST', f'/api/quote/{no}/approve?k={k}', {'name': 'Someone'})[0] == 409)

    # 5. the admin hears about it and makes the invoice
    a.wait_for_function("QUOTES.some(q=>q.id==='%s'&&q.status==='approved')" % q['id'], timeout=30000); a.wait_for_timeout(400)
    check('admin: approval message and counter on the menu', 'Quotation approved' in a.inner_text('#toast') and a.inner_text('#qDot') == str(a.evaluate("QUOTES.filter(q=>q.status==='approved').length")) and not a.evaluate("document.querySelector('#qDot').classList.contains('hidden')"), a.inner_text('#toast')[:80])
    a.evaluate("openQuote('%s')" % q['id']); a.wait_for_selector('#qo_inv')
    check('quotation shows who approved and the PO', 'Mariam Al Falasi' in a.inner_text('.modal') and 'PO-7781' in a.inner_text('.modal'))
    a.screenshot(path=out + '/quote-open-approved.png')
    a.click('#qo_inv'); a.click('#ay'); a.wait_for_selector('#shu', timeout=30000); inv = a.input_value('#shu')
    check('invoice link is the company\'s order page', '/order/INV' in inv and '?k=' in inv, inv)
    a.screenshot(path=out + '/quote-invoice-send.png'); a.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())"); a.wait_for_timeout(1500)
    q2 = api('GET', '/api/db/quotes/' + q['id'], token=own)[1]; o = api('GET', '/api/db/orders/' + q2.get('orderId', 'x'), token=own)[1]; made['orders'].append(o.get('id'))
    check('invoice order: company, PO, quotation number, same total, confirmed, stock taken', q2['status'] == 'invoiced' and o.get('channel') == 'b2b' and o['company']['name'] == CO and o['po'] == 'PO-7781' and o['quoteNo'] == no and abs(o['total'] - want) < 0.01 and o['status'] == 'confirmed' and o.get('stockApplied') is True, json.dumps({k2: o.get(k2) for k2 in ('channel', 'po', 'quoteNo', 'total', 'status', 'stockApplied')}))
    used = 2 if P.get('unit') == 'kg' else 2
    check('stock went down by the quoted quantity', abs((stock0 or 0) - used - (api('GET', '/api/db/products/' + P['id'], token=own)[1].get('stock') or 0)) < 0.001, f"{stock0} → {api('GET', '/api/db/products/' + P['id'], token=own)[1].get('stock')}")

    # 6. the company's invoice page: invoice with its details, card payment, then the receipt
    c.goto(inv); c.wait_for_selector('#invc', timeout=30000); c.wait_for_selector('#payNow', timeout=30000)
    it = c.inner_text('#invc')
    check('invoice shows the company, TRN, PO and quotation number', CO in it and '100123456700003' in it and 'PO-7781' in it and no in it and 'Invoice' in it, it[:200].replace('\n', ' '))
    c.screenshot(path=out + '/quote-invoice-page.png', full_page=True)
    c.click('#payNow'); c.wait_for_url(lambda u: 'paid=1' in u, timeout=40000); c.wait_for_function("/Payment received/.test((document.querySelector('#payBox')||{}).textContent||'')", timeout=30000)
    c.wait_for_selector('#rcPrint', timeout=30000)   # the order itself arrives a moment after the payment is confirmed
    check('paid by card: page confirms and offers the receipt', c.locator('#rcPrint').count() == 1 and 'paid' in c.inner_text('#invc').lower(), c.inner_text('#invc')[-200:].replace('\n', ' '))
    c.evaluate("window.print=()=>{}"); c.click('#rcPrint'); c.wait_for_timeout(300); rtxt = c.inner_text('#invc')   # the page swaps in the receipt version for printing
    check('receipt version: "Receipt", received from the company, amount, method', 'Receipt' in rtxt and 'received from' in rtxt.lower() and 'amount received' in rtxt.lower() and CO in rtxt, rtxt[:160].replace('\n', ' '))
    c.screenshot(path=out + '/quote-receipt.png', full_page=True)
    c.goto(link); c.wait_for_selector('#qBox .btn', timeout=30000)
    check('quotation page now leads to the paid invoice and receipt', 'receipt' in c.inner_text('#qBox').lower() and '/order/INV' in c.get_attribute('#qBox .btn', 'href'), c.inner_text('#qBox').replace('\n', ' ')[:120])

    # 7. admin after payment
    a.wait_for_function("ORDERS.some(o=>o.id==='%s'&&o.payment.paid)" % o['id'], timeout=30000); a.wait_for_timeout(500)
    a.evaluate("go('quotes')"); a.wait_for_timeout(400)
    check('admin list shows the invoice as paid', 'Invoice paid' in a.inner_text('#view'))
    a.screenshot(path=out + '/quote-list.png')
    a.evaluate("openOrder('%s')" % o['id']); a.wait_for_selector('[data-rca4]')
    check('order window: company row, Invoice A4 and Receipt A4', 'Company invoice' in a.inner_text('.modal') and CO in a.inner_text('.modal') and a.locator('[data-inva4]').count() == 1)
    r4 = a.evaluate("invoiceA4(ORDERS.find(o=>o.id==='%s'),true)" % o['id']); i4 = a.evaluate("invoiceA4(ORDERS.find(o=>o.id==='%s'))" % o['id']); q4 = a.evaluate("quoteA4(QUOTES.find(q=>q.id==='%s'))" % q['id'])
    check('A4 documents: receipt, invoice with company block, quotation', 'Receipt' in r4 and 'Amount received' in r4 and 'Received from' in r4 and 'Billed to' in i4 and CO in i4 and 'PO-7781' in i4 and 'Quotation' in q4 and 'Prepared for' in q4)
    a.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())")

    # 8. decline and expiry (documents written by the owner, answered through the public link)
    base = {k2: q[k2] for k2 in ('company', 'items', 'subtotal', 'discount', 'delivery', 'total', 'vat', 'fulfil', 'terms')}
    for tag, valid in (('D', '2099-01-01'), ('E', '2020-01-01')):
        d = dict(base, id='q_t' + tag + T, no='Q-T' + tag + T, key=(tag * 22), status='sent', created=int(time.time() * 1000), validUntil=valid, subject='', notes='', date='')
        api('PUT', '/api/db/quotes/' + d['id'], d, own); made['quotes'].append(d['id'])
    check('declining records the reason', api('POST', f'/api/quote/Q-TD{T}/decline?k=' + 'D' * 22, {'reason': 'Budget changed'})[0] == 200 and api('GET', '/api/db/quotes/q_tD' + T, token=own)[1].get('declined', {}).get('reason') == 'Budget changed' and api('GET', f'/api/quote/Q-TD{T}?k=' + 'D' * 22)[1]['status'] == 'declined')
    check('an expired quotation shows as expired and cannot be approved', api('GET', f'/api/quote/Q-TE{T}?k=' + 'E' * 22)[1].get('status') == 'expired' and api('POST', f'/api/quote/Q-TE{T}/approve?k=' + 'E' * 22, {'name': 'Late Person'})[0] == 409)
    dr = dict(base, id='q_tR' + T, no='Q-TR' + T, key='R' * 22, status='draft', created=int(time.time() * 1000), validUntil='2099-01-01'); api('PUT', '/api/db/quotes/' + dr['id'], dr, own); made['quotes'].append(dr['id'])
    check('a draft is not visible through its link', api('GET', f'/api/quote/Q-TR{T}?k=' + 'R' * 22)[0] == 404)

    # 9. phone width + Arabic do not break the screen
    m = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True).new_page(); m.on('pageerror', lambda e: errs.append('phone: ' + str(e)[:200]))
    m.goto(link); m.wait_for_selector('#invc', timeout=30000); m.wait_for_timeout(600)
    check('company page on a phone: no sideways scroll', m.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"), str(m.evaluate("[document.documentElement.scrollWidth,window.innerWidth]")))
    m.screenshot(path=out + '/quote-company-phone.png', full_page=True)
    check('no JS errors', not errs, '; '.join(errs)[:400])
    b.close()

# tidy the test database
for i in made['orders']:
    if i: api('DELETE', '/api/db/orders/' + i, token=own)
for i in made['quotes']: api('DELETE', '/api/db/quotes/' + i, token=own)
for c2 in api('GET', '/api/db/companies', token=own)[1].get('rows', []):
    if c2.get('name') == CO: api('DELETE', '/api/db/companies/' + c2['id'], token=own)
if stock0 is not None: api('PATCH', '/api/db/products/' + P['id'], {'stock': stock0}, own)
print('ALL PASS' if ok else 'SOME FAILED')
