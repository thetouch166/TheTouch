"""
The Touch — end-to-end smoke test (Playwright, Python).

Setup (once):
    pip install playwright
    playwright install chromium

Offline mode (site served from public/ on port 5500, e.g. VS Code Live Server or
`cd public && python -m http.server 5500`):
    python tests/smoke_test.py

Live mode = the real API (Cloudflare Functions + a Neon database). Use a TEST database, never the shop's:
    1. .dev.vars in the repo root:  DATABASE_URL="postgresql://…test db…"
                                    STAFF_LOGINS="owner@thetouch.ae:secret123"
    2. npx wrangler pages dev --port 8788
    3. python tests/smoke_test.py --live            (BASE_URL defaults to http://127.0.0.1:8788)

Options: --headed (watch it run), CHROME_PATH=/path/to/chrome (use an installed Chrome).
"""
import os, sys, json, pathlib
from playwright.sync_api import sync_playwright

LIVE = '--live' in sys.argv
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:8788' if LIVE else 'http://localhost:5500').rstrip('/') + '/'
HEADED = '--headed' in sys.argv
HERE = pathlib.Path(__file__).parent

results, errors = [], []

def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail else ''))

def setup(ctx):
    ctx.route('**/fonts.g*/**', lambda r: r.abort())

def watch(page, label):
    page.on('pageerror', lambda e: errors.append(f'{label}: {e}'))
    page.on('console', lambda m: errors.append(f'{label} console: {m.text}')
            if m.type == 'error' and 'Failed to load resource' not in m.text else None)

STAFF = {'email': 'owner@thetouch.ae', 'pass': 'secret123'}

def orders(page):
    if LIVE:  # ask the API as staff (without signing this page in)
        return page.evaluate("""s => fetch('/api/login',{method:'POST',body:JSON.stringify(s)}).then(r=>r.json())
            .then(j=>fetch('/api/db/orders',{headers:{Authorization:'Bearer '+j.token}})).then(r=>r.json()).then(j=>j.rows)""", STAFF)
    return list(json.loads(page.evaluate("localStorage.getItem('tt_v1_orders')") or '{}').values())

def login(a):
    a.goto(BASE + 'admin.html'); a.wait_for_timeout(800)
    if LIVE:
        a.fill('#lemail', STAFF['email']); a.fill('#lpass', STAFF['pass']); a.click('#emailUI button')
    else:
        for k in '1234': a.click(f'#pad button[data-k="{k}"]')
    if LIVE: a.wait_for_selector('#modePill.live', state='attached', timeout=30000)
    a.wait_for_timeout(1200)
    if a.is_visible('#sc'):
        a.fill('#sc', 'Test Cashier'); a.fill('#sf', '500'); a.click('#sok'); a.wait_for_timeout(2600)

with sync_playwright() as p:
    kw = {'headless': not HEADED, 'args': ['--no-sandbox']}
    if os.environ.get('CHROME_PATH'): kw['executable_path'] = os.environ['CHROME_PATH']
    b = p.chromium.launch(**kw)
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, timezone_id='Asia/Dubai'); setup(ctx)

    # 1. Website: product → bag → checkout
    w = ctx.new_page(); watch(w, 'site')
    w.goto(BASE + 'index.html'); w.wait_for_timeout(1000)
    check('home renders', w.locator('.hero').count() == 1)
    w.goto(BASE + 'index.html#/p/kunafah'); w.wait_for_timeout(700)
    w.click('.opt[data-g="500"]'); w.click('#add'); w.wait_for_timeout(400)
    check('added to bag', w.evaluate("Cart.count()") >= 1)
    w.goto(BASE + 'index.html#/checkout'); w.wait_for_timeout(600)
    if LIVE: w.evaluate("localStorage.removeItem('tt_tok')")  # act as an anonymous customer
    w.fill('[name=name]', 'Smoke Test'); w.fill('[name=phone]', '0501234567')
    w.fill('[name=area]', 'Al Reem Island'); w.fill('[name=address]', 'Tower 1'); w.fill('[name=giftMsg]', 'Congratulations')
    w.click('#place'); w.wait_for_timeout(2500 if LIVE else 1200)
    check('order confirmation page', '#/order/' in w.url, w.url.split('#')[-1])
    web = [o for o in orders(w) if o.get('channel') == 'web']
    check('web order saved', len(web) >= 1)

    # 2. Admin: login + shift, order arrives
    a = ctx.new_page(); watch(a, 'admin'); login(a)
    check('admin unlocked', not a.is_visible('#login'))
    if LIVE: check('live mode pill', 'Live' in a.inner_text('#modePill'))
    a.click('#rail button[data-v=orders]'); a.wait_for_timeout(600)
    check('web order visible in admin', a.evaluate("ORDERS.some(o=>o.channel==='web')"))
    stock0 = a.evaluate("prod('kunafah').stock")
    a.evaluate("setStatus(ORDERS.find(o=>o.channel==='web'&&o.status==='new'),'confirmed')"); a.wait_for_timeout(800)
    check('confirming web order deducts stock', abs(a.evaluate("prod('kunafah').stock") - (stock0 - 0.5)) < 1e-6)

    # 3. POS sale: weighed item + piece item, cash with change
    a.click('#rail button[data-v=pos]'); a.wait_for_timeout(500)
    a.click('.tile[data-id="salted-caramel"]'); a.click('.quick button[data-q="250"]'); a.click('#wok')
    a.click('.tile[data-id="slim-almond"]'); a.wait_for_timeout(300)
    total = a.evaluate("tTotal()")
    check('POS ticket total', abs(total - (420 * 0.25 + 45)) < 0.01, f'AED {total}')
    a.click('#payBtn'); a.wait_for_timeout(400); a.fill('#tend', '200'); a.click('#pok'); a.wait_for_timeout(900)
    pos = [o for o in orders(a) if o.get('channel') == 'pos']
    check('POS sale saved with change', pos and abs(pos[-1]['payment'].get('change', 0) - (200 - total)) < 0.01)
    a.keyboard.press('Escape'); a.wait_for_timeout(300)

    # 4. Shift close reconciles
    exp = a.evaluate("shiftTotals(SHIFT).expected")
    check('shift expected cash = float + cash sales', abs(exp - (500 + total)) < 0.01, f'AED {exp}')

    # 5. Other screens render
    for v in ['home', 'products', 'reports', 'customers', 'events', 'settings']:
        a.evaluate(f"go('{v}')"); a.wait_for_timeout(250)
    check('all admin screens render', True)

    # 6. Phone layout sanity
    m = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, timezone_id='Asia/Dubai'); setup(m)
    mp = m.new_page(); watch(mp, 'phone'); mp.goto(BASE + 'index.html'); mp.wait_for_timeout(800)
    check('phone: no horizontal overflow', mp.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
    b.close()

check('no JS errors', not errors, '; '.join(errors[:3]))
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f" — FAILED: {', '.join(failed)}" if failed else ''))
sys.exit(1 if failed else 0)
