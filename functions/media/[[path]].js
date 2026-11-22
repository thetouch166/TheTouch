/* THE TOUCH — product photos uploaded from the admin, cached at the edge for a year.
   Stored in Cloudflare KV (binding PHOTOS_KV); R2 (binding PHOTOS) is read first when it is switched on.
   Keys are unique per upload (p/<time>-<random>.jpg), so a cached photo never goes stale. */
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const key = (Array.isArray(ctx.params.path) ? ctx.params.path : [ctx.params.path]).join('/');
  if (!/^p\/[A-Za-z0-9._-]{1,80}$/.test(key) || (!env.PHOTOS && !env.PHOTOS_KV)) return new Response('Not found', { status: 404 });
  let cache = null; try { cache = caches.default; const hit = await cache.match(request); if (hit) return hit; } catch (e) { }
  const h = new Headers({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  let body = null;
  if (env.PHOTOS) { const obj = await env.PHOTOS.get(key); if (obj) { obj.writeHttpMetadata(h); h.set('ETag', obj.httpEtag); h.set('Cache-Control', 'public, max-age=31536000, immutable'); body = obj.body; } }
  if (!body && env.PHOTOS_KV) {
    const { value, metadata } = await env.PHOTOS_KV.getWithMetadata(key, 'arrayBuffer');
    if (value) { h.set('Content-Type', (metadata && metadata.type) || TYPES[key.split('.').pop()] || 'application/octet-stream'); body = value; }
  }
  if (!body) return new Response('Not found', { status: 404 });
  const res = new Response(body, { headers: h });
  if (cache) ctx.waitUntil(cache.put(request, res.clone()).catch(() => { }));
  return res;
}
