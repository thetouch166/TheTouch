/* THE TOUCH — website pages  →  everything that is not /api, /media, the admin or a static folder
   The pages are still drawn in the browser by public/index.html. This function makes each address a real page
   for Google, WhatsApp and Instagram:
     • its own <title>, description and canonical address
     • a share preview (Open Graph / Twitter card) with the product photo
     • Google data (JSON-LD): the boutique, each product with its price and stock, breadcrumbs
     • a plain summary inside <noscript> for readers that do not run JavaScript
     • /sitemap.xml built from the products on sale, and a real 404 for addresses that do not exist
   If anything here fails, the visitor still gets the normal page (see the catch at the bottom).
   The route list mirrors route() in public/index.html and the category list mirrors CATS in public/js/store.js. */

const BRAND = 'The Touch';
const HOME_TITLE = 'The Touch | Luxury Chocolates & Chocolate Gifts in Abu Dhabi';
const HOME_DESC = 'The Touch is a luxury chocolate boutique in Abu Dhabi: handcrafted chocolates, gift boxes, trays and bespoke arrangements, delivered across all seven Emirates.';
const CATS = {
  national: ['National Day Collection', 'Hand-wrapped chocolates in red, green, white and black, arranged in boxes, bowls and trays to celebrate the UAE.'],
  pralines: ['Pralines & Bonbons', 'Pralines and bonbons filled and enrobed by hand in Abu Dhabi, sold by weight in our signature box.'],
  oriental: ['Oriental Collection', 'Arabic sweets reimagined in fine chocolate: kunafah, halawa, pistachio and orange blossom.'],
  bars: ['Bars & Slims', 'Slim chocolate bars and discs for everyday indulgence and thoughtful small gifts.'],
  dipped: ['Dipped Fruits & Nuts', 'Candied fruits and roasted nuts dipped in fine chocolate.'],
  gifts: ['Gifts & Arrangements', 'Luxury chocolate gift boxes, trays and arrangements, finished by hand with our signature ribbon.']
};
const PAGES = {
  story: ['Our Story', 'The Touch was born from a simple idea: chocolate can say what words sometimes cannot. Meet the Abu Dhabi boutique behind the box.'],
  events: ['Weddings, Corporate Gifting & Events', 'Bespoke chocolate arrangements for weddings, corporate gifting, baby receptions and Eid. Tell us about your occasion and receive a proposal within 24 hours.'],
  delivery: ['Delivery & Care', 'Chocolate delivery across all seven Emirates, same day in Abu Dhabi. Delivery fees, timings and how to store your chocolates.'],
  privacy: ['Privacy Policy', 'How The Touch collects, uses and protects your personal information.'],
  terms: ['Terms & Conditions', 'The terms that apply when you order from The Touch.'],
  refunds: ['Refunds & Returns', 'Our policy on cancellations, returns, replacements and refunds.']
};
const PRIVATE = { checkout: 'Checkout', order: 'Your order' };   // real pages, but not for search results

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/[\s,;:.]+\S*$/, '') + '…' : s; };
const onSale = p => p && p.active !== false && p.web !== false && p.name;   // web:false = sold in the boutique (POS) only
const aed = n => 'AED ' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

/* ---------- shop data: the same edge cache the API fills (purged when staff save), else the database ---------- */
async function readCol(ctx, origin, col) {
  const key = new Request(origin + '/api/db/' + col + '?edge=1');
  try { const hit = await caches.default.match(key); if (hit) return (await hit.json()).rows || []; } catch (e) { }
  const cs = ctx.env.DATABASE_URL; if (!cs) return [];
  const host = new URL(cs.replace(/^postgres(ql)?:/, 'https:')).hostname;
  const r = await fetch('https://' + host.replace(/^[^.]+\./, 'api.') + '/sql', {
    method: 'POST', headers: { 'Neon-Connection-String': cs, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true' },
    body: JSON.stringify({ query: 'select data::text from docs where col=$1 and not deleted', params: [col] })
  });
  if (!r.ok) throw new Error('database ' + r.status);
  const rows = ((await r.json()).rows || []).map(([d]) => { const o = JSON.parse(d); if (col === 'settings') delete o.pin; return o; });
  ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify({ t: Date.now(), rows }), { headers: { 'Cache-Control': 'public, max-age=60' } })).catch(() => { }));
  return rows;
}
async function shopData(ctx, origin) {
  const [products, settings] = await Promise.all([readCol(ctx, origin, 'products'), readCol(ctx, origin, 'settings')]);
  return { products: products.filter(onSale), s: settings.find(x => x.id === 'main') || settings[0] || {} };
}

