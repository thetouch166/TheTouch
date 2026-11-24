# Website structure managed from the admin: occasions (menu, pages, products), About, Contact form, header and checkout.
# Needs the local live-mode server (`npx wrangler pages dev --port 8788`, test database).   Run: python tests/site_test.py <folder for screenshots>
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
T = str(int(time.time()))[-5:]; NAME = 'Graduation ' + T
s0 = api('GET', '/api/db/settings/main', token=own)[1]; occ0 = s0.get('occasions')
prods = [p for p in api('GET', '/api/db/products', token=own)[1]['rows'] if p.get('active') is not False and p.get('web') is not False]
keep = {p['id']: p.get('occasions') for p in prods}

with sync_playwright() as pw:
    b = pw.chromium.launch(); errs = []
    a = b.new_context(viewport={'width': 1366, 'height': 900}).new_page(); a.on('pageerror', lambda e: errs.append('admin: ' + str(e)[:200]))
    a.goto(B + '/admin.html'); a.wait_for_selector('#lemail'); a.fill('#lemail', 'owner@thetouch.ae'); a.fill('#lpass', 'secret123'); a.click('#emailUI button')
    a.wait_for_function("typeof ORDERS!=='undefined' && seenOrders!==null", timeout=60000); a.wait_for_timeout(800)
    a.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())")

    # 1. the owner adds an occasion, hides another, and chooses its products
    a.evaluate("go('products')"); a.wait_for_selector('#pocc'); a.click('#pocc'); a.wait_for_selector('.ocrow')
    n0 = a.locator('.ocrow').count(); check('occasions manager lists the occasions', n0 >= 4, str(n0))
    a.click('#oc_add'); a.fill('.ocrow:last-child .nm', NAME); a.fill('.ocrow:last-child .ar', 'تخرج')
    hidden = a.input_value('.ocrow:nth-child(2) .nm'); a.uncheck('.ocrow:nth-child(2) .on')
    a.click('.ocrow:last-child .up'); a.wait_for_timeout(200)   # move the new one up one place
    a.click('#oc_save'); a.wait_for_timeout(1500)
    s1 = api('GET', '/api/db/settings/main', token=own)[1]; mine = [o for o in s1.get('occasions', []) if o['name'] == NAME]
    check('saved: new occasion with an id, moved up, one hidden', len(mine) == 1 and mine[0]['id'].startswith('graduation') and s1['occasions'][-1]['name'] != NAME and [o for o in s1['occasions'] if o['name'] == hidden][0]['on'] is False, json.dumps([(o['id'], o['on']) for o in s1.get('occasions', [])]))
    oid = mine[0]['id'] if mine else 'x'
    a.click(f'.ocrow:has(.nm[value="{NAME}"]) .pr'); a.wait_for_selector('.oprow')
    a.check(f'.oprow input[data-p="{prods[0]["id"]}"]'); a.check(f'.oprow input[data-p="{prods[1]["id"]}"]'); a.screenshot(path=out + '/site-occasion-products.png'); a.click('#op_save'); a.wait_for_timeout(1800)
    check('products chosen for the occasion are saved on the products', all(oid in (api('GET', '/api/db/products/' + prods[i]['id'], token=own)[1].get('occasions') or []) for i in (0, 1)))
    a.screenshot(path=out + '/site-occasions-admin.png'); a.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())"); a.wait_for_timeout(300)
    # the same from a product
    a.evaluate("productModal(PRODUCTS.find(p=>p.id==='%s'))" % prods[2]['id']); a.wait_for_selector('#f_occ .chip')
    a.click(f'#f_occ .chip[data-o="{oid}"]'); a.click('#psave'); a.wait_for_timeout(1500)
    check('ticking an occasion on a product saves it', oid in (api('GET', '/api/db/products/' + prods[2]['id'], token=own)[1].get('occasions') or []))

    # 2. the website follows
    w = b.new_context(viewport={'width': 1440, 'height': 900}).new_page(); w.on('pageerror', lambda e: errs.append('web: ' + str(e)[:200]))
    w.goto(B + '/'); w.wait_for_selector('#nav .nd'); w.wait_for_timeout(1500)
    nav = w.evaluate("[...document.querySelectorAll('#nav > a, #nav .nd > a, #nav2 > a')].map(a=>a.textContent.trim()).filter(t=>t!=='Make your own')")
    check('header: Home, Shop, Occasions, About, Contact', nav == ['Home', 'Shop', 'Occasions', 'About', 'Contact'], str(nav))
    menu = w.evaluate("[...document.querySelectorAll('#nav .nd:nth-of-type(2) .ndp a:not(.all)')].map(a=>a.firstChild.textContent.trim())")
    check('Occasions menu: the new one is there, the hidden one is not', NAME in menu and hidden not in menu, str(menu))
    check('home page shows the occasions', w.locator('.occs .occ').count() >= 3 and NAME in w.inner_text('.occs'))
    check('home page tells the story under the occasions', w.locator('.hocc + .hstory .st span').count() >= 8 and w.locator('.hstory a[href="/about"]').count() == 1)
    w.hover('#nav .nd >> nth=1'); w.wait_for_timeout(500); w.click(f'#nav .ndp a[href="/occasion/{oid}"]'); w.wait_for_selector('.phead h1'); w.wait_for_timeout(600)
    check('occasion page lists exactly its products', w.inner_text('.phead h1') == NAME and w.locator('.grid .card').count() == 3 and NAME in w.title(), f"{w.locator('.grid .card').count()} · {w.title()}")
    w.screenshot(path=out + '/site-occasion-page.png')
    hid = [o for o in s1['occasions'] if o['name'] == hidden][0]['id']
    w.goto(B + '/occasion/' + hid)
    try: w.wait_for_url(lambda u: u.rstrip('/').endswith('/occasions'), timeout=20000)   # the page starts, reads the settings, then leaves
    except Exception: pass
    check('a hidden occasion is not reachable', w.url.rstrip('/').endswith('/occasions'), w.url)
    st, html = urllib.request.urlopen(B + '/occasion/' + oid).status, urllib.request.urlopen(B + '/occasion/' + oid).read().decode()
    check('server gives the occasion page its own title', st == 200 and f'<title>{NAME} Chocolate Gifts' in html)
    check('sitemap lists the new pages', all(x in urllib.request.urlopen(B + '/sitemap.xml').read().decode() for x in ('/about<', '/contact<', '/occasions<', '/occasion/' + oid + '<')))

    # 3. about + contact
    w.goto(B + '/story'); w.wait_for_selector('.ab-cover'); check('About page (old /story address too) with the chapters of the company profile', w.locator('.ab > section').count() >= 10 and 'About' in w.title(), str(w.locator('.ab > section').count()))
    w.goto(B + '/contact'); w.wait_for_selector('#ctf'); w.click('#ctSend'); w.wait_for_timeout(300)
    check('contact form asks for name, mobile and message', w.locator('#ctf .fld.err').count() == 3)
    w.fill('#ct_name', 'Layla Test ' + T); w.fill('#ct_phone', '0501234567'); w.fill('#ct_email', 'layla@example.com'); w.select_option('#ct_about', 'Gifts for a company'); w.fill('#ct_msg', 'We need 60 boxes for our team.')
    w.screenshot(path=out + '/site-contact.png', full_page=True); w.click('#ctSend'); w.wait_for_selector('#ctf .done', timeout=20000)
    enq = [e for e in api('GET', '/api/db/enquiries', token=own)[1]['rows'] if e.get('name') == 'Layla Test ' + T]
    check('message is saved for the boutique', len(enq) == 1 and enq[0]['type'] == 'Message · Gifts for a company' and enq[0]['email'] == 'layla@example.com' and enq[0]['status'] == 'new', json.dumps(enq[:1])[:200])
    a.wait_for_function("ENQ.some(e=>e.name==='Layla Test %s')" % T, timeout=30000); a.evaluate("go('events')"); a.wait_for_timeout(500)
    check('admin lists the message with its text and email', 'Layla Test ' + T in a.inner_text('#view') and 'We need 60 boxes' in a.inner_text('#view') and 'layla@example.com' in a.inner_text('#view') and a.inner_text('#vtitle') == 'Enquiries & Messages')

    a.evaluate("document.querySelectorAll('#modalRoot [data-close]').forEach(b=>b.click());go('products')"); a.wait_for_selector('#psum'); a.wait_for_timeout(500)
    check('admin shows how many kg are in the shop, and for the list on screen', a.locator('#pkpi .kpi').count() == 5 and 'kg' in a.inner_text('#pkpi') and 'In this list' in a.inner_text('#psum') and 'kg' in a.inner_text('#psum'), a.inner_text('#psum'))

    # 4. checkout still works and has its new summary
    w.goto(B + '/p/' + prods[0]['id']); w.wait_for_timeout(1200); w.click('#add'); w.wait_for_timeout(400); w.goto(B + '/checkout'); w.wait_for_selector('#place')
    check('checkout: heading, summary with trust notes, both hand-over choices', w.inner_text('.cohead h1') == 'Checkout' and w.locator('.cotrust li').count() == 3 and w.locator('#mode button').count() == 2 and 'AED' in w.inner_text('#sumTot'))
    w.click('#mode button[data-m=pickup]'); w.wait_for_timeout(200); check('pick-up removes the delivery fee', 'Complimentary' in w.inner_text('#sumTot'))
    w.screenshot(path=out + '/site-checkout.png', full_page=True)
    m = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True).new_page(); m.on('pageerror', lambda e: errs.append('phone: ' + str(e)[:200]))
    m.goto(B + '/'); m.wait_for_timeout(1800); m.click('.burger'); m.wait_for_timeout(500)
    check('phone menu has the occasions and the new pages', all(x.lower() in m.inner_text('#menu').lower() for x in (NAME, 'Contact', 'About', 'Shop by occasion')), m.inner_text('#menu')[:160].replace('\n', ' '))
    m.screenshot(path=out + '/site-phone-menu.png')
    check('no JS errors', not errs, '; '.join(errs)[:400])
    b.close()

# tidy the test database
api('PATCH', '/api/db/settings/main', {'occasions': occ0 if occ0 is not None else []}, own)
if occ0 is None:
    s = api('GET', '/api/db/settings/main', token=own)[1]; s.pop('occasions', None); api('PUT', '/api/db/settings/main', s, own)
for pid, o in keep.items():
    cur = api('GET', '/api/db/products/' + pid, token=own)[1]
    if cur.get('occasions') != o: api('PATCH', '/api/db/products/' + pid, {'occasions': o or []}, own)
for e in api('GET', '/api/db/enquiries', token=own)[1].get('rows', []):
    if str(e.get('name', '')).startswith('Layla Test '): api('DELETE', '/api/db/enquiries/' + e['id'], token=own)
print('ALL PASS' if ok else 'SOME FAILED')
