/* THE TOUCH — runs in front of the website pages, /api and /media.
   One address for Google: www.thetouchchocolate.com and the Cloudflare address (the-touch.pages.dev) show the
   same site, so www is sent to the main domain and the Cloudflare address is kept out of search results.
   The Cloudflare address keeps working as a backup for the shop (admin / POS). */
const MAIN = 'thetouchchocolate.com';

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url); const get = ctx.request.method === 'GET' || ctx.request.method === 'HEAD';
  if (get && url.hostname === 'www.' + MAIN) return Response.redirect('https://' + MAIN + url.pathname + url.search, 301);
  const res = await ctx.next();
  const type = res.headers.get('Content-Type') || '';
  if (!url.hostname.endsWith('.pages.dev') && !type.includes('text/html')) return res;
  const out = new Response(res.body, res);
  if (url.hostname.endsWith('.pages.dev')) out.headers.set('X-Robots-Tag', 'noindex');
  if (type.includes('text/html')) {   // public/_headers only covers static files; pages built by a function get theirs here
    out.headers.set('X-Content-Type-Options', 'nosniff'); out.headers.set('X-Frame-Options', 'SAMEORIGIN');
    out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin'); out.headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  return out;
}