/* ---------- what each address is ---------- */
function describe(path, data, site) {
  const [pg, arg, extra] = path.split('/'); const { products, s } = data;
  const abs = src => !src || /^data:/.test(src) ? site + '/img/og.jpg' : /^https?:/.test(src) ? src : site + '/' + String(src).replace(/^\//, '');
  const store = {
    '@type': 'Store', '@id': site + '/#store', name: BRAND, alternateName: 'The Touch Chocolates', url: site + '/', description: HOME_DESC,
    logo: site + '/img/logo-burgundy.png', image: site + '/img/og.jpg', telephone: s.phone || undefined, currenciesAccepted: 'AED', areaServed: { '@type': 'Country', name: 'United Arab Emirates' },
    address: { '@type': 'PostalAddress', streetAddress: s.address && !/^abu dhabi,?\s*(united arab emirates|uae)?$/i.test(s.address.trim()) ? s.address : undefined, addressLocality: 'Abu Dhabi', addressCountry: 'AE' },
    openingHours: s.hours || undefined, hasMap: s.mapUrl || undefined,
    sameAs: s.instagram ? ['https://www.instagram.com/' + s.instagram + '/'] : undefined
  };
  const prices = products.map(p => +p.price).filter(n => n > 0);
  if (prices.length) store.priceRange = aed(Math.min(...prices)) + ' – ' + aed(Math.max(...prices));
  const crumbs = list => ({ '@type': 'BreadcrumbList', itemListElement: list.map(([name, url], i) => ({ '@type': 'ListItem', position: i + 1, name, item: site + url })) });
  const link = p => `<li><a href="/p/${esc(p.id)}">${esc(p.name)}</a> — ${esc(aed(p.price))}${p.unit === 'kg' ? ' per kg' : ''}</li>`;
  const cats = Object.keys(CATS).filter(c => products.some(p => p.cat === c));
  const nav = `<p><a href="/shop/all">All chocolates</a>${cats.map(c => ` · <a href="/shop/${c}">${esc(CATS[c][0])}</a>`).join('')} · <a href="/events">Weddings &amp; events</a> · <a href="/story">Our story</a> · <a href="/delivery">Delivery &amp; care</a></p>`;
  const page = (m) => Object.assign({ status: 200, type: 'website', image: site + '/img/og.jpg', ld: [], pre: '' }, m);

  if (!pg && !arg) return page({
    title: HOME_TITLE, desc: HOME_DESC, path: '/', ld: [store, { '@type': 'WebSite', '@id': site + '/#website', url: site + '/', name: BRAND, publisher: { '@id': site + '/#store' } }],
    pre: `<h1>${BRAND} — luxury chocolates and chocolate gifts in Abu Dhabi</h1><p>${esc(HOME_DESC)}</p>${nav}<ul>${products.map(link).join('')}</ul>`
  });
  if (pg === 'shop' && !extra) {
    const c = arg && arg !== 'all' ? CATS[arg] : null;
    if (arg && arg !== 'all' && !c) return { redirect: '/shop/all' };
    const list = products.filter(p => !c || p.cat === arg); const url = '/shop/' + (c ? arg : 'all');
    const title = c ? c[0] : 'All Chocolates & Gifts'; const desc = c ? c[1] : 'Browse every creation from The Touch: handcrafted chocolates, gift boxes, trays and arrangements, delivered across the UAE.';
    return page({
      title: title + ' | The Touch Chocolates Abu Dhabi', desc, path: url, image: list.length ? abs(list[0].img) : site + '/img/og.jpg', noindex: !list.length,
      ld: [crumbs([['Home', '/'], [title, url]]), { '@type': 'ItemList', name: title, numberOfItems: list.length, itemListElement: list.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: site + '/p/' + p.id, name: p.name })) }],
      pre: `<h1>${esc(title)}</h1><p>${esc(desc)}</p><ul>${list.map(link).join('')}</ul>${nav}`
    });
  }
  if (pg === 'p' && arg && !extra) {
    const p = products.find(x => x.id === arg); if (!p) return null;
    const cat = CATS[p.cat] ? CATS[p.cat][0] : 'Chocolates'; const url = '/p/' + p.id; const kg = p.unit === 'kg'; const inStock = !(p.stock != null && p.stock <= 0);
    const offer = { '@type': 'Offer', url: site + url, priceCurrency: 'AED', price: (+p.price || 0).toFixed(2), availability: 'https://schema.org/' + (inStock ? 'InStock' : 'OutOfStock'), itemCondition: 'https://schema.org/NewCondition', seller: { '@id': site + '/#store' } };
    if (kg) offer.priceSpecification = { '@type': 'UnitPriceSpecification', price: (+p.price || 0).toFixed(2), priceCurrency: 'AED', unitCode: 'KGM' };
    return page({
      title: p.name + ' | The Touch Chocolates Abu Dhabi', desc: clip(p.desc || p.name + ' by The Touch, a luxury chocolate boutique in Abu Dhabi.', 300), path: url, type: 'product', image: abs(p.img),
      price: (+p.price || 0).toFixed(2), inStock,
      ld: [crumbs([['Home', '/'], [cat, '/shop/' + p.cat], [p.name, url]]), { '@type': 'Product', '@id': site + url + '#product', name: p.name, alternateName: p.ar || undefined, description: p.desc || undefined, image: [abs(p.img)], sku: p.sku || p.id, category: cat, brand: { '@type': 'Brand', name: BRAND }, offers: offer }],
      pre: `<p><a href="/">Home</a> / <a href="/shop/${esc(p.cat)}">${esc(cat)}</a></p><h1>${esc(p.name)}</h1>${p.ar ? `<p lang="ar" dir="rtl">${esc(p.ar)}</p>` : ''}<p>${esc(aed(p.price))}${kg ? ' per kg' : ''}, inclusive of VAT${inStock ? '' : ' — sold out'}</p><p>${esc(p.desc || '')}</p><img src="${esc(abs(p.img))}" alt="${esc(p.name)}" width="600">${nav}`
    });
  }
  if (PAGES[pg] && !arg) return page({
    title: PAGES[pg][0] + ' | The Touch Chocolates Abu Dhabi', desc: PAGES[pg][1], path: '/' + pg, ld: [crumbs([['Home', '/'], [PAGES[pg][0], '/' + pg]])],
    pre: `<h1>${esc(PAGES[pg][0])}</h1><p>${esc(PAGES[pg][1])}</p>${nav}`
  });
  // an order's own page: the title and text below are what WhatsApp shows as the link's preview card
  if (pg === 'order' && arg && !extra && /^[A-Za-z0-9_-]{1,40}$/.test(arg)) return page({ title: 'Order ' + arg + ' | ' + BRAND, desc: 'Your order with The Touch, luxury chocolates and gifts in Abu Dhabi. Open it to see the order details, the invoice and the payment.', path: '/order/' + arg, noindex: true });
  if (PRIVATE[pg] && !extra && (pg === 'order' ? !!arg : !arg)) return page({ title: PRIVATE[pg] + ' | ' + BRAND, desc: HOME_DESC, path: '/' + pg, noindex: true });
  return null;   // not one of the website's pages
}

