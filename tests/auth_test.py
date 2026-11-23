# Local test of staff accounts and roles (owner / cashier). Needs `npx wrangler pages dev --port 8788` with the TEST database
# and STAFF_LOGINS="owner@thetouch.ae:secret123" in .dev.vars.   Run: python tests/auth_test.py <folder for screenshots>
import sys, json, urllib.request
from playwright.sync_api import sync_playwright
B, out = 'http://127.0.0.1:8788', (sys.argv[1] if len(sys.argv) > 1 else '.')
ok = True
def check(name, cond, extra=''):
    global ok; ok = ok and bool(cond); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra != '' else ''))
def api(method, path, body=None, token=None, raw=None, ctype='application/json'):
    req = urllib.request.Request(B + path, method=method, data=raw if raw is not None else (json.dumps(body).encode() if body is not None else None))
    req.add_header('Content-Type', ctype)
    if token: req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=40) as r: return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or '{}')
        except Exception: return e.code, {}
EMAIL = 'samia.test@example.com'
st, r = api('POST', '/api/login', {'email': 'owner@thetouch.ae', 'pass': 'secret123'}); own = r.get('token')
check('developer owner login still works', st == 200 and r.get('role') == 'owner')
for u in api('GET', '/api/staff', token=own)[1].get('rows', []):   # clean up an earlier run
    if u.get('email') in (EMAIL, 'second.owner@example.com'): api('DELETE', '/api/staff/' + u['id'], token=own)

check('staff list needs a login', api('GET', '/api/staff')[0] == 401)
check('weak password is refused', api('POST', '/api/staff', {'email': EMAIL, 'name': 'Samia', 'role': 'cashier', 'pass': 'short1'}, own)[0] == 400 and api('POST', '/api/staff', {'email': EMAIL, 'role': 'cashier', 'pass': 'password1'}, own)[0] == 400)
st, r = api('POST', '/api/staff', {'email': EMAIL, 'name': 'Samia', 'role': 'cashier', 'pass': 'Cashier-2026x'}, own); cid = r.get('id')
check('owner creates a cashier', st == 200 and cid)
check('same email twice is refused', api('POST', '/api/staff', {'email': EMAIL, 'role': 'cashier', 'pass': 'Cashier-2026y'}, own)[0] == 409)
rows = api('GET', '/api/staff', token=own)[1]['rows']; mine = [u for u in rows if u.get('email') == EMAIL][0]
check('list shows the person, never a password or hash', mine['role'] == 'cashier' and not any(k in mine for k in ('hash', 'salt', 'pass')) and any(u.get('fixed') for u in rows), json.dumps(mine))
check('staff accounts are not readable through /api/db', api('GET', '/api/db/staff', token=own)[0] == 404)

check('wrong password is refused', api('POST', '/api/login', {'email': EMAIL, 'pass': 'nope-12345'})[0] == 401)
st, r = api('POST', '/api/login', {'email': EMAIL, 'pass': 'Cashier-2026x'}); cash = r.get('token')
check('cashier signs in with the role "cashier"', st == 200 and r.get('role') == 'cashier' and api('GET', '/api/me', token=cash)[1].get('role') == 'cashier')

# what a cashier may and may not do
prod = api('GET', '/api/db/products', token=cash)[1]['rows'][0]; pid = prod['id']
check('cashier reads products and orders', api('GET', '/api/db/orders', token=cash)[0] == 200)
check('cashier cannot change settings', api('PATCH', '/api/db/settings/main', {'storeName': 'Hacked'}, cash)[0] == 403 and api('PUT', '/api/db/settings/main', {'storeName': 'Hacked'}, cash)[0] == 403)
check('cashier cannot change a price or a product', api('PATCH', '/api/db/products/' + pid, {'price': 1}, cash)[0] == 403 and api('PUT', '/api/db/products/' + pid, dict(prod, price=1), cash)[0] == 403)
check('cashier cannot delete a product or an order', api('DELETE', '/api/db/products/' + pid, token=cash)[0] == 403 and api('DELETE', '/api/db/orders/o_none', token=cash)[0] == 403)
check('cashier cannot read the newsletter list, staff, or send test mail', api('GET', '/api/db/subscribers', token=cash)[0] == 403 and api('GET', '/api/staff', token=cash)[0] == 403 and api('POST', '/api/mailtest', token=cash)[0] == 403)
check('cashier cannot create staff or upload photos', api('POST', '/api/staff', {'email': 'x@example.com', 'role': 'owner', 'pass': 'Whatever-123'}, cash)[0] == 403 and api('POST', '/api/upload', token=cash, raw=b'x', ctype='image/jpeg')[0] == 403)
check('cashier can count stock (stock only)', api('PATCH', '/api/db/products/' + pid, {'stock': prod.get('stock', 1)}, cash)[0] == 200 and api('POST', '/api/db/products/' + pid + '/inc', {'field': 'stock', 'delta': 0}, cash)[0] == 200)
check('cashier cannot use "inc" on a price', api('POST', '/api/db/products/' + pid + '/inc', {'field': 'price', 'delta': -100}, cash)[0] == 403)
o = {'id': 'o_authtest1', 'no': 'S-AUTHTEST', 'channel': 'pos', 'status': 'completed', 'created': 1, 'items': [], 'total': 0, 'payment': {'method': 'cash', 'paid': True}}
check('cashier can record and update a sale', api('PUT', '/api/db/orders/o_authtest1', o, cash)[0] == 200 and api('PATCH', '/api/db/orders/o_authtest1', {'notes': 'x'}, cash)[0] == 200)
check('settings were not changed', api('GET', '/api/db/settings/main', token=own)[1].get('storeName') != 'Hacked')
api('DELETE', '/api/db/orders/o_authtest1', token=own)

