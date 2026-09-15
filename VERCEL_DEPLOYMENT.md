# MrStark SMS V65 — Vercel deployment

V65 keeps the V63 routing fix and replaces the V64 read-only-filesystem workaround with persistent Supabase storage.

## Required environment variables

Existing variables:

```text
LAMIX_BASE_URL=https://panel.lamix.org/api/v1
LAMIX_API_TOKEN=YOUR_SECRET
LAMIX_DEFAULT_OWNER_ADMIN_ID=1
LAMIX_TEST_PANEL_URL=https://panel.lamix.org/test-panel
LAMIX_SESSION_COOKIE=YOUR_SECRET_SESSION_COOKIE
LAMIX_CSRF_TOKEN=YOUR_SECRET_CSRF_TOKEN
CRON_SECRET=YOUR_LONG_RANDOM_SECRET
```

New V65 variables:

```text
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
```

See `SUPABASE_SETUP.md` for the one-time SQL table creation.

## What changed from V64

- Vercel no longer attempts to write `/var/task/data/db.json`.
- Login/session creation is persisted to Supabase instead of the read-only deployment filesystem.
- Users, ranges, numbers, CDRs, allocations, rates, range requests and payout requests use the same existing database API and are persisted as one JSONB state document.
- V63 `api/[...path].js` routing is preserved.
- Local `node server.js` still uses `data/db.json` normally.
- Lamix background scanning remains local-only; Vercel uses the protected cron endpoint for scheduled sync.

## Security

Do not commit `SUPABASE_SERVICE_ROLE_KEY`, Lamix API tokens, session cookies, or CSRF tokens to GitHub. Set them only in Vercel Environment Variables.