function sitemap(data, site) {
  const day = t => new Date(t || Date.now()).toISOString().slice(0, 10); const today = day();
  const cats = Object.keys(CATS).filter(c => data.products.some(p => p.cat === c));
  const urls = [['/', today, '1.0'], ['/shop/all', today, '0.9']]
    .concat(cats.map(c => ['/shop/' + c, today, '0.8']))
    .concat(data.products.map(p => ['/p/' + p.id, day(p.updated), '0.8']))
    .concat(['events', 'story', 'delivery'].map(p => ['/' + p, today, '0.5']))
    .concat(['privacy', 'terms', 'refunds'].map(p => ['/' + p, today, '0.2']));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(([u, d, pr]) => `<url><loc>${esc(site + u)}</loc><lastmod>${d}</lastmod><priority>${pr}</priority></url>`).join('\n') + '\n</urlset>\n';
}

function render(shell, m, site, status) {
  const url = site + m.path;
  const tags = [
    m.noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow,max-image-preview:large">',
    `<meta property="og:site_name" content="${BRAND}">`, `<meta property="og:locale" content="en_AE">`, `<meta property="og:type" content="${m.type}">`,
    `<meta property="og:title" content="${esc(m.title)}">`, `<meta property="og:description" content="${esc(clip(m.desc, 200))}">`,
    `<meta property="og:url" content="${esc(url)}">`, `<meta property="og:image" content="${esc(m.image)}">`, `<meta property="og:image:alt" content="${esc(m.title)}">`,
    m.price ? `<meta property="product:price:amount" content="${m.price}"><meta property="product:price:currency" content="AED"><meta property="product:availability" content="${m.inStock ? 'in stock' : 'out of stock'}">` : '',
    `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:title" content="${esc(m.title)}">`, `<meta name="twitter:description" content="${esc(clip(m.desc, 200))}">`, `<meta name="twitter:image" content="${esc(m.image)}">`,
    m.ld.length ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': m.ld }).replace(/</g, '\\u003c')}</script>` : ''
  ].filter(Boolean).join('\n');
  const out = new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(m.title); } })
    .on('meta[name="description"]', { element(e) { e.setAttribute('content', clip(m.desc, 300)); } })
    .on('link[rel="canonical"]', { element(e) { e.setAttribute('href', url); } })
    .on('head', { element(e) { e.append('\n' + tags + '\n', { html: true }); } })
    .on('main#app', { element(e) { if (m.pre) e.setInnerContent('<noscript><div style="max-width:760px;margin:0 auto;padding:40px 24px">' + m.pre + '</div></noscript>', { html: true }); } })
    .transform(shell);
  const h = new Headers(out.headers);
  h.delete('ETag'); h.delete('Content-Length'); h.set('Content-Type', 'text/html; charset=utf-8'); h.set('Cache-Control', 'public, max-age=0, must-revalidate');
  if (m.noindex) h.set('X-Robots-Tag', 'noindex');
  return new Response(out.body, { status, headers: h });
}

