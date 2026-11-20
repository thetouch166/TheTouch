/* THE TOUCH — product photos from Cloudflare R2 (binding PHOTOS), cached at the edge for a year.
   Keys are unique per upload (p/<time>-<random>.jpg), so a cached photo never goes stale. */
export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const key = (Array.isArray(ctx.params.path) ? ctx.params.path : [ctx.params.path]).join('/');
  if (!/^p\/[A-Za-z0-9._-]{1,80}$/.test(key) || !env.PHOTOS) return new Response('Not found', { status: 404 });
  let cache = null; try { cache = caches.default; const hit = await cache.match(request); if (hit) return hit; } catch (e) { }
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  const h = new Headers(); obj.writeHttpMetadata(h);
  h.set('ETag', obj.httpEtag); h.set('Cache-Control', 'public, max-age=31536000, immutable'); h.set('X-Content-Type-Options', 'nosniff');
  const res = new Response(obj.body, { headers: h });
  if (cache) ctx.waitUntil(cache.put(request, res.clone()).catch(() => { }));
  return res;
}
