# Vercel deployment

This version uses `api/[...path].js` as the Vercel catch-all entrypoint. This is intentional: the previous rewrite to `/api/index` changed the request path seen by the Node router, causing `/api/auth/login` to become `/api/index` and return 404.

Required environment variables remain the same as the previous V62 Vercel package.

Do not commit Lamix API tokens, session cookies, CSRF tokens, or other secrets to GitHub. Set them in Vercel Environment Variables.


### Vercel JSON DB compatibility
Vercel deployment uses an in-memory fallback for writes because the deployed filesystem is read-only. This prevents EROFS login/session errors. Persistent production data should later be migrated to an external database.
