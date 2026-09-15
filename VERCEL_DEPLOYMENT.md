# MrStark SMS – GitHub + Vercel deployment

This project now supports Vercel's Node Serverless Function entrypoint through `api/index.js`.

## Environment Variables in Vercel

Set these in **Project → Settings → Environment Variables**:

- `LAMIX_BASE_URL`
- `LAMIX_API_TOKEN`
- `LAMIX_DEFAULT_OWNER_ADMIN_ID=1`
- `LAMIX_TEST_PANEL_URL=https://panel.lamix.org/test-panel` (SMS Test Panel page/API origin)
- `LAMIX_SESSION_COOKIE` (required if SMS Test Panel is used; use the current authenticated Lamix browser session cookie)
- `LAMIX_CSRF_TOKEN` (if required by the Lamix session)
- `CRON_SECRET` (long random value, used by `/api/cron-sync`)

Do not commit `.env` or real Lamix cookies/tokens to GitHub.

## Important: current JSON database

The current application uses `data/db.json` with synchronous filesystem reads/writes.
Vercel Serverless Functions do **not** provide persistent writable local storage. Therefore the current JSON database must be migrated to a persistent database before production use on Vercel. Deploying the current JSON database unchanged can cause data to reset or fail to save after function restarts.

The Vercel entrypoint and routing are ready, but persistent storage is still a required production migration.

## Background Lamix polling

The local build's 1-second `setInterval` scanner is disabled automatically when `VERCEL` is present. Serverless functions cannot safely run a permanent 1-second background process.

`/api/cron-sync` is provided as a protected scheduled-sync endpoint. Its schedule should be configured according to the hosting plan's cron limits, or an external worker should be used if near-real-time polling is required.

## Local development

```bash
npm start
```

The existing local behavior remains unchanged.


### Vercel handler fix
The Vercel entrypoint exports a request-handler function that forwards requests to the existing Node HTTP server.
