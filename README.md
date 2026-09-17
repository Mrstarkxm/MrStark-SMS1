# MrStark SMS V68

V68 is the Vercel/Supabase build with mobile navigation, automatic browser-assisted Lamix scanning, and CDR group-by reporting.

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


## V68 deployment note
- Vercel login no longer writes `/var/task/data/db.json`.
- Removed the remaining legacy `url.parse()` usage.
- `/api/health` reports `build: V68` for deployment verification.


## V68 changes
- Added mobile hamburger navigation and responsive sidebar/drawer.
- Added authenticated automatic Lamix scanning while the Super Admin panel is open on Vercel.
- Added CDR Group by: Hour, Day, Month, Range, Number, CLI, Client, Currency, Status. Multiple selections can be combined.
- Grouped CDR reports now show only the selected grouping dimensions plus Currency/SMS/payout aggregates, matching the supplied reference collage.


V73: protected Supabase state writes from concurrent Vercel instances and fixed Bulk Add range filtering.


## V76
Cross-instance auth/state freshness and dashboard allocation-count fixes.
