# MrStark SMS V65

V65 is the Vercel persistent-storage build of MrStark SMS.

- Keeps the V63 Vercel catch-all routing fix.
- Fixes the V64 `EROFS: read-only file system` login/session failure by persisting the JSON database state in Supabase.
- No external npm package is required; Node's built-in `fetch` is used for Supabase REST.
- Local development continues to use `data/db.json`.

## Vercel setup

1. Create the `mrstark_state` table using `SUPABASE_SETUP.md`.
2. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Vercel Environment Variables.
3. Keep the existing Lamix and `CRON_SECRET` variables.
4. Redeploy.

See `VERCEL_DEPLOYMENT.md` and `SUPABASE_SETUP.md`.
