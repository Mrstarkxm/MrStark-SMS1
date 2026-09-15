# MrStark SMS V65 — Persistent Vercel Storage

V65 keeps the existing JSON-shaped database code, but on Vercel it persists the complete state in a Supabase Postgres table through the Supabase REST API. No npm dependency is required.

## 1. Create the state table in Supabase

Open Supabase SQL Editor and run:

```sql
create table if not exists public.mrstark_state (
  id bigint primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.mrstark_state enable row level security;
```

The application uses the Supabase **service-role key server-side only**, so no browser/frontend code should contain this key.

## 2. Add Vercel environment variables

Add these to Production (and Preview if you want Preview deployments to use the same database):

```text
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

Keep the existing Lamix variables and `CRON_SECRET` as they are.

## 3. First deployment

On the first Vercel request, V65 checks the Supabase table. If no state row exists, it uploads the bundled `data/db.json` as the initial state. Later requests hydrate the in-memory store from Supabase and writes are flushed back before the API request finishes.

## Important

- Never put `SUPABASE_SERVICE_ROLE_KEY` in GitHub or frontend JavaScript.
- Never put Lamix session cookies/CSRF tokens in GitHub either.
- `data/db.json` remains in the ZIP as the local-development/first-deploy fallback.
- This version is a persistence bridge for the current JSON database design. For very high concurrent write volume, the next architectural step would be moving individual entities into normalized Postgres tables rather than storing one JSON document.
