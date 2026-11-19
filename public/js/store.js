/* THE TOUCH — shared data layer (website + admin + POS)
   Local mode: localStorage (+ live sync between tabs on the same device)
   Live mode : Firebase Firestore (+ Auth for admin) when js/config.js has TT_FIREBASE */
(function () {
  'use strict';

  /* ---------------- Seed catalogue ---------------- */
  const CATS = [
    { id: 'pralines', name: 'Pralines & Bonbons', ar: 'برالين' },
    { id: 'oriental', name: 'Oriental Collection', ar: 'تشكيلة شرقية' },
    { id: 'bars', name: 'Bars & Slims', ar: 'ألواح' },
    { id: 'dipped', name: 'Dipped Fruits & Nuts', ar: 'فواكه ومكسرات' },
    { id: 'gifts', name: 'Gifts & Arrangements', ar: 'هدايا وتنسيقات' }
  ];

  // price = AED. unit 'kg' → sold by weight (online: 250g / 500g / 1kg; POS: enter grams)
  // PRICES ARE PLACEHOLDERS — edit them in Admin → Products.
  const P = (id, name, ar, cat, unit, price, desc, extra) => Object.assign({
    id, sku: id.toUpperCase().replace(/-/g, '').slice(0, 8), name, ar, cat, unit, price, desc,
    img: 'img/' + id + '.jpg', stock: unit === 'kg' ? 20 : 40, active: true, featured: false
  }, extra || {});

  const SEED = [
    P('salted-caramel', 'Salted Caramel Hazelnut', 'كراميل مملّح بالبندق', 'pralines', 'kg', 420, 'A whole roasted hazelnut wrapped in soft salted caramel and enrobed in milk chocolate, finished with a dusting of cocoa.', { featured: true }),
    P('truffle-rocher', 'Truffle Rocher Hazelnut', 'ترافل روشيه بالبندق', 'pralines', 'kg', 400, 'Crisp roasted nut shell around a velvet hazelnut truffle heart.', { featured: true }),
    P('coconut-pistachio', 'Coconut & Pistachio', 'جوز الهند والفستق الحلبي', 'pralines', 'kg', 390, 'Snow-white coconut ganache with a centre of Aleppo pistachio, in fine milk chocolate.', { featured: true }),
    P('chabelon-hazelnut', 'New Chabelon Hazelnut', 'نيو شابلون بالبندق', 'pralines', 'kg', 380, 'Our signature chabelon praline layered with hazelnut crunch and a whole hazelnut.'),
    P('macadamia', 'Caramelized Macadamia', 'مكاديميا مكرملة', 'pralines', 'kg', 420, 'Buttery macadamia, slowly caramelised and coated in silky milk chocolate.', { featured: true }),
    P('almond-quinball', 'Chopped Almond Quinball', 'كوين بول باللوز المقطّع', 'pralines', 'kg', 380, 'A round praline packed with roasted chopped almonds and gianduja.'),
    P('earth', 'Earth', 'الأرض', 'pralines', 'kg', 380, 'Two textures, one sphere — a crisp wafer disc and a rich cocoa truffle.'),
    P('monte-carlo', 'New Monte Carlo', 'نيو مونتي كارلو', 'pralines', 'kg', 370, 'Individually wrapped squares of milk chocolate with a crunchy nut praline core.'),
    P('coffee-bean', 'Chocolate Coffee Bean', 'شوكولا حبة بن قهوة', 'pralines', 'kg', 370, 'A coffee-bean shaped praline with a smooth espresso ganache.'),
    P('tiramisu', 'Tiramisu', 'تيراميسو', 'pralines', 'kg', 390, 'Mascarpone-style cream and coffee sponge in chocolate, dusted with cocoa.', { featured: true }),
    P('cotton-candy', 'Cotton Candy', 'غزل البنات', 'pralines', 'kg', 380, 'A pyramid of chocolate filled with light, cloud-soft cotton candy cream.'),
    P('cream-biscuit', 'Chocolate Cream Biscuit with Nuts', 'شوكولا مربعة كريم بسكوت كسر', 'pralines', 'kg', 380, 'A square of biscuit cream crowned with caramelised chopped nuts.'),
    P('kunafah', 'Kunafah', 'كنافة', 'oriental', 'kg', 420, 'The beloved Arabic dessert reimagined — crisp kunafah and pistachio cream under a hand-painted chocolate shell.', { featured: true }),
    P('pistachio-halawa', 'Pistachio Halawa Chocolate', 'شوكولا بالحلاوة والفستق الحلبي', 'oriental', 'kg', 400, 'Silky tahini halawa studded with pistachio in a bark-textured milk chocolate log.'),
    P('pistachio-orange', 'Pistachio with Orange Blossom', 'فستق حلبي بماء الزهر', 'oriental', 'kg', 400, 'Pistachio paste scented with orange-blossom water in a fine chocolate bar.', { featured: true }),
    P('snayniyeh', 'Chocolate Round Snayniyeh', 'شوكولا مدورة سنينية', 'oriental', 'kg', 380, 'A round chocolate inspired by the traditional snayniyeh, rich with nuts.'),
    P('madlouka', 'Chocolate Madlouka', 'شوكولا تغطيس مدلوقة', 'oriental', 'kg', 400, 'Layers of creamy madlouka and nuts, topped with crushed pistachio.'),
    P('fig-sesame', 'Chocolate Fig with Sesame, Almond & Walnut', 'شوكولا تغطيس تين مع سمسم لوز وجوز', 'oriental', 'kg', 390, 'Sun-dried fig with toasted sesame, almond and walnut, dipped in chocolate.'),
    P('florentine-pistachio', 'Caramelized Florentine Pistachio', 'فلورنتين بالفستق الحلبي المكرمل', 'oriental', 'kg', 420, 'A dome of caramelised pistachio florentine enrobed in milk chocolate.'),
    P('slim-almond', 'Slim Chopped Almond', 'شوكولا رفيعة باللوز المقطّع', 'bars', 'pc', 45, 'A slim, elegant bar of milk chocolate with fine chopped almonds.', { featured: true }),
    P('chopped-nuts', 'Chopped Nuts Bar', 'مكسرات مقطّعة', 'bars', 'pc', 55, 'Our signature parquet-pattern bar filled with roasted chopped nuts.'),
    P('exotic-chabelon', 'Exotic Chabelon', 'إكزوتيك شابلون', 'bars', 'pc', 25, 'A chocolate disc topped with almonds, hazelnuts, apricot and cranberries.'),
    P('orange-slices', 'Dark Chocolate-Dipped Orange Slices', 'شرائح برتقال مغموسة بالشوكولا الداكنة', 'dipped', 'kg', 360, 'Candied orange slices half-dipped in intense dark chocolate.'),
    P('fruit-nuts', 'Chocolate Fruit & Nuts', 'شوكولا تغطيس كروكان فستق', 'dipped', 'kg', 390, 'Squares crowned with cashew, pistachio, cranberry and apricot.'),
    P('pecan-florentine', 'Pecan & Florentine Pistachio', 'جوز البيكان وفلورنتين بالفستق الحلبي', 'dipped', 'kg', 420, 'Glazed pecans on a pistachio florentine base.'),
    P('gift-bag', 'Signature Gift Bag Arrangement', 'تنسيق حقيبة الهدايا', 'gifts', 'pc', 950, 'A luxurious designer-bag arrangement filled with an assortment of our finest pralines and wrapped chocolates. Customisable colours and ribbons.', { stock: 5, featured: true }),
    P('gift-tray', 'Crystal Tray Arrangement', 'تنسيق صينية كريستال', 'gifts', 'pc', 650, 'An acrylic or crystal tray arranged with 1 kg of assorted pralines, perfect for Eid, weddings and new-baby receptions.', { img: 'img/gift-bag-sign.jpg', stock: 5 }),
    P('box-500', 'Assorted Pralines Box — 500 g', 'علبة برالين مشكلة ٥٠٠ غ', 'gifts', 'pc', 220, 'Our chocolatier\'s selection of signature pralines in a reusable The Touch box.', { img: 'img/banner-coconut.jpg', stock: 20, featured: true })
  ];

  const DEFAULT_SETTINGS = {
    id: 'main',
    storeName: 'The Touch',
    tagline: 'Where Luxury Finds Its Flavor',
    phone: '+971 52 663 3823',
    whatsapp: '971526633823',
    instagram: 'the.touch.chocolates',
    email: 'hello@thetouch.ae',
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
    onlinePayments: ['cod', 'card_on_delivery', 'link']
  };

  /* ---------------- Utils ---------------- */
  const U = {
    money(n, cur) { n = Number(n) || 0; return (cur || 'AED') + ' ' + n.toLocaleString('en-AE', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); },
    r2(n) { return Math.round((Number(n) || 0) * 100) / 100; },
    uid(p) { return (p || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },
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
    async signIn(pin) { const s = await local.get('settings', 'main'); return pin === ((s && s.pin) || DEFAULT_SETTINGS.pin); },
    async signOut() { },
    isAdmin() { return sessionStorage.getItem('tt_admin') === '1'; }
  };

  /* ---------------- Firebase backend ---------------- */
  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
  const FBV = '10.12.2';
  const fb = {
    mode: 'live',
    async init() {
      await loadScript(`https://www.gstatic.com/firebasejs/${FBV}/firebase-app-compat.js`);
      await loadScript(`https://www.gstatic.com/firebasejs/${FBV}/firebase-firestore-compat.js`);
      await loadScript(`https://www.gstatic.com/firebasejs/${FBV}/firebase-auth-compat.js`);
      firebase.initializeApp(window.TT_FIREBASE);
      fb.db = firebase.firestore();
      try { await fb.db.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* offline cache optional */ }
      await new Promise(r => { const u = firebase.auth().onAuthStateChanged(() => { u(); r(); }); });
    },
    async all(col) { const s = await fb.db.collection(col).get(); return s.docs.map(d => Object.assign({ id: d.id }, d.data())); },
    async get(col, id) { const d = await fb.db.collection(col).doc(id).get(); return d.exists ? Object.assign({ id: d.id }, d.data()) : null; },
    async put(col, obj) { await fb.db.collection(col).doc(obj.id).set(JSON.parse(JSON.stringify(obj))); return obj.id; },
    async patch(col, id, part) { await fb.db.collection(col).doc(id).set(JSON.parse(JSON.stringify(part)), { merge: true }); },
    async inc(col, id, field, delta) { await fb.db.collection(col).doc(id).update({ [field]: firebase.firestore.FieldValue.increment(delta) }); },
    async del(col, id) { await fb.db.collection(col).doc(id).delete(); },
    watch(col, cb) { return fb.db.collection(col).onSnapshot(s => cb(s.docs.map(d => Object.assign({ id: d.id }, d.data()))), e => console.warn('watch', col, e)); },
    async signIn(email, pass) { try { await firebase.auth().signInWithEmailAndPassword(email, pass); return true; } catch (e) { console.warn(e); return false; } },
    async signOut() { await firebase.auth().signOut(); },
    isAdmin() { return !!(window.firebase && firebase.auth().currentUser); }
  };

  /* ---------------- Public API ---------------- */
  const DB = window.TT_FIREBASE ? fb : local;
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
        for (const p of SEED) { try { await DB.put('products', Object.assign({ updated: Date.now() }, p)); } catch (e) { } }
        prods = SEED.slice();
      }
      if (!prods.length) prods = SEED.slice(); // public fallback
      TT.products = prods;
      return TT;
    },
    catName(id) { const c = CATS.find(c => c.id === id); return c ? c.name : id; },
    deliveryFee(emirate, subtotal) {
      const s = TT.settings; const free = Number(s.freeDeliveryOver) > 0 ? Number(s.freeDeliveryOver) : Infinity;
      if (subtotal >= free && emirate === 'Abu Dhabi') return 0;
      return Number((s.delivery || {})[emirate] || 0);
    },
    payLabel(k) { return ({ cash: 'Cash', card: 'Card', split: 'Cash + Card', cod: 'Cash on delivery', card_on_delivery: 'Card on delivery', link: 'Payment link', paid: 'Paid' })[k] || k; },
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
  const METHODS = ['cash', 'card', 'split', 'cod', 'card_on_delivery', 'link'];
  const STATUS = ['new', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
  const safeId = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 64);
  const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
  TT.cleanOrder = function (o) {
    o = o || {}; o.id = safeId(o.id); o.no = safeId(o.no) || o.id.slice(-8);
    o.channel = o.channel === 'pos' ? 'pos' : 'web';
    o.status = STATUS.includes(o.status) ? o.status : 'new';
    o.created = num(o.created) || Date.now();
    o.customer = Object.assign({ name: '', phone: '', email: '' }, o.customer || {});
    o.gift = Object.assign({ to: '', phone: '', msg: '' }, o.gift || {});
    o.fulfil = ['instore', 'pickup', 'delivery'].includes(o.fulfil) ? o.fulfil : (o.channel === 'pos' ? 'instore' : 'delivery');
    o.items = (Array.isArray(o.items) ? o.items : []).slice(0, 100).map(l => ({ pid: safeId(l && l.pid), name: String((l && l.name) || ''), unit: l && l.unit === 'kg' ? 'kg' : 'pc', price: Math.max(0, num(l && l.price)), grams: Math.max(0, num(l && l.grams)), qty: Math.max(0, Math.round(num(l && l.qty))), disc: Math.max(0, num(l && l.disc)) }));
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
  window.TT = TT;
})();
