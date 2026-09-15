# MrStark SMS — V51

V51 fixes dashboard payout calculation and updates the My Numbers range picker to show only the ranges returned for the logged-in user, with a Lamix-style searchable dropdown and per-range counts.

# MrStark Sms — Phase 1 + 2 + 3 + Lamix Carrier

Real login/register with a **Super Admin → Admin → Client** hierarchy, real
Number Management + SMS earnings/CDR, and now a real **Rate Card system** —
all on the existing MrStark Sms dark/light UI. Zero external dependencies.

## Phase 3 — Rate Cards
- 🏷️ **Super Admin** publishes a base rate per Country + Operator (their
  reference/cost figure) — visible to every Admin.
- 💵 **Admin** sets their **own** client-facing rate per Country + Operator,
  completely at their discretion ("apni marzi") — the base rate is shown
  next to it purely as a reference so they can see their margin.
- 🔗 Numbers no longer store a fixed rate. Adding a number now requires
  picking a Country/Operator the Admin has already priced in Rate Cards —
  the live rate always comes from the rate card, so updating a rate
  instantly applies to every number (and every future SMS earning) under
  that Country/Operator, with no need to edit numbers one by one.
- 📊 Super Admin also gets an oversight table of every Admin's rate cards
  with base rate, client rate, and margin all in one place.

### Phase 1 — Auth + Hierarchy
- 🔐 Login / Logout (secure sessions via HttpOnly cookies)
- 📝 Public registration (Clients sign up under a chosen Admin/Reseller)
- 👤 Three roles: `super_admin`, `admin`, `client`
- 🧬 Hierarchy: every Client belongs to exactly one Admin (`parentAdminId`).
  Admin 1 can never see or touch Admin 2's clients.