export async function onRequest(ctx) {
  const { request, env } = ctx; const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return env.ASSETS.fetch(request);
  try {
    const site = (env.SITE_URL || url.origin).replace(/\/+$/, '');
    const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/^index\.html$/, '');
    if (path === 'sitemap.xml') {
      const data = await shopData(ctx, url.origin);
      return new Response(sitemap(data, site), { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=600' } });
    }
    const shell = () => env.ASSETS.fetch(new Request(url.origin + '/', { headers: { Accept: 'text/html' } }));
    const notFound = async () => render(await shell(), { title: 'Page not found | ' + BRAND, desc: HOME_DESC, path: '/' + path, type: 'website', image: site + '/img/og.jpg', ld: [], pre: '<h1>Page not found</h1><p><a href="/shop/all">View the collection</a></p>', noindex: true }, site, 404);

    if (/\.[a-z0-9]{2,5}$/i.test(path)) {   // a file: robots.txt, an icon, a verification file …
      const res = await env.ASSETS.fetch(request);
      const html = (res.headers.get('Content-Type') || '').includes('text/html');
      return html && res.status === 200 && !/\.html?$/i.test(path) ? new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }) : res;
    }
    const data = await shopData(ctx, url.origin);
    const m = describe(path, data, site);
    if (m && m.redirect) return Response.redirect(url.origin + m.redirect, 301);
    if (m) return render(await shell(), m, site, 200);
    // not a website page: a static page such as a verification file served without ".html", or nothing at all
    const [res, home] = await Promise.all([env.ASSETS.fetch(request), shell()]);
    if (res.status === 200 && res.headers.get('ETag') && res.headers.get('ETag') !== home.headers.get('ETag')) return res;
    if (res.status >= 300 && res.status < 400) return res;
    return notFound();
  } catch (e) {
    console.error('page', url.pathname, e && e.message);
    return env.ASSETS.fetch(request);   // the plain page still works; the browser fills it in
  }
}