# password change
check('change password needs the current one', api('POST', '/api/password', {'old': 'wrong', 'pass': 'Brand-New-2026'}, cash)[0] == 400)
st, r = api('POST', '/api/password', {'old': 'Cashier-2026x', 'pass': 'Brand-New-2026'}, cash); cash2 = r.get('token')
check('cashier changes her own password', st == 200 and cash2)
check('the old session is signed out, the new one works', api('GET', '/api/me', token=cash)[0] == 401 and api('GET', '/api/me', token=cash2)[0] == 200)
check('old password no longer works, new one does', api('POST', '/api/login', {'email': EMAIL, 'pass': 'Cashier-2026x'})[0] == 401 and api('POST', '/api/login', {'email': EMAIL, 'pass': 'Brand-New-2026'})[0] == 200)
check('developer login cannot be changed from the admin', api('POST', '/api/password', {'old': 'secret123', 'pass': 'Brand-New-2026'}, own)[0] == 400)

# owner account made in the admin + removal
st, r = api('POST', '/api/staff', {'email': 'second.owner@example.com', 'name': 'Owner Two', 'role': 'owner', 'pass': 'Owner-Two-2026'}, own); oid = r.get('id')
o2 = api('POST', '/api/login', {'email': 'second.owner@example.com', 'pass': 'Owner-Two-2026'})[1].get('token')
check('an owner made in the admin has full access', api('PATCH', '/api/db/settings/main', {'updatedTest': 1}, o2)[0] == 200 and api('GET', '/api/staff', token=o2)[0] == 200)
check('an owner cannot remove or demote herself', api('DELETE', '/api/staff/' + oid, token=o2)[0] == 400 and api('POST', '/api/staff', {'id': oid, 'email': 'second.owner@example.com', 'role': 'cashier'}, o2)[0] == 400)
check('owner resets the cashier password', api('POST', '/api/staff', {'id': cid, 'email': EMAIL, 'name': 'Samia', 'role': 'cashier', 'pass': 'Reset-By-Owner-9'}, own)[0] == 200 and api('GET', '/api/me', token=cash2)[0] == 401 and api('POST', '/api/login', {'email': EMAIL, 'pass': 'Reset-By-Owner-9'})[0] == 200)
cash3 = api('POST', '/api/login', {'email': EMAIL, 'pass': 'Reset-By-Owner-9'})[1].get('token')
check('removing a person signs her out at once', api('DELETE', '/api/staff/' + cid, token=own)[0] == 200 and api('GET', '/api/me', token=cash3)[0] == 401 and api('POST', '/api/login', {'email': EMAIL, 'pass': 'Reset-By-Owner-9'})[0] == 401)
api('DELETE', '/api/staff/' + oid, token=own)

