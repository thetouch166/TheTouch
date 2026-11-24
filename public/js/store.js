/* THE TOUCH — shared data layer (website + admin + POS)
   Local mode: localStorage (+ live sync between tabs on the same device)
   Live mode : our API at /api (Cloudflare Pages Functions -> Neon Postgres, photos in R2) when js/config.js sets TT_API */
(function () {
  'use strict';

  /* ---------------- Seed catalogue ---------------- */
  // nav = short label for the website menu. The website and POS only show categories that have products on sale.
  const CATS = [
    { id: 'national', name: 'National Day Collection', ar: 'تشكيلة اليوم الوطني', nav: 'National Day' },
    { id: 'pralines', name: 'Pralines & Bonbons', ar: 'برالين', nav: 'Pralines' },
    { id: 'oriental', name: 'Oriental Collection', ar: 'تشكيلة شرقية', nav: 'Oriental' },
    { id: 'bars', name: 'Bars & Slims', ar: 'ألواح', nav: 'Bars & Slims' },
    { id: 'dipped', name: 'Dipped Fruits & Nuts', ar: 'فواكه ومكسرات', nav: 'Fruits & Nuts' },
    { id: 'gifts', name: 'Gifts & Arrangements', ar: 'هدايا وتنسيقات', nav: 'Gifting' }
  ];

  // price = AED. unit 'kg' → sold by weight (online: 250g / 500g / 1kg; POS: enter grams)
  // Opening prices: every product AED 185 per kg — edit them in Admin → Products.
  const P = (id, name, ar, cat, unit, price, desc, extra) => Object.assign({
    id, sku: id.toUpperCase().replace(/-/g, '').slice(0, 8), name, ar, cat, unit, price, desc,
    img: 'img/' + id + '.jpg', stock: unit === 'kg' ? 20 : 40, active: true, featured: false
  }, extra || {});
  const G = (id, name, ar, cat, price, desc, extra) => P(id, name, ar, cat, 'pc', price, desc, Object.assign({ img: 'POS_products/' + id + '.jpg', stock: 10, min: 2 }, extra || {}));

  const SEED = [
    P('salted-caramel', 'Salted Caramel Hazelnut', 'كراميل مملّح بالبندق', 'pralines', 'kg', 185, 'A whole roasted hazelnut wrapped in soft salted caramel and enrobed in milk chocolate, finished with a dusting of cocoa.', { featured: true }),
    P('truffle-rocher', 'Truffle Rocher Hazelnut', 'ترافل روشيه بالبندق', 'pralines', 'kg', 185, 'Crisp roasted nut shell around a velvet hazelnut truffle heart.', { featured: true }),
    P('coconut-pistachio', 'Coconut & Pistachio', 'جوز الهند والفستق الحلبي', 'pralines', 'kg', 185, 'Snow-white coconut ganache with a centre of Aleppo pistachio, in fine milk chocolate.', { featured: true }),
    P('chabelon-hazelnut', 'New Chabelon Hazelnut', 'نيو شابلون بالبندق', 'pralines', 'kg', 185, 'Our signature chabelon praline layered with hazelnut crunch and a whole hazelnut.'),
    P('macadamia', 'Caramelized Macadamia', 'مكاديميا مكرملة', 'pralines', 'kg', 185, 'Buttery macadamia, slowly caramelised and coated in silky milk chocolate.', { featured: true }),
    P('almond-quinball', 'Chopped Almond Quinball', 'كوين بول باللوز المقطّع', 'pralines', 'kg', 185, 'A round praline packed with roasted chopped almonds and gianduja.'),
    P('earth', 'Earth', 'الأرض', 'pralines', 'kg', 185, 'Two textures, one sphere — a crisp wafer disc and a rich cocoa truffle.'),
    P('monte-carlo', 'New Monte Carlo', 'نيو مونتي كارلو', 'pralines', 'kg', 185, 'Individually wrapped squares of milk chocolate with a crunchy nut praline core.'),
    P('coffee-bean', 'Chocolate Coffee Bean', 'شوكولا حبة بن قهوة', 'pralines', 'kg', 185, 'A coffee-bean shaped praline with a smooth espresso ganache.'),
    P('tiramisu', 'Tiramisu', 'تيراميسو', 'pralines', 'kg', 185, 'Mascarpone-style cream and coffee sponge in chocolate, dusted with cocoa.', { featured: true }),
    P('cotton-candy', 'Cotton Candy', 'غزل البنات', 'pralines', 'kg', 185, 'A pyramid of chocolate filled with light, cloud-soft cotton candy cream.'),
    P('cream-biscuit', 'Chocolate Cream Biscuit with Nuts', 'شوكولا مربعة كريم بسكوت كسر', 'pralines', 'kg', 185, 'A square of biscuit cream crowned with caramelised chopped nuts.'),
    P('kunafah', 'Kunafah', 'كنافة', 'oriental', 'kg', 185, 'The beloved Arabic dessert reimagined — crisp kunafah and pistachio cream under a hand-painted chocolate shell.', { featured: true }),
    P('pistachio-halawa', 'Pistachio Halawa Chocolate', 'شوكولا بالحلاوة والفستق الحلبي', 'oriental', 'kg', 185, 'Silky tahini halawa studded with pistachio in a bark-textured milk chocolate log.'),
    P('pistachio-orange', 'Pistachio with Orange Blossom', 'فستق حلبي بماء الزهر', 'oriental', 'kg', 185, 'Pistachio paste scented with orange-blossom water in a fine chocolate bar.', { featured: true }),
    P('snayniyeh', 'Chocolate Round Snayniyeh', 'شوكولا مدورة سنينية', 'oriental', 'kg', 185, 'A round chocolate inspired by the traditional snayniyeh, rich with nuts.'),
    P('madlouka', 'Chocolate Madlouka', 'شوكولا تغطيس مدلوقة', 'oriental', 'kg', 185, 'Layers of creamy madlouka and nuts, topped with crushed pistachio.'),
    P('fig-sesame', 'Chocolate Fig with Sesame, Almond & Walnut', 'شوكولا تغطيس تين مع سمسم لوز وجوز', 'oriental', 'kg', 185, 'Sun-dried fig with toasted sesame, almond and walnut, dipped in chocolate.'),
    P('florentine-pistachio', 'Caramelized Florentine Pistachio', 'فلورنتين بالفستق الحلبي المكرمل', 'oriental', 'kg', 185, 'A dome of caramelised pistachio florentine enrobed in milk chocolate.'),
    P('slim-almond', 'Slim Chopped Almond', 'شوكولا رفيعة باللوز المقطّع', 'bars', 'kg', 185, 'A slim, elegant bar of milk chocolate with fine chopped almonds.', { featured: true }),
    P('chopped-nuts', 'Chopped Nuts Bar', 'مكسرات مقطّعة', 'bars', 'kg', 185, 'Our signature parquet-pattern bar filled with roasted chopped nuts.'),
    P('exotic-chabelon', 'Exotic Chabelon', 'إكزوتيك شابلون', 'bars', 'kg', 185, 'A chocolate disc topped with almonds, hazelnuts, apricot and cranberries.'),
    P('orange-slices', 'Dark Chocolate-Dipped Orange Slices', 'شرائح برتقال مغموسة بالشوكولا الداكنة', 'dipped', 'kg', 185, 'Candied orange slices half-dipped in intense dark chocolate.'),
    P('fruit-nuts', 'Chocolate Fruit & Nuts', 'شوكولا تغطيس كروكان فستق', 'dipped', 'kg', 185, 'Squares crowned with cashew, pistachio, cranberry and apricot.'),
    P('pecan-florentine', 'Pecan & Florentine Pistachio', 'جوز البيكان وفلورنتين بالفستق الحلبي', 'dipped', 'kg', 185, 'Glazed pecans on a pistachio florentine base.'),
    P('gift-bag', 'Signature Gift Bag Arrangement', 'تنسيق حقيبة الهدايا', 'gifts', 'kg', 185, 'A luxurious designer-bag arrangement filled with an assortment of our finest pralines and wrapped chocolates. Customisable colours and ribbons.', { stock: 5, featured: true }),
    P('gift-tray', 'Crystal Tray Arrangement', 'تنسيق صينية كريستال', 'gifts', 'kg', 185, 'An acrylic or crystal tray arranged with 1 kg of assorted pralines, perfect for Eid, weddings and new-baby receptions.', { img: 'img/gift-bag-sign.jpg', stock: 5 }),
    P('box-500', 'Assorted Pralines Box — 500 g', 'علبة برالين مشكلة ٥٠٠ غ', 'gifts', 'kg', 185, 'Our chocolatier\'s selection of signature pralines in a reusable The Touch box.', { img: 'img/banner-coconut.jpg', stock: 20, featured: true }),
    // Grand-opening collection (Nov 2026): fixed-price pieces, in-store photos in POS_products/.
    // For the opening the live shop sells ONLY these; the products above are switched off (Admin → Products → On sale).
    G('nd-flag-box', 'UAE Flag Box — 1,205 g', 'علبة علم الإمارات — ١٢٠٥ غ', 'national', 465, 'Our black keepsake box, foiled in gold with The Touch crest, holding hand-wrapped chocolates laid out as the UAE flag in red, green, white and black. Net weight 1,205 g.'),
    G('nd-wood-bowl', 'National Day Wooden Bowl — 952 g', 'وعاء خشبي لليوم الوطني — ٩٥٢ غ', 'national', 465, 'A hand-turned wooden bowl with rope handles, ringed with green, white and black wrapped chocolates and crowned in red with a UAE flag and a gold emblem. Net weight 952 g.'),
    G('nd-crystal-tray', 'Proud of UAE Crystal Tray — 1,220 g', 'صينية كريستال فخور بالإمارات — ١٢٢٠ غ', 'national', 680, 'A cut-crystal platter of hand-wrapped chocolates in rings of black, white, green and red, finished with a “Proud of UAE” centrepiece and a flag. Net weight 1,220 g.'),
    G('nd-trio-tray', 'National Day Trio Tray — 1,815 g', 'صينية ثلاثية لليوم الوطني — ١٨١٥ غ', 'national', 795, 'A sculpted wooden tray on black hairpin legs, with three compartments of wrapped chocolates in the colours of the flag. Net weight 1,815 g.'),
    G('dragee-jar', 'Chocolate Dragées Jar — 350 g', 'علبة دراجيه بالشوكولاتة — ٣٥٠ غ', 'gifts', 105, 'Roasted almonds and hazelnuts coated in milk or dark chocolate, in a clear keepsake jar with The Touch lid. Net weight 350 g.', { featured: true }),
    G('gold-truffle-tray', 'Golden Truffle Tray — 1,074 g', 'صينية ذهبية بالترافل والمكسرات — ١٠٧٤ غ', 'gifts', 675, 'A cut-crystal bowl wrapped in gold and piled with chocolate truffles and nut-topped squares of almond, cashew and pistachio, finished with white blossoms. Net weight 1,074 g.', { featured: true }),
    G('gold-pecan-tray', 'Golden Pecan Tray — 1,164 g', 'صينية ذهبية بالبيكان — ١١٦٤ غ', 'gifts', 695, 'A cut-crystal bowl wrapped in gold and piled with pecan clusters and milk chocolate truffles, finished with white blossoms. Net weight 1,164 g.', { featured: true }),
    G('signature-box', 'Assorted Signature Box — 1,100 g', 'علبة الشوكولاتة المشكّلة — ١١٠٠ غ', 'gifts', 315, 'Our burgundy keepsake box with nine rows of signature chocolates: truffles, pralines, nut crunch and pistachio squares. Net weight 1,100 g.', { featured: true }),
    G('designer-bag', 'Designer Bag Arrangement — 1,350 g', 'تنسيق حقيبة فاخرة — ١٣٥٠ غ', 'gifts', 635, 'A black patent designer tote filled with gold-wrapped and milk chocolate pralines and finished with blossoms. Net weight 1,350 g.', { featured: true })
  ];

  const DEFAULT_SETTINGS = {
    id: 'main',
    storeName: 'The Touch',
    tagline: 'Where Luxury Finds Its Flavor',
    phone: '+971 52 663 3823',
    whatsapp: '971526633823',
    instagram: 'the.touch.chocolates',
    email: 'hello@thetouchchocolate.com',
    address: 'Abu Dhabi, United Arab Emirates',
    trn: '',
    vatRate: 5,
    currency: 'AED',
    freeDeliveryOver: 300,
    delivery: { 'Abu Dhabi': 25, 'Dubai': 35, 'Sharjah': 40, 'Ajman': 40, 'Umm Al Quwain': 45, 'Ras Al Khaimah': 50, 'Fujairah': 50, 'Al Ain': 35 },
    sameDayCutoff: 14,
    announcement: 'Complimentary delivery across Abu Dhabi on orders above AED 300 · Same-day delivery before 2 PM',
    receiptFooter: 'Thank you for choosing The Touch — Where Luxury Finds Its Flavor',
    pin: '1234',
    onlinePayments: ['cod', 'card_on_delivery', 'link'],
    // company documents (quotation / invoice / receipt). The bank details (settings.bank) are entered in Admin → Settings and
    // stay in the database: they are never part of this file or of the public copy of the settings.
    // shop by occasion (website menu + home page). Managed in Admin → Products → Occasions; a product lists the ids it suits in p.occasions.
    occasions: [
      { id: 'birthday', name: 'Birthday', ar: 'عيد ميلاد', on: true }, { id: 'newborn', name: 'New Born', ar: 'مولود جديد', on: true },
      { id: 'wedding', name: 'Wedding & Engagement', ar: 'زفاف وخطوبة', on: true }, { id: 'thankyou', name: 'Thank You', ar: 'شكراً', on: true },
      { id: 'ramadan', name: 'Ramadan', ar: 'رمضان', on: true }, { id: 'eid', name: 'Eid', ar: 'العيد', on: true },
      { id: 'nationalday', name: 'National Day', ar: 'اليوم الوطني', on: true }, { id: 'christmas', name: 'Christmas', ar: 'عيد الميلاد المجيد', on: true }
    ],
    hours: '', mapUrl: '',   // contact page: opening hours and an optional Google Maps link
    legalName: 'The Touch Planners For Chocolates and Sweets LLC–SPC',
    payTerms: '100% on advance.',
    quoteStart: 1, invoiceStart: 1
  };

  /* ---------------- Utils ---------------- */
  const U = {
    money(n, cur) { n = Number(n) || 0; return (cur || 'AED') + ' ' + n.toLocaleString('en-AE', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); },
    r2(n) { return Math.round((Number(n) || 0) * 100) / 100; },
    uid(p) { return (p || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },
    key() {   // private key of an order's own page (/order/<no>?k=…): only someone holding the link can open it
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; let b;
      try { b = crypto.getRandomValues(new Uint8Array(22)); } catch (e) { b = Array.from({ length: 22 }, () => Math.floor(Math.random() * 256)); }
      return Array.from(b, x => A[x % A.length]).join('');
    },
    orderNo(prefix) {
      const d = new Date(); const pad = n => String(n).padStart(2, '0'); const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      let r = ''; for (let i = 0; i < 5; i++) r += A[Math.floor(Math.random() * A.length)];
      return prefix + String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + r;
    },
    esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
    vatPart(total, rate) { rate = rate == null ? 5 : rate; return U.r2(total - total / (1 + rate / 100)); },
    lineTotal(l) { return Math.max(0, U.r2((l.unit === 'kg' ? l.price * l.grams / 1000 : l.price) * l.qty - (l.disc || 0))); },
    qtyLabel(l) { return l.unit === 'kg' ? (l.grams >= 1000 ? (l.grams / 1000) + ' kg' : l.grams + ' g') : ''; },
    dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
    fmtTime(ts) { return new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); },
    compressImage(file, max) {
      max = max || 700;
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => {
          const im = new Image();
          im.onload = () => {
            const s = Math.min(1, max / Math.max(im.width, im.height));
            const c = document.createElement('canvas'); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
            const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height);
            res(c.toDataURL('image/jpeg', 0.8));
          };
          im.onerror = rej; im.src = fr.result;
        };
        fr.onerror = rej; fr.readAsDataURL(file);
      });
    }
  };

  /* ---------------- Local backend ---------------- */
  const LS = 'tt_v1_';
  const watchers = {};
  const local = {
    mode: 'local',
    _read(col) { try { return JSON.parse(localStorage.getItem(LS + col)) || {}; } catch (e) { return {}; } },
    _write(col, map) {
      try { localStorage.setItem(LS + col, JSON.stringify(map)); }
      catch (e) { alert('Storage is full on this device. Please export a backup (Settings) and remove old data or large images.'); throw e; }
      local._emit(col);
    },
    _emit(col) { (watchers[col] || []).forEach(cb => cb(Object.values(local._read(col)))); },
    async init() {
      window.addEventListener('storage', e => { if (e.key && e.key.indexOf(LS) === 0) local._emit(e.key.slice(LS.length)); });
    },
    async all(col) { return Object.values(local._read(col)); },
    async get(col, id) { return local._read(col)[id] || null; },
    async put(col, obj) { const m = local._read(col); m[obj.id] = obj; local._write(col, m); return obj.id; },
    async patch(col, id, part) { const m = local._read(col); if (!m[id]) return; Object.assign(m[id], part); local._write(col, m); },
    async inc(col, id, field, delta) { const m = local._read(col); if (!m[id]) return; m[id][field] = U.r2((Number(m[id][field]) || 0) + delta); local._write(col, m); },
    async del(col, id) { const m = local._read(col); delete m[id]; local._write(col, m); },
    watch(col, cb) { (watchers[col] = watchers[col] || []).push(cb); local.all(col).then(cb); return () => { watchers[col] = watchers[col].filter(f => f !== cb); }; },
    async upload(dataUrl) { return dataUrl; },   // offline: the photo stays inside the product
    async signIn(pin) { const s = await local.get('settings', 'main'); return pin === ((s && s.pin) || DEFAULT_SETTINGS.pin); },
    async signOut() { },
    isAdmin() { return sessionStorage.getItem('tt_admin') === '1'; }
  };

  /* ---------------- Cloud backend: our API on Cloudflare (/api → Neon database, R2 photos) ----------------
     Same API as local mode. watch() = first full load, then the admin asks every few seconds "what changed
     since…" (paused while the screen is off, to keep the database asleep). The website re-checks products
     once a minute (served from Cloudflare's edge cache). Writes show on this screen immediately. */
  const API = window.TT_API;
  const TOK = 'tt_tok';
  const tok = () => { try { return localStorage.getItem(TOK) || ''; } catch (e) { return ''; } };
  async function req(method, path, body, blob) {
    const h = {}; const t = tok(); if (t) h.Authorization = 'Bearer ' + t;
    let b; if (blob) { b = blob; h['Content-Type'] = blob.type; } else if (body !== undefined) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const r = await fetch(API + path, { method, headers: h, body: b, cache: 'no-store' });
    if (r.status === 401 && t) { try { localStorage.removeItem(TOK); } catch (e) { } }
    if (!r.ok) { let m = ''; try { m = (await r.json()).error || ''; } catch (e) { } const e = new Error(m || method + ' ' + path + ' → ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  const enc = encodeURIComponent;
  const cloud = {
    mode: 'live',
    role: 'owner', me: null,   // who is signed in: { email, role: 'owner' | 'cashier', name, source } — the API enforces the role
    api: (method, path, body) => req(method, path, body),   // staff endpoints: /staff, /password, /mailtest
    setToken(t) { try { localStorage.setItem(TOK, t); } catch (e) { } },
    _c: {}, _timer: 0, _busy: false,
    async init() {
      if (tok()) { try { cloud.me = await req('GET', '/me'); cloud.role = cloud.me.role || 'owner'; } catch (e) { } }   // a stale/removed login is cleared here
      document.addEventListener('visibilitychange', () => { if (!document.hidden) cloud._poll(); });
    },
    async _list(col) { return req('GET', '/db/' + col); },
    async all(col) { return (await cloud._list(col)).rows; },
    async get(col, id) { try { return await req('GET', '/db/' + col + '/' + enc(id)); } catch (e) { if (e.status === 404) return null; throw e; } },
    put(col, obj) { return cloud._write(col, obj.id, () => JSON.parse(JSON.stringify(obj)), () => req('PUT', '/db/' + col + '/' + enc(obj.id), obj)).then(() => obj.id); },
    patch(col, id, part) { return cloud._write(col, id, cur => cur ? Object.assign(cur, JSON.parse(JSON.stringify(part))) : undefined, () => req('PATCH', '/db/' + col + '/' + enc(id), part)); },
    inc(col, id, field, delta) { return cloud._write(col, id, cur => { if (!cur) return; cur[field] = U.r2((Number(cur[field]) || 0) + delta); return cur; }, () => req('POST', '/db/' + col + '/' + enc(id) + '/inc', { field, delta })); },
    del(col, id) { return cloud._write(col, id, () => null, () => req('DELETE', '/db/' + col + '/' + enc(id))); },
    watch(col, cb) {
      let w = cloud._c[col];
      if (!w) {
        w = cloud._c[col] = { raw: {}, cbs: [], ready: false, t: 0 };
        const load = () => cloud._list(col).then(r => { w.raw = {}; r.rows.forEach(d => w.raw[d.id] = JSON.stringify(d)); w.t = r.t; w.ready = true; cloud._emit(col); })
          .catch(e => { console.warn('watch', col, e.message); setTimeout(load, 5000); });
        load();
      }
      w.cbs.push(cb); if (w.ready) cb(Object.values(w.raw).map(s => JSON.parse(s)));
      cloud._loop();
      return () => { w.cbs = w.cbs.filter(f => f !== cb); };
    },
    _emit(col) { const w = cloud._c[col]; w.cbs.forEach(cb => { try { cb(Object.values(w.raw).map(s => JSON.parse(s))); } catch (e) { console.error(e); } }); },
    async _write(col, id, fn, call) {   // show the change here right away, roll back if the server refuses
      const w = cloud._c[col]; const ok = w && w.ready; const before = ok ? w.raw[id] : undefined;
      if (ok) { const next = fn(before ? JSON.parse(before) : null); if (next !== undefined) { if (next === null) delete w.raw[id]; else w.raw[id] = JSON.stringify(next); cloud._emit(col); } }
      try { return await call(); }
      catch (e) { if (ok) { if (before === undefined) delete w.raw[id]; else w.raw[id] = before; cloud._emit(col); } throw e; }
      finally { setTimeout(() => cloud._poll(), 30); }
    },
    _loop() {
      if (cloud._timer) return;
      // screen in front: ask the database every 5 s. Admin in a background tab: ask the light "anything new?" signal every 20 s
      // (no database, so it can sleep) and load the changes only when it moved — new-order alerts keep working.
      const tick = async () => { if (!document.hidden) await cloud._poll(); else if (cloud.isAdmin()) await cloud._ping(); cloud._timer = setTimeout(tick, cloud.isAdmin() ? (document.hidden ? 20000 : 5000) : 60000); };
      cloud._timer = setTimeout(tick, cloud.isAdmin() ? 5000 : 60000);
    },
    async _ping() {
      const cols = Object.keys(cloud._c).filter(c => cloud._c[c].ready); if (!cols.length) return;
      try { const r = await fetch(API + '/ping', { cache: 'no-store' }); const j = await r.json(); if (j && j.t > Math.min(...cols.map(c => cloud._c[c].t))) await cloud._poll(); } catch (e) { }
    },
    async _poll() {
      const cols = Object.keys(cloud._c).filter(c => cloud._c[c].ready); if (!cols.length || cloud._busy) return;
      cloud._busy = true;
      try {
        if (cloud.isAdmin()) {
          const since = Math.min(...cols.map(c => cloud._c[c].t)) - 15000;   // overlap: never miss a slow write
          const r = await req('GET', '/sync?cols=' + cols.join(',') + '&since=' + since); const touched = new Set();
          r.rows.forEach(x => { const w = cloud._c[x.c]; if (!w || !w.ready) return;
            if (x.d === null) { if (w.raw[x.id] !== undefined) { delete w.raw[x.id]; touched.add(x.c); } }
            else { const s = JSON.stringify(x.d); if (w.raw[x.id] !== s) { w.raw[x.id] = s; touched.add(x.c); } } });
          cols.forEach(c => cloud._c[c].t = r.t); touched.forEach(c => cloud._emit(c));
        } else {
          for (const c of cols) { const r = await cloud._list(c); const w = cloud._c[c]; const raw = {}; r.rows.forEach(d => raw[d.id] = JSON.stringify(d));
            if (JSON.stringify(raw) !== JSON.stringify(w.raw)) { w.raw = raw; cloud._emit(c); } }
        }
      } catch (e) { console.warn('sync', e.message); }
      cloud._busy = false;
    },
    async upload(dataUrl) { const blob = await (await fetch(dataUrl)).blob(); return (await req('POST', '/upload', undefined, blob)).url; },
    async signIn(email, pass) {
      cloud.lastError = '';
      try { const r = await req('POST', '/login', { email, pass }); localStorage.setItem(TOK, r.token); cloud.role = r.role || 'owner'; cloud.me = { email: r.email, role: cloud.role }; try { cloud.me = await req('GET', '/me'); } catch (e) { } return true; }
      catch (e) { cloud.lastError = e.message; return false; }
    },
    async signOut() { try { localStorage.removeItem(TOK); } catch (e) { } },
    isAdmin() { return !!tok(); }
  };

  /* ---------------- Public API ---------------- */
  const DB = API ? cloud : local;
  const TT = {
    DB, U, CATS, SEED, DEFAULT_SETTINGS,
    ready: null,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    async boot(opts) {
      opts = opts || {};
      try { await DB.init(); }
      catch (e) { console.error('Backend failed, falling back to local', e); Object.assign(DB, local); DB.mode = 'local'; await local.init(); }
      // settings
      let s = null; try { s = await DB.get('settings', 'main'); } catch (e) { }
      if (!s && (DB.mode === 'local' || opts.admin)) { s = Object.assign({}, DEFAULT_SETTINGS); try { await DB.put('settings', s); } catch (e) { } }
      TT.settings = Object.assign({}, DEFAULT_SETTINGS, s || {});
      // products
      let prods = []; try { prods = await DB.all('products'); } catch (e) { }
      if (!prods.length && (DB.mode === 'local' || opts.admin)) {
        await Promise.all(SEED.map(p => DB.put('products', Object.assign({ updated: Date.now() }, p)).catch(() => { })));   // all at once (fast on a new database)
        prods = SEED.slice();
      }
      if (!prods.length) prods = SEED.slice(); // public fallback
      TT.products = prods;
      return TT;
    },
    /* the occasions shown on the website: cleaned, only those switched on */
    occasions(all) {
      const l = Array.isArray(TT.settings.occasions) ? TT.settings.occasions : [];
      return l.map(o => ({ id: String((o && o.id) || '').replace(/[^a-z0-9-]/g, '').slice(0, 40), name: String((o && o.name) || '').slice(0, 60), ar: String((o && o.ar) || '').slice(0, 60), img: String((o && o.img) || ''), desc: String((o && o.desc) || '').slice(0, 240), on: !o || o.on !== false })).filter(o => o.id && o.name && (all || o.on));
    },
    catName(id) { const c = CATS.find(c => c.id === id); return c ? c.name : id; },
    deliveryFee(emirate, subtotal) {
      const s = TT.settings; const free = Number(s.freeDeliveryOver) > 0 ? Number(s.freeDeliveryOver) : Infinity;
      if (subtotal >= free && emirate === 'Abu Dhabi') return 0;
      return Number((s.delivery || {})[emirate] || 0);
    },
    payLabel(k) { return ({ cash: 'Cash', card: 'Card', split: 'Cash + Card', cod: 'Cash on delivery', card_on_delivery: 'Card on delivery', link: 'Payment link', card_online: 'Card online', paid: 'Paid' })[k] || k; },
    STATUSES: [
      { id: 'new', name: 'New', color: '#cd9754' },
      { id: 'confirmed', name: 'Confirmed', color: '#3b3d50' },
      { id: 'preparing', name: 'Preparing', color: '#9c6036' },
      { id: 'ready', name: 'Ready / Out for delivery', color: '#5b7a4a' },
      { id: 'completed', name: 'Completed', color: '#2f6b3a' },
      { id: 'cancelled', name: 'Cancelled', color: '#8a1c2b' }
    ]
  };
  // Normalise/sanitise orders coming from the database (protects admin from malformed or malicious web orders)
  const METHODS = ['cash', 'card', 'split', 'cod', 'card_on_delivery', 'link', 'card_online'];   // card_online = paid on the website (Stripe)
  const STATUS = ['new', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
  const safeId = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 64);
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  TT.cleanOrder = function (o) {
    o = o || {}; o.id = safeId(o.id); o.no = safeId(o.no) || o.id.slice(-8);
    o.key = /^[A-Za-z0-9]{16,40}$/.test(o.key || '') ? o.key : '';   // key of the customer's order page
    o.channel = o.channel === 'pos' || o.channel === 'b2b' ? o.channel : 'web';   // b2b = a company invoice made from a quotation
    if (o.company && typeof o.company === 'object' && o.company.name) { const c = o.company, t = (v, n) => String(v == null ? '' : v).slice(0, n); o.company = { id: safeId(c.id), name: t(c.name, 200), trn: t(c.trn, 40), address: t(c.address, 400), contact: t(c.contact, 120), phone: t(c.phone, 40), email: t(c.email, 160) }; } else delete o.company;
    o.quoteNo = safeId(o.quoteNo); o.po = String(o.po == null ? '' : o.po).slice(0, 60);
    o.status = STATUS.includes(o.status) ? o.status : 'new';
    o.created = num(o.created) || Date.now();
    o.customer = Object.assign({ name: '', phone: '', email: '' }, o.customer || {});
    o.gift = Object.assign({ to: '', phone: '', msg: '' }, o.gift || {});
    o.fulfil = ['instore', 'pickup', 'delivery'].includes(o.fulfil) ? o.fulfil : (o.channel === 'pos' ? 'instore' : 'delivery');
    o.items = (Array.isArray(o.items) ? o.items : []).slice(0, 100).map(l => {
      const x = { pid: safeId(l && l.pid), name: String((l && l.name) || ''), unit: l && l.unit === 'kg' ? 'kg' : 'pc', price: Math.max(0, num(l && l.price)), grams: Math.max(0, num(l && l.grams)), qty: Math.max(0, Math.round(num(l && l.qty))), disc: Math.max(0, num(l && l.disc)) };
      if (l && l.desc) x.desc = String(l.desc).slice(0, 300); if (l && num(l.orig) > 0) x.orig = num(l.orig);   // company documents: second line and list price before discount
      return x;
    });
    o.terms = String(o.terms == null ? '' : o.terms).slice(0, 3000);
    ['subtotal', 'discount', 'delivery', 'total', 'vat'].forEach(k => o[k] = num(o[k]));
    const p = o.payment = Object.assign({}, o.payment || {});
    p.method = METHODS.includes(p.method) ? p.method : 'cod'; p.paid = p.paid === true;
    ['cash', 'card', 'other', 'tendered', 'change'].forEach(k => { if (p[k] != null) p[k] = num(p[k]) });
    if (o.channel === 'web') { // web totals must match their lines (cannot be trusted)
      const sub = U.r2(o.items.reduce((a, l) => a + U.lineTotal(l), 0));
      if (Math.abs(sub - o.subtotal) > 0.01 || Math.abs(U.r2(sub - o.discount + o.delivery) - o.total) > 0.01) o.tampered = true;
    }
    return o;
  };
  /* ---------- company documents: quotation / invoice / receipt in the boutique's own layout ----------
     One renderer for the admin (print / PDF) and for the company's own pages on the website, so both always look the same.
     d = a quotation or a company order (same line shape); opt.bank = bank details (kept in the settings, never in the
     public copy of them); opt.ref = payment reference when the order's own is not there. */
  const ONES = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const below1000 = n => { let s = ''; if (n >= 100) { s = ONES[Math.floor(n / 100)] + ' Hundred'; n %= 100; if (n) s += ' '; } if (n >= 20) s += TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''); else if (n > 0) s += ONES[n]; return s; };
  U.words = function (amount) {   // 1288 → "One Thousand Two Hundred Eighty-Eight" · 92.5 → "Ninety-Two and Fifty Fils"
    const cents = Math.round((Number(amount) || 0) * 100); let n = Math.floor(cents / 100); const fils = cents % 100, parts = [], big = ['', ' Thousand', ' Million', ' Billion'];
    if (!n) parts.push('Zero');
    for (let i = 0; n > 0; i++) { const c = n % 1000; if (c) parts.unshift(below1000(c) + big[i]); n = Math.floor(n / 1000); }
    return parts.join(' ') + (fils ? ' and ' + below1000(fils) + ' Fils' : '');
  };
  U.dmy = function (t) {   // 23/11/2026 from a time or a yyyy-mm-dd date
    if (typeof t === 'string' && /^\d{4}-\d\d-\d\d$/.test(t)) { const p = t.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
    const d = new Date(Number(t) || Date.now()), p = n => String(n).padStart(2, '0'); return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
  };
  U.f2 = n => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  TT.DOC_CSS = `
.tdoc{position:relative;background:#fff;color:#161616;font-family:Montserrat,'Segoe UI',Arial,sans-serif;font-size:13px;line-height:1.5;border:1px solid #1c1c1c;padding:0 0 24px;margin:44px auto 0;text-align:left;font-variant-numeric:lining-nums;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.tdoc,.tdoc *{box-sizing:border-box}
.tdoc .tdh{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:22px 40px 14px 34px;border-bottom:2.5px solid #1c1c1c}
.tdoc .tdco{text-align:center;max-width:312px}
.tdoc .tdco b{display:block;font-size:17px;font-weight:700;line-height:1.4;margin-bottom:9px;color:#111}
.tdoc .tdco span{display:block;font-size:13.5px;color:#222}
.tdoc .tdh img{height:84px;width:auto;flex:none}
.tdoc h2{font:700 19px/1.3 Montserrat,'Segoe UI',Arial,sans-serif;text-align:center;text-decoration:underline;text-underline-offset:4px;margin:22px 0 16px;color:#111;letter-spacing:0;text-transform:none}
.tdoc .tdstamp{position:absolute;right:44px;top:138px;border:2px solid #2f6b3a;color:#2f6b3a;font-weight:700;letter-spacing:.22em;padding:5px 14px 5px 17px;font-size:13px;transform:rotate(-6deg);border-radius:4px;background:rgba(255,255,255,.85)}
.tdoc .tdm{display:grid;grid-template-columns:1.05fr 1fr;gap:24px;padding:0 40px 20px 74px}
.tdoc .tdm p{margin:0 0 8px;font-size:14px;color:#161616}.tdoc .tdm p.tds{font-size:11.5px;color:#333}.tdoc .tdm b{font-weight:700}
.tdoc table{width:calc(100% - 8px);margin:0 4px;border-collapse:collapse;font-size:13.5px;table-layout:fixed}
.tdoc th{background:#5a392b;color:#fff;font-weight:700;padding:11px 6px;border:1px solid #1c1c1c;text-align:center;font-size:13.5px;line-height:1.3;letter-spacing:0;text-transform:none;position:static}
.tdoc td{border:1px solid #1c1c1c;padding:10px 9px;vertical-align:middle;background:#fff;color:#161616}
.tdoc tbody.tdi tr:nth-child(odd) td{background:#f6efe8}
.tdoc td.tdc{text-align:center}
.tdoc td b{display:block;font-size:15px;font-weight:700;color:#111}
.tdoc td span{display:block;margin-top:5px}
.tdoc td i{display:block;font-style:normal;font-size:11px;color:#666;margin-top:5px}
.tdoc tr.tdsub td{font-weight:500;padding:8px 9px}.tdoc tr.tdsub td:first-child{text-align:right}
.tdoc tr.tdtot td{background:#d2d0cf;font-weight:700;font-size:15px}.tdoc tr.tdtot td:first-child{text-align:center}
.tdoc tr.tdw td{font-size:13.5px}.tdoc tr.tdw b{display:inline;font-size:inherit}.tdoc tr.tdw u{font-weight:700}
.tdoc .tdsg{display:grid;grid-template-columns:1fr 1fr;gap:30px;padding:26px 60px 0;font-weight:700;font-size:12.5px;text-align:center;min-height:118px;line-height:1.9}
.tdoc .tdbk{margin:4px 60px 0;padding-top:16px;border-top:1px solid #d9d2c8;break-inside:avoid;page-break-inside:avoid}
.tdoc .tdbk h3{font:700 13.5px/1.3 Montserrat,'Segoe UI',Arial,sans-serif;text-decoration:underline;text-underline-offset:3px;margin:0 0 10px;color:#111;letter-spacing:0;text-transform:none}
.tdoc .tdbk p{margin:0 0 6px 40px;font-size:13px;color:#161616}
.tdoc .tdf{margin-top:20px;text-align:center;font-size:11px;color:#8a7f79}
@media(max-width:640px){.tdoc{font-size:12px;margin-top:30px}.tdoc .tdh{padding:16px 14px 12px;gap:10px}.tdoc .tdco b{font-size:13.5px;margin-bottom:6px}.tdoc .tdco span{font-size:11.5px}.tdoc .tdh img{height:50px}.tdoc h2{font-size:17px;margin:16px 0 12px}
 .tdoc .tdm{grid-template-columns:1fr;gap:4px;padding:0 16px 14px}.tdoc .tdm p{font-size:12.5px;margin-bottom:5px}.tdoc table{font-size:11.5px}.tdoc th{font-size:10px;padding:8px 2px}.tdoc td{padding:8px 5px}.tdoc td b{font-size:12.5px}
 .tdoc tr.tdtot td{font-size:12.5px}.tdoc tr.tdw td{font-size:12px}.tdoc .tdsg{padding:20px 14px 0;gap:14px;min-height:90px;font-size:11px}.tdoc .tdbk{margin:4px 16px 0}.tdoc .tdbk p{margin-left:0;font-size:12px;word-break:break-word}.tdoc .tdstamp{right:12px;top:92px;font-size:11px;padding:3px 9px 3px 11px}}
@media print{.tdoc{margin:0;font-size:10pt;padding-bottom:4mm}.tdoc .tdh{padding:4.5mm 10mm 3mm 9mm}.tdoc .tdh img{height:17.5mm}.tdoc .tdco b{margin-bottom:1.6mm}.tdoc h2{margin:4mm 0 3mm}.tdoc .tdm{padding-bottom:3.5mm}.tdoc .tdm p{margin-bottom:1.3mm}.tdoc td{padding:1.9mm 2.4mm}.tdoc th{padding:2.2mm 1.5mm}.tdoc td span,.tdoc td i{margin-top:.9mm}.tdoc .tdsg{min-height:21mm;padding-top:5mm}.tdoc .tdbk{padding-top:3mm}.tdoc .tdbk h3{margin-bottom:2mm}.tdoc .tdbk p{margin-bottom:.9mm}.tdoc .tdf{margin-top:3mm}.tdoc .tdstamp{top:28mm}}`;
  TT.docHTML = function (kind, d, S, opt) {   // kind: 'quotation' | 'invoice' | 'receipt'
    opt = opt || {}; S = S || TT.settings; const e = U.esc, f2 = U.f2, c = d.company || {}, p = d.payment || {};
    const isQ = kind === 'quotation', rc = kind === 'receipt', paid = !isQ && p.paid === true, legal = S.legalName || S.storeName || 'The Touch';
    const title = isQ ? 'Quotation' : rc ? 'Receipt' : (S.trn ? 'Tax Invoice' : 'Invoice');
    const meta = [[isQ ? 'Quotation Number' : rc ? 'Receipt for Invoice' : 'Invoice Number', d.no], ['Date', U.dmy(rc && p.paidAt ? p.paidAt : d.created)], ['Currency', 'AED']];
    if (isQ && d.validUntil) meta.push(['Valid Until', U.dmy(d.validUntil)]);
    if (!isQ && d.quoteNo) meta.push(['Quotation Number', d.quoteNo]);
    if (!isQ && d.po) meta.push(['PO Number', d.po]);
    const lines = Array.isArray(d.items) ? d.items : [], allPc = lines.length > 0 && lines.every(l => l.unit !== 'kg');
    const note = l => { const o = Number(l.orig) || 0; return o > l.price + 0.004 ? 'Original price: AED ' + f2(o) + ' · ' + (Math.round((1 - l.price / o) * 1000) / 10) + '% discount applied' : ''; };
    const rows = lines.map((l, i) => `<tr><td class="tdc">${i + 1}</td><td><b>${e(l.name)}</b>${l.desc ? '<span>' + e(l.desc) + '</span>' : ''}${note(l) ? '<i>' + note(l) + '</i>' : ''}</td><td class="tdc">${l.unit === 'kg' ? U.r2(l.grams * l.qty / 1000) + ' kg' : l.qty}</td><td class="tdc">${f2(l.price)}${l.unit === 'kg' ? '<i>per kg</i>' : ''}</td><td class="tdc">${f2(U.lineTotal(l))}</td></tr>`).join('');
    const disc = Number(d.discount) || 0, deliv = d.fulfil === 'delivery' ? Number(d.delivery) || 0 : 0, extra = [];
    if (disc || deliv) extra.push(['Subtotal', f2(d.subtotal)]);
    if (disc) extra.push(['Discount', '− ' + f2(disc)]);
    if (deliv) extra.push(['Delivery', f2(deliv)]);
    if (S.trn) extra.push(['Total excluding VAT', f2(U.r2(d.total - d.vat))], ['VAT ' + (S.vatRate == null ? 5 : S.vatRate) + '%', f2(d.vat)]);
    const terms = d.terms || S.payTerms || '', b = opt.bank || {}, ref = opt.ref || p.ref || '';
    const bank = [['Account Title', b.title], ['IBAN', b.iban], ['Account Number', b.account], ['BIC / SWIFT', b.swift], ['Bank', b.bank], ['Branch Code / Branch Name', b.branch]].filter(x => x[1]);
    return `<div class="tdoc" id="invc"><div class="tdh"><div class="tdco"><b>${e(legal)}</b><span>${e(S.address || 'Abu Dhabi, United Arab Emirates')}</span><span>Tel: ${e(S.phone || '')}</span>${S.trn ? '<span>TRN: ' + e(S.trn) + '</span>' : ''}</div><img src="img/logo-gold.png" alt="The Touch"></div>
<h2>${title}</h2>${paid ? '<div class="tdstamp">PAID</div>' : ''}
<div class="tdm"><div><p><b>To:</b> ${e(c.contact || c.name || (d.customer || {}).name || '')}</p>${c.contact && c.name ? '<p>' + e(c.name) + '</p>' : ''}${c.address ? '<p class="tds">' + e(c.address) + '</p>' : ''}${c.trn ? '<p class="tds">TRN: ' + e(c.trn) + '</p>' : ''}${isQ && d.subject ? '<p class="tds"><b>Subject:</b> ' + e(d.subject) + '</p>' : ''}</div>
 <div>${meta.map(([k, v]) => '<p><b>' + k + ':</b> ' + e(v) + '</p>').join('')}</div></div>
<table><colgroup><col style="width:6.5%"><col><col style="width:12%"><col style="width:15%"><col style="width:18%"></colgroup>
 <thead><tr><th>#</th><th>Description</th><th>QTY</th><th>Unit Price<br>(AED)</th><th>Total Amount<br>(AED)</th></tr></thead>
 <tbody class="tdi">${rows}</tbody>
 <tbody>${extra.map(([k, v]) => '<tr class="tdsub"><td colspan="4">' + k + '</td><td class="tdc">' + v + '</td></tr>').join('')}
  <tr class="tdtot"><td colspan="2">Total${S.trn ? ' (including VAT)' : ''}</td><td class="tdc">${allPc ? lines.reduce((a, l) => a + l.qty, 0) : ''}</td><td></td><td class="tdc">${f2(d.total)}</td></tr>
  <tr class="tdw"><td colspan="5"><b>Amount in words:</b> AED ${U.words(d.total)} Only</td></tr>
  ${paid ? `<tr class="tdw"><td colspan="5"><b>Payment received:</b> AED ${f2(d.total)} on ${U.dmy(p.paidAt || Date.now())} · ${e(TT.payLabel(p.method))}${ref ? ' · Ref. ' + e(ref) : ''}</td></tr>` : terms ? `<tr class="tdw"><td colspan="5"><u>Payment Terms:</u>&nbsp; ${e(terms)}</td></tr>` : ''}
  ${isQ && d.notes ? '<tr class="tdw"><td colspan="5"><b>Notes:</b> ' + e(d.notes) + '</td></tr>' : ''}</tbody></table>
<div class="tdsg"><div>${e(legal)}</div><div>${e(c.name || '')}</div></div>
${bank.length && !rc ? '<div class="tdbk"><h3>Bank Account Details</h3>' + bank.map(([k, v]) => '<p>' + k + ' : ' + e(v) + '</p>').join('') + '</div>' : ''}
<div class="tdf">thetouchchocolate.com${S.instagram ? ' · @' + e(S.instagram) : ''}</div></div>`;
  };
  try { const st = document.createElement('style'); st.textContent = TT.DOC_CSS; document.head.appendChild(st); } catch (e) { }

  window.TT = TT;
})();
