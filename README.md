# The Touch — Luxury Chocolates · Website, Admin & POS

Abu Dhabi luxury chocolate boutique. Static site (vanilla HTML/CSS/JS) on Cloudflare Pages + a small API (`functions/`) → Neon Postgres, R2 photos, Resend emails.

- `public/index.html` — customer website · `public/admin.html` — admin panel + POS (offline PIN 1234)
- **Run:** VS Code → Live Server on `public/` → http://localhost:5500/index.html (or `cd public && python -m http.server 5500`)
- **Test:** `pip install playwright && playwright install chromium` → `python tests/smoke_test.py` (offline) · `--live` against `npx wrangler pages dev` with a test database
- **Deploy:** `npx wrangler pages deploy` from this folder (not drag-and-drop — that skips the API)
- **Go-live:** `docs/LAUNCH-CHECKLIST.md` · full guide `docs/SETUP.md` · remaining work `docs/BACKLOG.md`
- **Claude Code:** context for the AI is in `CLAUDE.md`