- 🛡️ Protected API routes — every action checks role + ownership server-side
- 🔑 Passwords hashed with `scrypt` (Node's built-in crypto, salted, timing-safe compare)
- 📊 Admin management (Super Admin) — create/suspend admins, see client counts
- 📊 Client management (Admin + Super Admin) — create/suspend clients, edit balance

### Phase 2 — Number Management + SMS Earnings/CDR
Business model: a Client **rents a number** from their Admin's pool, receives
SMS on it, and **earns a per-SMS payout** credited straight to their balance.
CDR entries are logged **manually** by the Admin/Super Admin (no real carrier
connection) — this stays a safe back-office ledger, not a live SMS gateway.

- 📱 **Number inventory** — Admin/Super Admin add numbers (MSISDN, country,
  operator, client earning rate, optional cost) to an Admin's pool
- 🏷️ Numbers are `available` → `assigned` (rented by one client) → back to
  `available`, or `paused` when taken offline
- 🙋 **Self-service rent/release** — a Client can rent any available number
  from their own Admin's pool, or release it back
- 🔗 **Manual assignment** — an Admin can also directly assign/release a
  number to/from one of their own clients
- 📨 **Manual CDR logging** — Admin/Super Admin logs "an SMS arrived" with
  sender/service, an optional note, and Delivered/Failed status
- 💰 **Automatic earnings** — logging a `Delivered` CDR instantly credits the
  renting client's balance by that number's per-SMS rate
- 📊 Dashboard, Number Ranges, and CDR pages now show **real data**, scoped
  by hierarchy (a Client only ever sees their own numbers/CDR; an Admin only
  sees their own clients' numbers/CDR; Super Admin sees everything)

Rates (public rate card) and Payouts (withdrawal requests) pages are still
**demo/mock data** — planned for Phase 3.

## Lamix REST carrier integration

The project now includes a built-in Lamix adapter using Node 18+ `fetch` (no npm package required). It connects to the REST endpoints shown in the Lamix panel: `/ranges`, `/numbers`, and `/cdrs`.

### Configure

Set these server environment variables before starting MrStark Sms:

```bash
export LAMIX_API_TOKEN="your_rotated_token_here"
export LAMIX_BASE_URL="https://panel.lamix.org/api/v1"
# Optional: which Admin owns imported carrier numbers
export LAMIX_DEFAULT_OWNER_ADMIN_ID="1"
# Optional: background sync interval (default 60000 ms)
export LAMIX_POLL_INTERVAL_MS="60000"
node server.js
```

Do **not** put the Lamix token in source code, the ZIP, browser JavaScript, or Git. The Carrier page only reports whether a token is configured; it never displays the token.

### What sync does

- Imports/updates Lamix numbers into MrStark Number Ranges.
- Keeps the Lamix carrier ID/range ID on imported numbers.
- Pulls the recent Lamix CDR feed with a 48-hour overlap and de-duplicates by carrier CDR ID.
- Matches CDRs to MrStark numbers by MSISDN.
- Credits a client's **MrStark Admin rate-card rate** only when the number is assigned to that client and the carrier CDR is Delivered.
- Does not store the raw Lamix CDR payload/message body.
- Provides **Carrier → Test Connection** and **Sync Now** for Super Admins.
- Runs an automatic background sync when `LAMIX_API_TOKEN` is configured.

If a Lamix CDR arrives before a number has been imported or assigned to a client, it is skipped rather than incorrectly credited.


## Requirements

- Node.js 18 or newer (uses only built-in modules: `http`, `fs`, `crypto` — **no `npm install` needed**)

## Run it

```bash
node server.js
```

Then open **http://localhost:3000** in your browser.

Change the port with an environment variable if needed:

```bash
PORT=8080 node server.js
```

## First login

On first run, a `data/db.json` file is created automatically and a default
**Super Admin** account is seeded. The credentials are printed once in your
terminal:

```
Username: superadmin
Password: ChangeMe123!
```

**Change this password immediately** by creating a new super admin flow later,
or manually editing `data/db.json` (Phase 2/3 will add a proper
"change password" screen).

## How the hierarchy works

```
Super Admin
│
├── Admin 1
│   ├── Client A
│   └── Client B
│
└── Admin 2
    └── Client C
```

- **Super Admin**: sees/manages all Admins and all Clients, can assign a new
  client to any admin, can add numbers to any admin's pool.
- **Admin**: sees/manages only their own Clients and their own Numbers
  (enforced by `parentAdminId` / `ownerAdminId` filtering on every request —
  an Admin's session literally cannot fetch or modify another Admin's data,
  even if they guess the ID).
- **Client**: public self-registration always creates a Client account. They
  pick which Admin/Reseller they're signing up under from a dropdown on the
  register page, then can rent numbers only from that Admin's pool.
- Admin and Super Admin accounts are **not** publicly self-registrable —
  only a Super Admin can create Admin accounts, only an Admin (or Super Admin)
  can create Client accounts, via the dashboard.

## How Numbers + CDR work day-to-day

1. Super Admin publishes a base rate for a Country/Operator in **Rates**
   (e.g. UK/Vodafone = $0.02).
2. Admin opens **Rates**, sees that base rate, and sets their own client
   rate for it (e.g. $0.05 — their choice entirely).
3. Admin adds a number in **Number Ranges**, picking that Country/Operator
   from their priced list — the rate is pulled from the rate card automatically.
4. A Client either rents it themselves from "Number Ranges" → Available
   Numbers, or the Admin assigns it to a specific client directly.
5. When a real SMS lands on that number (checked outside this system, e.g.
   in the Admin's own SMPP/carrier panel), the Admin opens "CDR" → **+ Log
   SMS**, picks the number, and marks it Delivered.
6. The client's balance is credited by that Country/Operator's *current*
   admin rate card value automatically. A Failed entry is logged for
   record-keeping but pays nothing.

## Project structure

```
mrstark-app/
├── server.js           # HTTP server + all API routes (no framework)
├── lib/
│   ├── db.js             # JSON-file "database" + hierarchy queries
│   └── hash.js           # Password hashing (scrypt)
├── data/
│   └── db.json           # Auto-created on first run (users, sessions, numbers, cdr)
├── public/
│   ├── login.html / login.js
│   ├── register.html / register.js
│   ├── dashboard.html / dashboard.js   # role-aware SPA-style dashboard
│   ├── style.css
│   └── assets/mrstark-sms-logo.png
└── package.json
```

## Security notes (baseline)

- Passwords: `scrypt` with random 16-byte salt per user, timing-safe compare.
- Sessions: random 256-bit tokens, HttpOnly cookies, 7-day expiry, stored
  server-side (not JWT — so a session can be revoked instantly on logout).
- Every sensitive API route re-checks the session **and** the role **and**
  ownership (`parentAdminId` / `ownerAdminId`) on the server — the frontend
  nav hiding is just UX polish, not the actual security boundary.
- Suspended accounts are blocked at login, not just hidden in the UI.
- Basic input validation on username/email/password (min length, format).
- A number can only be assigned to a client that actually belongs to that
  number's owning Admin — cross-admin assignment is rejected server-side.

### What to harden before real production traffic (flagging honestly)

- `data/db.json` is fine for an MVP/demo but isn't built for concurrent
  writes at scale — plan to migrate to a real database (Postgres/MySQL) once
  you have real traffic. The `lib/db.js` module is the only place that
  touches storage, so this swap is contained.
- Add rate-limiting on `/api/auth/login` and `/api/auth/register` to slow
  down brute-force attempts.
- Add HTTPS (via a reverse proxy like Nginx/Caddy) before deploying — cookies
  are currently sent over plain HTTP in local dev.
- Add a "change password" flow and email verification for registration.
- CDR entry is manual by design in this phase — if you later wire it to a
  real SMPP/carrier feed or webhook, make sure that endpoint has its own
  authentication (an API key per admin, not the session cookie).

## What's next — Phase 4 (suggested)

- Payout requests (client withdraws earned balance) with Admin/Super Admin approval
- Change-password flow + basic audit log of who did what


## Current hierarchy

- **Super Admin**: full platform control; creates Managers, Agents and Clients; assigns carrier ranges; only role with Lamix Carrier/API access.
- **Manager**: creates/manages Agents and Clients within their scope; no Lamix Carrier/API access; cannot create Managers.
- **Agent**: receives assigned ranges/numbers and manages Clients; no Lamix Carrier/API access.
- **Client**: can rent/use numbers made available by their Agent.

Lamix numbers are stored against their imported carrier range (`rangeId`). A range assignment to an Agent automatically moves the range's imported numbers into that Agent's pool.

## Inventory & bulk allocation updates
- Lamix imported range names normalize standalone `LX` to `MRS`; Super Admin can customize the range name and later carrier sync will preserve the custom name.
- Imported numbers remain linked to their Lamix `rangeId`.
- Number inventory is paginated at 25 rows per request.
- Super Admin, Manager, and Agent can allocate available numbers within their scope; Super Admin can allocate to Managers, Agents, or Clients, Managers to their Agents/Clients, and Agents to their own Clients.
- Bulk Add supports multiple recipients and multiple ranges. The configured amount is taken per range per recipient using random, non-overlapping available numbers. Assigned/rented numbers are never reallocated.
- Bulk allocation history is retained locally.
- Range names can only be edited by Super Admin. Range client rates can be edited by the role that manages the range.


## V28 UI/report updates
- Client dashboard hides My Payout and uses Client Payout for payout summaries.
- Client CDR hides My Payout and its totals/export by default.
- Dashboard shows Today/This Week/This Month SMS and payout cards. Week starts Wednesday.
- CDR opens with the default 05:00–04:59 day window and Show Report re-fetches before applying filters.
- Super Admin CDR labels Agent under a Manager as `Agent (Manager)` and direct Manager-owned OTP as `Manager (Manager)`.


## V35 changes
- SMS Ranges: Held is always displayed as 1000 for every range.
- SMS Rate Cards: only Super Admin can edit; Manager/Agent/Client are view-only.
- Weekly Payouts: Managers and Agents can request Wednesday-to-Wednesday payouts, minimum $10, using Binance email or USDT address.
- Super Admin has a payout-request review screen with requester username, role, amount, period and payment information.
- Only Super Admin can edit client balances; Manager/Agent balance editing is blocked server-side and hidden in the UI.


V39: Fixed Super Admin balance save flow. Balance inputs now use explicit DOM references and numeric payloads; manager/agent balance PATCH responses are validated and refreshed after save.


V40 balance fix:
- Manager/Agent dashboards now display their persisted account balance in a "Your Balance" card.
- The dashboard auth/user fetch is explicitly no-cache so a changed Super Admin balance is reflected after reload.
- Super Admin keeps the existing Profit card.
- Backend balance permissions and persistence remain unchanged.


## V42 Payout schedule update
- Payout earnings are counted from the previous payout's Wednesday 05:00 through Tuesday 05:00.
- The completed payout becomes requestable every Wednesday at 05:00.
- Wednesday-to-Wednesday wording/logic is removed.
- Super Admin can always see saved Manager/Agent payout payment details.
- Agents display their parent Manager username in parentheses.
- Existing $10 minimum remains enforced.


V44: merged the additional SMS range/rate/limit block supplied by the user into the permanent master catalogue. Panel names convert LX to MRS while sourceName/masterKey retain Lamix matching data. Existing custom range edits are preserved by the catalog migration.


## V48 Test Panel privilege fix
- Recent Inbound remains the exact Lamix `/api/test-cdrs` feed.
- Only MrStark Super Admin receives optional full CLI/message enrichment from the privileged Lamix CDR API.
- Manager/Agent/Client responses remain masked and do not receive sensitive fields.


V49: SMS Test Panel Test Numbers and Recent Inbound are displayed side-by-side in a responsive two-column grid, matching the Lamix layout.


## V54 changes
- Payouts open every Wednesday from 05:00 to 17:00 local server time.
- Payout calculation runs from the last approved payout boundary through Wednesday 04:59:59; if below $10, it carries forward to the next Wednesday.
- Managers/Agents can set recipient client-facing rates in Bulk Add, but never above the Super Admin range rate. Rates are stored per recipient and range.
- Manager-created direct clients are visible only to that Manager; Agent-created clients are visible only to that Agent.
- Added Users overview for Super Admin and Manager, including Manager grouping, payment details, balances, SMS totals and earned USD.