# the screens
with sync_playwright() as pw:
    b = pw.chromium.launch(); errs = []
    ctx = b.new_context(viewport={'width': 1180, 'height': 820}); pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(B + '/admin.html'); pg.wait_for_timeout(1500)
    pg.check('#lshow'); check('"Show password" reveals the field', pg.get_attribute('#lpass', 'type') == 'text'); pg.uncheck('#lshow')
    pg.fill('#lemail', 'owner@thetouch.ae'); pg.fill('#lpass', 'secret123'); pg.click('#emailUI button'); pg.wait_for_timeout(3500)
    pg.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())"); pg.evaluate("go('settings')"); pg.wait_for_selector('#staffBox table', timeout=20000)
    check('owner sees the staff list in Settings', pg.locator('#staffBox table tbody tr').count() >= 1 and pg.locator('#sadd').count() == 1 and not pg.evaluate("document.body.classList.contains('cashier')"))
    pg.click('#sadd'); pg.wait_for_timeout(400); pg.fill('#s_name', 'Samia'); pg.fill('#s_email', EMAIL); pg.click('#s_gen'); pw_gen = pg.input_value('#s_pass')
    pg.screenshot(path=out + '/staff-modal.png'); pg.click('#s_save'); pg.wait_for_selector('#s_save', state='detached', timeout=20000); pg.wait_for_selector('#staffBox tbody tr:has-text("' + EMAIL + '")', timeout=20000)
    check('owner adds a cashier from the screen', pg.locator('#staffBox tbody tr', has_text=EMAIL).count() == 1 and len(pw_gen) >= 12, pw_gen[:6] + '…')
    pg.screenshot(path=out + '/staff-settings.png', full_page=True)
    c = b.new_context(viewport={'width': 1180, 'height': 820}).new_page(); c.on('pageerror', lambda e: errs.append(str(e)))
    c.goto(B + '/admin.html'); c.wait_for_timeout(1500); c.fill('#lemail', EMAIL); c.fill('#lpass', pw_gen); c.click('#emailUI button'); c.wait_for_timeout(3500)
    c.evaluate("document.querySelectorAll('.modal [data-close]').forEach(b=>b.click())")
    vis = c.evaluate("[...document.querySelectorAll('#rail button[data-v]')].filter(b=>getComputedStyle(b).display!=='none').map(b=>b.dataset.v)")
    check('cashier does not see Reports or Clients', c.evaluate("document.body.classList.contains('cashier')") and 'reports' not in vis and 'customers' not in vis and 'pos' in vis, ','.join(vis))
    c.evaluate("go('reports')"); c.wait_for_timeout(500); check('cashier cannot open Reports another way', c.evaluate("VIEW") == 'pos')
    c.evaluate("go('products')"); c.wait_for_timeout(900)
    check('cashier sees stock but no Edit / Add / on-sale switch', c.locator('#ptable tbody tr').count() > 0 and c.evaluate("[...document.querySelectorAll('[data-ed],#padd,#ptable .switch')].every(e=>getComputedStyle(e).display==='none')") and c.evaluate("[...document.querySelectorAll('#ptable .sv')].some(e=>getComputedStyle(e).display!=='none')"))
    c.evaluate("go('settings')"); c.wait_for_selector('#spw', timeout=20000)
    shown = c.evaluate("[...document.querySelectorAll('#view .card h4')].filter(h=>getComputedStyle(h.parentElement).display!=='none').map(h=>h.childNodes[0].textContent.trim())")
    check('cashier Settings: only Display, New-order alert and Security, with "Change my password"', shown == ['Display', 'New-order alert', 'Security'] and c.locator('#spw').count() == 1 and c.locator('#sadd').count() == 0, ','.join(shown))
    c.screenshot(path=out + '/cashier-settings.png')
    c.click('#spw'); c.wait_for_timeout(400); c.fill('#p_old', pw_gen); c.fill('#p_new', 'Samia-New-2026'); c.fill('#p_rep', 'Samia-New-2026'); c.click('#p_save'); c.wait_for_selector('#p_save', state='detached', timeout=20000)
    check('cashier changes her password on the screen and stays signed in', api('POST', '/api/login', {'email': EMAIL, 'pass': 'Samia-New-2026'})[0] == 200 and c.evaluate("fetch('/api/me',{headers:{Authorization:'Bearer '+localStorage.tt_tok}}).then(r=>r.status)") == 200)
    c.evaluate("go('pos')"); c.wait_for_timeout(800); check('cashier POS shows products', c.locator('#tiles .tile[data-id]').count() > 0)
    # owner removes her again (clean up) from the screen
    pg.click('#staffBox [data-su]'); pg.wait_for_timeout(400); pg.click('#s_del'); pg.wait_for_timeout(500)
    pg.click('.modal:last-child .b-bad, .modal:last-child .btn.b-dark >> nth=-1'); pg.wait_for_selector('#s_del', state='detached', timeout=20000); pg.wait_for_timeout(2500)
    check('owner removes the person from the screen', pg.locator('#staffBox tbody tr', has_text=EMAIL).count() == 0)
    check('no JS errors', not errs, '; '.join(errs)[:300])
    b.close()
for u in api('GET', '/api/staff', token=own)[1].get('rows', []):
    if u.get('email') in (EMAIL, 'second.owner@example.com'): api('DELETE', '/api/staff/' + u['id'], token=own)
print('ALL PASS' if ok else 'SOME FAILED')
