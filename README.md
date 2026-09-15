MrStark SMS V62 — White/Light Default
Based directly on the uploaded V59 ZIP.
Only theme default behavior was changed: LIGHT/WHITE is now the default theme.
Dark mode remains available via the existing theme toggle.
A new theme storage key is used so an older saved dark preference does not force V59's dark default.
Existing data/db.json is preserved.

## Vercel deployment

See `VERCEL_DEPLOYMENT.md`. The project includes `api/index.js` and `vercel.json` for Vercel routing. Before production use, migrate `data/db.json` to persistent database storage because Vercel local function storage is not persistent.
