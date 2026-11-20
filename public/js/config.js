/* ============================================================
   THE TOUCH — CONFIGURATION
   ------------------------------------------------------------
   LIVE MODE (default on the real site): the website and admin
   talk to our own API at /api (Cloudflare Pages Functions →
   Neon database, R2 photos, Resend emails). See docs/SETUP.md.

   OFFLINE / DEMO MODE: on the local dev server (port 5500 —
   VS Code Live Server or `python -m http.server 5500`) the app
   saves to this browser only (localStorage). PIN 1234.
   ============================================================ */
window.TT_API = (location.port === '5500' || location.protocol === 'file:') ? null : '/api';
