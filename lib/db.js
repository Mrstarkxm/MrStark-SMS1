// Simple JSON-file database. No external dependencies.
// Good enough for MVP scale; swap for MySQL/Postgres later without changing
// the calling code much, since all access goes through this module.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword } = require('./hash');
const { MASTER_RANGES } = require('./rangeCatalog');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');
let DB_CACHE = null;
let PERSISTENCE_INIT = null;
let PERSISTENCE_WRITE = Promise.resolve();
let PERSISTENCE_ERROR = null;
let PERSISTENCE_HYDRATING = Boolean(process.env.VERCEL && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

function hasRemotePersistence() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseStateUrl() {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  return `${base}/rest/v1/mrstark_state`;
}

async function remoteGet() {
  const response = await fetch(`${supabaseStateUrl()}?id=eq.1&select=id,data`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) throw new Error(`Supabase GET failed: ${response.status} ${await response.text()}`);
  const rows = await response.json();
  return rows[0]?.data || null;
}

async function remotePut(db) {
  const response = await fetch(supabaseStateUrl(), {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ id: 1, data: db, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`Supabase PUT failed: ${response.status} ${await response.text()}`);
}

function queueRemoteSave(db) {
  if (!hasRemotePersistence()) return PERSISTENCE_WRITE;
  const snapshot = JSON.parse(JSON.stringify(db));
  // Keep the queue alive after an error, but remember the real error so the
  // current API request can report the persistence problem instead of hiding it.
  PERSISTENCE_WRITE = PERSISTENCE_WRITE
    .catch(() => {})
    .then(() => remotePut(snapshot))
    .catch((error) => {
      PERSISTENCE_ERROR = error;
      console.error('Persistent DB write failed:', error.message);
      throw error;
    });
  return PERSISTENCE_WRITE;
}

async function initializePersistentDb() {
  if (!hasRemotePersistence()) return;
  if (PERSISTENCE_INIT) return PERSISTENCE_INIT;
  PERSISTENCE_INIT = (async () => {
    // Start from the bundled JSON so local development and first deployment have a safe fallback.
    PERSISTENCE_HYDRATING = true;
    const local = load();
    PERSISTENCE_HYDRATING = false;
    const remote = await remoteGet();
    if (remote && typeof remote === 'object') {
      DB_CACHE = remote;
      PERSISTENCE_HYDRATING = true;
      // Reuse the existing migration/seed path without writing the read-only Vercel filesystem.
      migrateLoadedDb(DB_CACHE);
      PERSISTENCE_HYDRATING = false;
    } else {
      await remotePut(local);
    }
  })().catch((error) => {
    PERSISTENCE_ERROR = error;
    PERSISTENCE_INIT = null;
    throw error;
  });
  return PERSISTENCE_INIT;
}

async function flushPersistence() {
  await PERSISTENCE_WRITE;
  if (PERSISTENCE_ERROR) throw PERSISTENCE_ERROR;
}

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  MANAGER: 'manager',
  AGENT: 'agent',
  // Backward-compatible alias used by older code paths. Persisted users migrate to agent.
  ADMIN: 'agent',
  CLIENT: 'client',
};

function defaultDb() {
  return {
    nextUserId: 1,
    users: [], // {id, role, username, email, passwordHash, parentAdminId, balance, status, createdAt}
    sessions: [], // {token, userId, expiresAt}
    nextNumberId: 1,
    nextRangeId: 1,
    masterCatalogVersion: 0,
    ranges: [], // {id, carrier, externalId, name, country, operator, rate, assignedManagerId, assignedAgentId, createdAt}
    numbers: [], // {id, msisdn, country, operator, ownerAdminId(agentId), assignedClientId, status, carrier, carrierNumberId, carrierRangeId, createdAt}
    nextCdrId: 1,
    cdr: [], // {id, numberId, msisdn, clientId, adminId, sender, note, earning, status, enteredByUserId, carrier, carrierExternalId, carrierRate, createdAt}
    nextSuperRateCardId: 1,
    superRateCards: [], // {id, country, operator, baseRate, createdAt} - set by Super Admin, visible to all Admins
    nextAdminRateCardId: 1,
    adminRateCards: [], // {id, adminId, country, operator, clientRate, createdAt} - legacy/general Admin client rate
    userRangeRates: [], // {id, userId, rangeId, clientRate, createdAt, updatedAt} - per-user, per-range client-facing rate
    bulkAllocationHistory: [], // {id, createdAt, requesterId, requesterRole, rangeIds, targetIds, amountPerRange, allocated, summary}
    nextBulkAllocationId: 1,
    rangeRequests: [], // {id, rangeId, requesterId, requesterRole, status, createdAt, reviewedBy, reviewedAt}
    nextRangeRequestId: 1,
    payoutRequests: [], // {id, requesterId, requesterRole, username, amount, periodStart, periodEnd, paymentMethod, paymentInfo, status, createdAt, reviewedBy, reviewedAt}
    nextPayoutRequestId: 1,
  };
}

function migrateLoadedDb(db) {
    // Migration: backfill collections added in Phase 2 for DB files created by Phase 1.
  let migrated = false;
  if (!db.numbers) { db.numbers = []; migrated = true; }
  for (const n of db.numbers) {
    if (n.poolOwnerId === undefined) {
      const range = db.ranges?.find(r => String(r.externalId) === String(n.carrierRangeId));
      const holder = n.holderUserId ? db.users.find(u => Number(u.id) === Number(n.holderUserId)) : null;
      n.poolOwnerId = range?.assignedManagerId ? Number(range.assignedManagerId) : (range?.assignedAgentId ? Number(range.assignedAgentId) : (holder?.role === ROLES.MANAGER ? Number(holder.id) : (holder?.role === ROLES.AGENT ? Number(holder.id) : Number(n.ownerAdminId) || null)));
      migrated = true;
    }
    if (n.holderUserId === undefined) { n.holderUserId = n.assignedClientId || null; migrated = true; }
    if (n.holderAssignedAt === undefined) { n.holderAssignedAt = null; migrated = true; }
    if (n.holderRole === undefined) { n.holderRole = n.assignedClientId ? ROLES.CLIENT : null; migrated = true; }
  }
  if (!db.ranges) { db.ranges = []; migrated = true; }
  if (!db.nextRangeId) { db.nextRangeId = 1; migrated = true; }
  // Role migration: old 'admin' accounts are now Agents.
  for (const u of db.users) { if (u.role === 'admin') { u.role = ROLES.AGENT; migrated = true; } if (u.parentManagerId === undefined) { u.parentManagerId = null; migrated = true; } }
  if (!db.nextNumberId) { db.nextNumberId = 1; migrated = true; }
  if (!db.cdr) { db.cdr = []; migrated = true; }
  if (!db.nextCdrId) { db.nextCdrId = 1; migrated = true; }
  if (!db.superRateCards) { db.superRateCards = []; migrated = true; }
  if (!db.nextSuperRateCardId) { db.nextSuperRateCardId = 1; migrated = true; }
  if (!db.adminRateCards) { db.adminRateCards = []; migrated = true; }
  if (!db.userRangeRates) { db.userRangeRates = []; migrated = true; }
  if (!db.bulkAllocationHistory) { db.bulkAllocationHistory = []; migrated = true; }
  if (!db.nextBulkAllocationId) { db.nextBulkAllocationId = 1; migrated = true; }
  if (!db.rangeRequests) { db.rangeRequests = []; migrated = true; }
  if (!db.nextRangeRequestId) { db.nextRangeRequestId = 1; migrated = true; }
  if (!db.payoutRequests) { db.payoutRequests = []; migrated = true; }
  if (!db.nextPayoutRequestId) { db.nextPayoutRequestId = 1; migrated = true; }
  for (const r of db.ranges) { if (r.nameCustomized === undefined) { r.nameCustomized = false; migrated = true; } }
  // Carrier integration fields are additive; older records remain valid.
  for (const n of db.numbers) {
    if (n.carrier === undefined) { n.carrier = null; migrated = true; }
    if (n.carrierNumberId === undefined) { n.carrierNumberId = null; migrated = true; }
    if (n.carrierRangeId === undefined) { n.carrierRangeId = null; migrated = true; }
  }
  for (const r of db.cdr) {
    if (r.carrier === undefined) { r.carrier = null; migrated = true; }
    if (r.carrierExternalId === undefined) { r.carrierExternalId = null; migrated = true; }
    if (r.carrierRate === undefined) { r.carrierRate = null; migrated = true; }
  }
  if (!db.nextAdminRateCardId) { db.nextAdminRateCardId = 1; migrated = true; }

  if (db.masterCatalogVersion === undefined) { db.masterCatalogVersion = 0; migrated = true; }
  // One-time import of the supplied permanent range/rate/limit master list.
  // Existing custom edits are preserved on subsequent loads.
  if (db.masterCatalogVersion < 2) {
    const norm = s => String(s || '').trim().toLowerCase().replace(/\b(lx|mrs)\b/g, 'mrs').replace(/\s+/g, ' ');
    for (const m of MASTER_RANGES) {
      const key = norm(m.sourceName);
      let r = db.ranges.find(x => x.masterKey === key || norm(x.sourceName) === key || norm(x.name) === norm(m.name));
      if (!r) {
        r = {
          id: db.nextRangeId++,
          carrier: 'master',
          externalId: `master-${key}`,
          sourceName: m.sourceName,
          masterKey: key,
          name: m.name,
          country: String(m.name).split(/\s+/)[0] || 'Unknown',
          operator: 'Lamix',
          prefix: m.prefix,
          testNumber: m.testNumber,
          rate: Number(m.rate) || 0,
          superAdminRate: Number(m.rate) || 0,
          clientRate: null,
          limit: m.limit,
          heldRoom: 1000,
          assignedManagerId: null,
          assignedAgentId: null,
          nameCustomized: false,
          rateCustomized: false,
          limitCustomized: false,
          createdAt: new Date().toISOString()
        };
        db.ranges.push(r);
      } else {
        r.masterKey = r.masterKey || key;
        r.sourceName = r.sourceName || m.sourceName;
        r.prefix = r.prefix || m.prefix;
        r.testNumber = r.testNumber || m.testNumber;
        if (r.rate === undefined || r.rate === null) r.rate = Number(m.rate) || 0;
        if (r.superAdminRate === undefined || r.superAdminRate === null) r.superAdminRate = Number(m.rate) || 0;
        if (r.limit === undefined) r.limit = m.limit;
        if (r.heldRoom === undefined) r.heldRoom = 1000;
        // If this is an older Lamix range with no explicit customization marker,
        // load the supplied master rate exactly once.
        if (!r.rateCustomized && !r.nameCustomized) {
          r.superAdminRate = Number(m.rate) || 0;
          r.rate = Number(m.rate) || 0;
        }
      }
    }
    db.masterCatalogVersion = 2;
    migrated = true;
  }
  for (const r of db.ranges) {
    if (r.clientRate === undefined) { r.clientRate = null; migrated = true; }
    // The Super Admin's range payout is kept separately from client-facing pricing.
    // Older builds stored the range payout in clientRate, so migrate that value once.
    if (r.superAdminRate === undefined) {
      r.superAdminRate = r.clientRate != null ? Number(r.clientRate) : Number(r.rate || 0);
      migrated = true;
    }
  }

  for (const r of db.ranges) {
    if (r.heldRoom === undefined) { r.heldRoom = 1000; migrated = true; }
    if (r.rateCustomized === undefined) { r.rateCustomized = false; migrated = true; }
    if (r.limitCustomized === undefined) { r.limitCustomized = false; migrated = true; }
    if (r.masterKey === undefined && r.sourceName) { r.masterKey = String(r.sourceName).trim().toLowerCase().replace(/\b(lx|mrs)\b/g, 'mrs').replace(/\s+/g,' '); migrated = true; }
  }
  if (migrated) save(db);
  DB_CACHE = db;
}

function load() {
  if (DB_CACHE) return DB_CACHE;
  if (!fs.existsSync(DB_PATH)) {
    const db = defaultDb();
    save(db);
    return db;
  }
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  let db;
  try {
    db = JSON.parse(raw);
  } catch (e) {
    console.error('db.json is corrupted, refusing to overwrite. Fix or delete it manually.');
    throw e;
  }
  migrateLoadedDb(db);
  return db;
}

function save(db) {
  DB_CACHE = db;

  // Vercel deployments are mounted under /var/task and are read-only.
  // Never write db.json there, even if an environment flag is unavailable.
  const deployedReadOnly =
    Boolean(process.env.VERCEL) ||
    Boolean(process.env.VERCEL_ENV) ||
    String(DB_PATH || '').startsWith('/var/task/');

  if (deployedReadOnly) {
    if (hasRemotePersistence() && !PERSISTENCE_HYDRATING) {
      queueRemoteSave(db);
    }
    return;
  }

  if (hasRemotePersistence() && !PERSISTENCE_HYDRATING) {
    queueRemoteSave(db);
    return;
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}


// --- Seed a default Super Admin on first run ---
function ensureSeed() {
  const db = load();
  if (db.users.length === 0) {
    const defaultPassword = 'ChangeMe123!';
    const superAdmin = {
      id: db.nextUserId++,
      role: ROLES.SUPER_ADMIN,
      username: 'superadmin',
      email: 'superadmin@mrstark.local',
      passwordHash: hashPassword(defaultPassword),
      parentAdminId: null,
      balance: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    db.users.push(superAdmin);
    save(db);
    console.log('============================================');
    console.log(' First run: Super Admin account created');
    console.log(' Username: superadmin');
    console.log(` Password: ${defaultPassword}`);
    console.log(' -> Please log in and change this password.');
    console.log('============================================');
  }
}

// --- User helpers ---
function findUserByUsername(username) {
  const db = load();
  return db.users.find(
    (u) => u.username.toLowerCase() === String(username).toLowerCase()
  );
}

function findUserByEmail(email) {
  const db = load();
  return db.users.find(
    (u) => String(u.email || '').toLowerCase() === String(email || '').toLowerCase()
  );
}

function findUserById(id) {
  const db = load();
  return db.users.find((u) => u.id === Number(id));
}

function findFirstUserByRole(role) {
  const db = load();
  return db.users.find((u) => u.role === role) || null;
}
function listUsersByRole(role) { const db = load(); return db.users.filter(u => u.role === role); }

function createUser({ role, username, email, password, parentAdminId, parentManagerId }) {
  const db = load();
  const exists = db.users.some(
    (u) =>
      u.username.toLowerCase() === username.toLowerCase() ||
      (email && u.email && u.email.toLowerCase() === String(email).toLowerCase())
  );
  if (exists) {
    const err = new Error('Username or email already exists');
    err.code = 'DUPLICATE';
    throw err;
  }
  const user = {
    id: db.nextUserId++,
    role,
    username,
    email,
    passwordHash: hashPassword(password),
    parentAdminId: parentAdminId || null,
    parentManagerId: parentManagerId || null,
    balance: 0,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  save(db);
  return user;
}

function updateUser(id, patch) {
  const db = load();
  const user = db.users.find((u) => u.id === Number(id));
  if (!user) return null;
  Object.assign(user, patch);
  save(db);
  return user;
}

function adjustUserBalance(id, delta) {
  const db = load();
  const user = db.users.find((u) => u.id === Number(id));
  if (!user) return null;
  user.balance = Math.round((Number(user.balance) + Number(delta)) * 100) / 100;
  save(db);
  return user;
}

function listAdmins() {
  const db = load();
  return db.users
    .filter((u) => u.role === ROLES.AGENT)
    .map((a) => {
      const clientCount = db.users.filter(
        (u) => u.role === ROLES.CLIENT && u.parentAdminId === a.id
      ).length;
      const manager = a.parentManagerId ? db.users.find(u => u.id === a.parentManagerId) : null;
      return { ...a, managerUsername: manager ? manager.username : null, clientCount };
    });
}

function listActiveAdminsPublic() {
  // Used for the public registration dropdown - no sensitive fields.
  const db = load();
  return db.users
    .filter((u) => u.role === ROLES.AGENT && u.status === 'active')
    .map((a) => ({ id: a.id, username: a.username }));
}

function listClients({ scopeAdminId, scopeManagerId } = {}) {
  const db = load();
  let clients = db.users.filter((u) => u.role === ROLES.CLIENT);
  if (scopeAdminId) {
    // An Agent sees only clients created/owned by that Agent.
    clients = clients.filter((c) => Number(c.parentAdminId) === Number(scopeAdminId));
  }
  if (scopeManagerId) {
    // A Manager sees only clients created directly by that Manager.
    // Clients created by one of the Manager's Agents belong only to that Agent.
    clients = clients.filter((c) => Number(c.parentManagerId) === Number(scopeManagerId) && !c.parentAdminId);
  }
  return clients.map((c) => {
    const admin = db.users.find((u) => Number(u.id) === Number(c.parentAdminId));
    const manager = c.parentManagerId
      ? db.users.find(u => Number(u.id) === Number(c.parentManagerId))
      : (admin?.parentManagerId ? db.users.find(u => Number(u.id) === Number(admin.parentManagerId)) : null);
    return {
      ...c,
      adminUsername: admin ? admin.username : null,
      agentUsername: admin ? admin.username : null,
      managerUsername: manager ? manager.username : null
    };
  });
}

// --- Rate Card helpers ---
// Super Admin publishes a base rate per Country+Operator (their reference /
// cost figure). Each Admin then sets their OWN client-facing rate for any
// Country+Operator the Super Admin has published - this is what their
// clients actually earn per SMS. Numbers don't store a rate themselves;
// it's always resolved live from the owning Admin's rate card so an Admin
// can adjust their pricing in one place and it applies everywhere at once.

function keyOf(country, operator) {
  return `${String(country).trim().toLowerCase()}|${String(operator).trim().toLowerCase()}`;
}

function createOrUpdateSuperRateCard({ country, operator, baseRate }) {
  const db = load();
  const k = keyOf(country, operator);
  let card = db.superRateCards.find((c) => keyOf(c.country, c.operator) === k);
  if (card) {
    card.baseRate = Number(baseRate);
  } else {
    card = {
      id: db.nextSuperRateCardId++,
      country,
      operator,
      baseRate: Number(baseRate),
      createdAt: new Date().toISOString(),
    };
    db.superRateCards.push(card);
  }
  save(db);
  return card;
}

function listSuperRateCards() {
  const db = load();
  return db.superRateCards;
}

function findSuperRateCard(country, operator) {
  const db = load();
  const k = keyOf(country, operator);
  return db.superRateCards.find((c) => keyOf(c.country, c.operator) === k);
}

function createOrUpdateAdminRateCard({ adminId, country, operator, clientRate }) {
  const db = load();
  const base = db.superRateCards.find((c) => keyOf(c.country, c.operator) === keyOf(country, operator));
  if (!base) {
    const err = new Error('Super Admin has not published a base rate for this country/operator yet');
    err.code = 'NO_BASE_RATE';
    throw err;
  }
  const k = keyOf(country, operator);
  const requestedRate = Number(clientRate);
  if (!Number.isFinite(requestedRate) || requestedRate < 0) {
    const err = new Error('Client rate must be a valid non-negative number');
    err.code = 'BAD_RATE';
    throw err;
  }
  if (requestedRate > Number(base.baseRate) + 1e-12) {
    const err = new Error(`Client rate cannot exceed the Super Admin actual rate of ${Number(base.baseRate).toFixed(4)}`);
    err.code = 'RATE_EXCEEDS_BASE';
    throw err;
  }
  let card = db.adminRateCards.find((c) => c.adminId === Number(adminId) && keyOf(c.country, c.operator) === k);
  if (card) {
    card.clientRate = requestedRate;
  } else {
    card = {
      id: db.nextAdminRateCardId++,
      adminId: Number(adminId),
      country,
      operator,
      clientRate: requestedRate,
      createdAt: new Date().toISOString(),
    };
    db.adminRateCards.push(card);
  }
  save(db);
  return card;
}

function listAdminRateCards({ scopeAdminId } = {}) {
  const db = load();
  let cards = db.adminRateCards;
  if (scopeAdminId) {
    cards = cards.filter((c) => c.adminId === Number(scopeAdminId));
  }
  return cards.map((c) => {
    const admin = db.users.find((u) => u.id === c.adminId);
    const base = db.superRateCards.find((b) => keyOf(b.country, b.operator) === keyOf(c.country, c.operator));
    return {
      ...c,
      adminUsername: admin ? admin.username : null,
      baseRate: base ? base.baseRate : null,
      margin: base ? Math.round((c.clientRate - base.baseRate) * 10000) / 10000 : null,
    };
  });
}

function findAdminRateCardById(id) {
  const db = load();
  return db.adminRateCards.find((c) => c.id === Number(id));
}

function findAdminRateCard(adminId, country, operator) {
  const db = load();
  const k = keyOf(country, operator);
  return db.adminRateCards.find((c) => c.adminId === Number(adminId) && keyOf(c.country, c.operator) === k);
}

function getUserRangeRate(userId, rangeId) {
  const db = load();
  const row = (db.userRangeRates || []).find(r =>
    Number(r.userId) === Number(userId) && Number(r.rangeId) === Number(rangeId)
  );
  return row && Number.isFinite(Number(row.clientRate)) ? Number(row.clientRate) : null;
}

function setUserRangeRate(userId, rangeId, clientRate) {
  const db = load();
  if (!db.userRangeRates) db.userRangeRates = [];
  const uid = Number(userId), rid = Number(rangeId), rate = Number(clientRate);
  let row = db.userRangeRates.find(r => Number(r.userId) === uid && Number(r.rangeId) === rid);
  if (row) {
    row.clientRate = rate;
    row.updatedAt = new Date().toISOString();
  } else {
    row = {
      id: `${uid}-${rid}`,
      userId: uid,
      rangeId: rid,
      clientRate: rate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.userRangeRates.push(row);
  }
  save(db);
  return row;
}

// The live rate a client earns per SMS on a given number, resolved from
// their owning Admin's current rate card. Falls back to 0 if the Admin
// hasn't priced that country/operator (shouldn't normally happen, since
// number creation requires a rate card to already exist).
function resolveClientRate(number, clientId = null) {
  const db = load();
  const cid = clientId || number?.assignedClientId || null;
  const client = cid ? db.users.find(u => Number(u.id) === Number(cid)) : null;
  // Client-facing pricing belongs to the Admin/Agent/Manager serving the
  // client. Prefer that rate card over the range fallback so a rate set by an
  // Agent for its clients is actually shown on the Client's Numbers/CDR.
  const adminId = client?.parentAdminId || client?.parentManagerId || null;
  const range = number?.carrierRangeId != null
    ? findRangeForCdrValue(db, number.carrierRangeId)
    : (number?.rangeId != null ? db.ranges.find(r => Number(r.id) === Number(number.rangeId)) : null);
  if (adminId && range) {
    const rangeRate = getUserRangeRate(adminId, range.id);
    if (rangeRate != null) return rangeRate;
  }
  if (adminId) {
    const card = findAdminRateCard(adminId, number.country, number.operator);
    if (card && Number.isFinite(Number(card.clientRate))) return Number(card.clientRate);
  }
  if (range && range.clientRate != null && Number.isFinite(Number(range.clientRate))) return Number(range.clientRate);
  const fallbackAdminId = number?.ownerAdminId || null;
  if (!fallbackAdminId) return 0;
  const card = findAdminRateCard(fallbackAdminId, number.country, number.operator);
  return card ? Number(card.clientRate) : 0;
}

// --- Carrier number-range helpers ---
function upsertCarrierRange({ carrier = 'lamix', externalId, name, sourceName = name, country, operator, rate = 0 }) {
  const db = load();
  const ext = externalId == null ? null : String(externalId);
  const norm = s => String(s || '').trim().toLowerCase().replace(/\b(lx|mrs)\b/g, 'mrs').replace(/\s+/g, ' ');
  const masterKey = norm(sourceName || name);
  let range = db.ranges.find(r => r.carrier === carrier && String(r.externalId) === String(ext));
  if (!range) range = db.ranges.find(r => r.masterKey === masterKey || norm(r.sourceName) === masterKey || norm(r.name) === masterKey);
  if (range) {
    range.carrier = carrier;
    range.externalId = ext;
    range.sourceName = sourceName || range.sourceName;
    range.masterKey = range.masterKey || masterKey;
    Object.assign(range, { country: country || range.country, operator: operator || range.operator });
    if (!range.nameCustomized) range.name = String(name || range.name || ext || 'Unnamed range').replace(/\bLX\b/g, 'MRS');
    // Lamix carrier rate is kept as carrierRate; the permanent Super Admin rate
    // from the master catalog is not overwritten by every sync.
    range.carrierRate = Number(rate) || 0;
    if (range.clientRate === undefined) range.clientRate = null;
    if (range.superAdminRate === undefined) range.superAdminRate = range.rate != null ? Number(range.rate) : Number(rate) || 0;
    if (range.heldRoom === undefined) range.heldRoom = 1000;
  } else {
    range = {
      id: db.nextRangeId++, carrier, externalId: ext, sourceName: sourceName || name,
      masterKey, name: String(name || ext || 'Unnamed range').replace(/\bLX\b/g, 'MRS'),
      country: country || 'Unknown', operator: operator || 'Unknown',
      rate: Number(rate) || 0, carrierRate: Number(rate) || 0,
      assignedManagerId: null, assignedAgentId: null, clientRate: null,
      superAdminRate: Number(rate) || 0, nameCustomized: false, rateCustomized: false,
      limit: null, heldRoom: 1000, createdAt: new Date().toISOString()
    };
    db.ranges.push(range);
  }
  save(db);
  return range;
}
function listRanges({ scopeManagerId, scopeAgentId, scopeClientId, viewerUserId, viewerRole, includeAll = false } = {}) {
  const db = load();
  let ranges = db.ranges;
  // A range is visible to a reseller when it is explicitly assigned OR when
  // that reseller currently holds at least one number from the range. This
  // keeps direct Super Admin number allocations usable in the reseller UI.
  if (scopeManagerId) {
    const managerId = Number(scopeManagerId);
    const agentIds = db.users.filter(u => u.role === ROLES.AGENT && Number(u.parentManagerId) === managerId).map(u => Number(u.id));
    const heldRangeIds = new Set(db.numbers.filter(n => Number(n.holderUserId) === managerId || agentIds.includes(Number(n.holderUserId)) || Number(n.ownerAdminId) === managerId || agentIds.includes(Number(n.ownerAdminId))).map(n => String(n.carrierRangeId)));
    ranges = ranges.filter(r => r.assignedManagerId === managerId || (r.assignedAgentId && agentIds.includes(Number(r.assignedAgentId))) || heldRangeIds.has(String(r.externalId)));
  }
  if (scopeAgentId && !includeAll) {
    const agentId = Number(scopeAgentId);
    const heldRangeIds = new Set(db.numbers.filter(n =>
      Number(n.holderUserId) === agentId ||
      Number(n.ownerAdminId) === agentId ||
      (n.assignedClientId && db.users.find(u => Number(u.id) === Number(n.assignedClientId))?.parentAdminId === agentId)
    ).map(n => String(n.carrierRangeId)));
    ranges = ranges.filter(r => Number(r.assignedAgentId) === agentId || heldRangeIds.has(String(r.externalId)));
  }
  if (scopeClientId && !includeAll) {
    const clientId = Number(scopeClientId);
    const client = db.users.find(u => Number(u.id) === clientId);
    const agentId = client?.parentAdminId ? Number(client.parentAdminId) : null;
    const managerId = client?.parentManagerId ? Number(client.parentManagerId) : null;
    const heldRangeIds = new Set(db.numbers.filter(n =>
      Number(n.holderUserId) === clientId ||
      Number(n.assignedClientId) === clientId
    ).map(n => String(n.carrierRangeId)));
    ranges = ranges.filter(r =>
      heldRangeIds.has(String(r.externalId)) ||
      (agentId && Number(r.assignedAgentId) === agentId) ||
      (managerId && Number(r.assignedManagerId) === managerId)
    );
  }
  const counts = new Map();
  const numbersByRange = new Map();
  for (const n of db.numbers) {
    const key = String(n.carrierRangeId);
    const item = counts.get(key) || { count: 0, available: 0 };
    item.count += 1;
    if (n.status === 'available' && !n.holderUserId) item.available += 1;
    counts.set(key, item);
    if (!numbersByRange.has(key)) numbersByRange.set(key, []);
    numbersByRange.get(key).push(n);
    if (n.rangeId != null && String(n.rangeId) !== key) {
      const idKey=String(n.rangeId);
      if (!numbersByRange.has(idKey)) numbersByRange.set(idKey, []);
      numbersByRange.get(idKey).push(n);
    }
  }
  return ranges.map(r => {
    const manager = r.assignedManagerId ? db.users.find(u => u.id === r.assignedManagerId) : null;
    const agent = r.assignedAgentId ? db.users.find(u => u.id === r.assignedAgentId) : null;
    const c = counts.get(String(r.externalId)) || { count: 0, available: 0 };
    const rangeNumbers = [...new Map((numbersByRange.get(String(r.externalId)) || []).concat(numbersByRange.get(String(r.id)) || []).map(n => [n.id,n])).values()];
    let heldCount = rangeNumbers.filter(n => n.status === 'assigned' || n.assignedClientId || n.holderUserId).length;
    if (viewerUserId) {
      const vid = Number(viewerUserId);
      if (viewerRole === ROLES.CLIENT) {
        heldCount = rangeNumbers.filter(n => Number(n.assignedClientId) === vid || Number(n.holderUserId) === vid).length;
      } else if (viewerRole === ROLES.AGENT) {
        const clientIds = new Set(db.users.filter(u => u.role === ROLES.CLIENT && Number(u.parentAdminId) === vid).map(u => Number(u.id)));
        heldCount = rangeNumbers.filter(n => Number(n.holderUserId) === vid || Number(n.ownerAdminId) === vid || clientIds.has(Number(n.assignedClientId))).length;
      } else if (viewerRole === ROLES.MANAGER) {
        const agentIds = new Set(db.users.filter(u => u.role === ROLES.AGENT && Number(u.parentManagerId) === vid).map(u => Number(u.id)));
        const clientIds = new Set(db.users.filter(u => u.role === ROLES.CLIENT && (Number(u.parentManagerId) === vid || agentIds.has(Number(u.parentAdminId)))).map(u => Number(u.id)));
        heldCount = rangeNumbers.filter(n => Number(n.holderUserId) === vid || Number(n.ownerAdminId) === vid || agentIds.has(Number(n.holderUserId)) || agentIds.has(Number(n.ownerAdminId)) || clientIds.has(Number(n.assignedClientId))).length;
      }
    }
    const sample = rangeNumbers[0];
    const testNumber = sample?.msisdn || '';
    const prefix = r.prefix || (testNumber ? String(testNumber).replace(/^\+/, '').slice(0, 3) : '');
    const superAdminRate = r.superAdminRate == null ? Number(r.rate || 0) : Number(r.superAdminRate);
    let viewerClientRate = r.clientRate == null ? null : Number(r.clientRate);
    if (viewerUserId && viewerRole !== ROLES.SUPER_ADMIN) {
      const rangeRate = getUserRangeRate(viewerUserId, r.id);
      if (rangeRate != null) viewerClientRate = rangeRate;
      else {
        const card = findAdminRateCard(viewerUserId, r.country, r.operator);
        if (card && Number.isFinite(Number(card.clientRate))) viewerClientRate = Number(card.clientRate);
      }
    }
    return { ...r, heldRoom: 1000, limit: r.limit || '—', clientRate: viewerClientRate, superAdminRate, effectiveRate: viewerClientRate != null ? viewerClientRate : superAdminRate, managerUsername: manager?.username || null, agentUsername: agent?.username || null, numberCount: c.count, availableCount: c.available, heldCount, roomCount: 1000, testNumber, prefix };
  });
}

function listUserNumberRanges(userId, role) {
  const db = load();
  const uid = Number(userId);
  const user = db.users.find(u => Number(u.id) === uid);
  if (!user) return [];
  const visible = db.numbers.filter(n => {
    if (role === ROLES.SUPER_ADMIN) return true;
    if (role === ROLES.CLIENT) return Number(n.assignedClientId) === uid || Number(n.holderUserId) === uid;
    if (role === ROLES.AGENT) {
      const client = n.assignedClientId ? db.users.find(u => Number(u.id) === Number(n.assignedClientId)) : null;
      return Number(n.ownerAdminId) === uid || Number(n.poolOwnerId) === uid || Number(n.holderUserId) === uid || Number(client?.parentAdminId) === uid;
    }
    if (role === ROLES.MANAGER) {
      const agent = n.ownerAdminId ? db.users.find(u => Number(u.id) === Number(n.ownerAdminId)) : null;
      const holder = n.holderUserId ? db.users.find(u => Number(u.id) === Number(n.holderUserId)) : null;
      const client = n.assignedClientId ? db.users.find(u => Number(u.id) === Number(n.assignedClientId)) : null;
      return Number(n.ownerAdminId) === uid || Number(n.poolOwnerId) === uid || Number(n.holderUserId) === uid || Number(agent?.parentManagerId) === uid || Number(holder?.parentManagerId) === uid || Number(client?.parentManagerId) === uid;
    }
    return false;
  });
  const rangeByExt = new Map(db.ranges.map(r => [String(r.externalId), r]));
  const rangeById = new Map(db.ranges.map(r => [Number(r.id), r]));
  const seen = new Map();
  for (const n of visible) {
    const r = rangeByExt.get(String(n.carrierRangeId)) || rangeById.get(Number(n.rangeId));
    const key = r ? String(r.id) : `direct-${n.id}`;
    if (!seen.has(key)) seen.set(key, { id: r?.id ?? key, externalId: r?.externalId ?? null, name: r?.name || 'Direct allocation', count: 0 });
    seen.get(key).count++;
  }
  return [...seen.values()].sort((a,b) => a.name.localeCompare(b.name));
}

function getDashboardStats(userId, role) {
  const db = load();
  const uid = Number(userId);
  const now = new Date();
  const startToday = new Date(now); startToday.setHours(0,0,0,0);
  const startWeek = new Date(startToday); startWeek.setDate(startWeek.getDate() - ((startToday.getDay()-3+7)%7));
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const userById = new Map(db.users.map(u=>[Number(u.id),u]));
  const numberById = new Map(db.numbers.map(n=>[Number(n.id),n]));
  const inScope = n => {
    if (role === ROLES.SUPER_ADMIN) return true;
    if (role === ROLES.CLIENT) return Number(n.assignedClientId) === uid;
    const client = n.assignedClientId ? userById.get(Number(n.assignedClientId)) : null;
    if (role === ROLES.AGENT) return Number(n.ownerAdminId)===uid || Number(n.poolOwnerId)===uid || Number(client?.parentAdminId)===uid;
    if (role === ROLES.MANAGER) { const agent= n.ownerAdminId ? userById.get(Number(n.ownerAdminId)) : null; return Number(n.ownerAdminId)===uid || Number(n.poolOwnerId)===uid || Number(agent?.parentManagerId)===uid || Number(client?.parentManagerId)===uid; }
    return false;
  };
  let active=0;
  for (const n of db.numbers) if (inScope(n) && (n.status==='available'||n.status==='assigned')) active++;
  const cdr = db.cdr;
  const cdrInScope = r => {
    if (role===ROLES.SUPER_ADMIN) return true;
    if (role===ROLES.CLIENT) return Number(r.clientId)===uid;
    const client=r.clientId ? userById.get(Number(r.clientId)) : null;
    if (role===ROLES.AGENT) return Number(client?.parentAdminId)===uid;
    if (role===ROLES.MANAGER) { if (Number(client?.parentManagerId)===uid) return true; const agent=client?.parentAdminId ? userById.get(Number(client.parentAdminId)) : null; return Number(agent?.parentManagerId)===uid; }
    return false;
  };
  const relevant=cdr.filter(cdrInScope);
  // Dashboard payout must use the configured Super Admin/range rate when the
  // carrier CDR does not provide a payout value. Lamix imports often have
  // carrierRate=0 while the range itself has the real configured rate.
  const payoutValue = r => {
    if (role === ROLES.CLIENT) return Number(r.clientRateSnapshot ?? r.earning ?? 0);
    const num = numberById.get(Number(r.numberId));
    let range = num ? (db.ranges.find(x => String(x.externalId) === String(num.carrierRangeId)) || db.ranges.find(x => Number(x.id) === Number(num.rangeId))) : null;
    if (!range && num?.carrierRangeId) range = findRangeForCdrValue(db, num.carrierRangeId);
    if (!range && num?.rangeName) range = findRangeForCdrValue(db, num.rangeName);
    if (!range && r.rawCarrierRecord) range = findRangeForCdrValue(db, r.rawCarrierRecord.rangeName || r.rawCarrierRecord.range_name || r.rawCarrierRecord.range);
    const configured = Number(range?.superAdminRate ?? range?.rate ?? 0);
    const carrier = Number(r.carrierRate ?? 0);
    return configured > 0 ? configured : carrier;
  };
  const period = start => { const rows=relevant.filter(r=>{const t=new Date(r.createdAt).getTime(); return t>=start.getTime()&&t<=now.getTime();}); return {sms:rows.length,payout:rows.reduce((a,r)=>a+payoutValue(r),0),clientPayout:rows.reduce((a,r)=>a+Number(r.clientRateSnapshot ?? r.earning ?? 0),0),successful:rows.filter(r=>r.status==='Delivered'||r.status==='Success').length}; };
  return { activeNumbers:active, today:period(startToday), week:period(startWeek), month:period(startMonth), balance: role==='super_admin' ? 0 : Number(userById.get(uid)?.balance||0) };
}

function createLocalRange({ name, country, operator, clientRate, managerId = null, agentId = null }) {
  const db = load();
  const range = {
    id: db.nextRangeId++, carrier: 'manual', externalId: `local-${Date.now()}-${db.nextRangeId}`,
    name: String(name || '').trim(), country: String(country || '').trim(), operator: String(operator || '').trim(),
    rate: Number(clientRate) || 0, clientRate: null, superAdminRate: Number(clientRate) || 0, assignedManagerId: managerId ? Number(managerId) : null, assignedAgentId: agentId ? Number(agentId) : null,
    createdAt: new Date().toISOString()
  };
  db.ranges.push(range); save(db); return range;
}
function importManualNumbersToRange({ rangeId, numbers, ownerAdminId }) {
  const db = load();
  const range = db.ranges.find(r => Number(r.id) === Number(rangeId));
  if (!range) { const e=new Error('Range not found'); e.code='NOT_FOUND'; throw e; }
  const byMsisdn = new Map(db.numbers.map(n => [String(n.msisdn).trim(), n]));
  let imported=0, skipped=0;
  const clean = [];
  for (const raw of (numbers || [])) {
    const msisdn = String(raw || '').trim().replace(/[\s,;]+/g,'');
    if (!msisdn || msisdn.length < 5) { skipped++; continue; }
    if (byMsisdn.has(msisdn)) { skipped++; continue; }
    if (clean.includes(msisdn)) { skipped++; continue; }
    clean.push(msisdn);
  }
  const owner = Number(ownerAdminId);
  for (const msisdn of clean) {
    const n={ id:db.nextNumberId++, msisdn, country:range.country||'Unknown', operator:range.operator||'Manual', ownerAdminId:owner, poolOwnerId:owner, assignedClientId:null, holderUserId:null, holderRole:null, status:'available', carrier:'manual', carrierNumberId:null, carrierRangeId:range.externalId, rangeId:range.id, createdAt:new Date().toISOString() };
    db.numbers.push(n); byMsisdn.set(msisdn,n); imported++;
  }
  save(db);
  return { imported, skipped, range };
}

function updateRange(id, patch) {
  const db = load(); const range = db.ranges.find(r => r.id === Number(id)); if (!range) return null;
  if (patch.name !== undefined) { range.name = String(patch.name).trim(); range.nameCustomized = true; }
  if (patch.country !== undefined) range.country = String(patch.country).trim();
  if (patch.operator !== undefined) range.operator = String(patch.operator).trim();
  if (patch.clientRate !== undefined) range.clientRate = Number(patch.clientRate);
  if (patch.superAdminRate !== undefined) { range.superAdminRate = Number(patch.superAdminRate); range.rate = Number(patch.superAdminRate); range.rateCustomized = true; }
  if (patch.assignedManagerId !== undefined) range.assignedManagerId = patch.assignedManagerId ? Number(patch.assignedManagerId) : null;
  if (patch.assignedAgentId !== undefined) range.assignedAgentId = patch.assignedAgentId ? Number(patch.assignedAgentId) : null;
  if (patch.limit !== undefined) { range.limit = String(patch.limit).trim(); range.limitCustomized = true; }
  save(db); return range;
}
function findRangeById(id) { return load().ranges.find(r => r.id === Number(id)); }
function assignRange(id, { managerId = null, agentId = null }) {
  const db = load();
  const range = db.ranges.find(r => r.id === Number(id));
  if (!range) return null;
  range.assignedManagerId = managerId ? Number(managerId) : null;
  range.assignedAgentId = agentId ? Number(agentId) : null;
  const ownerId = agentId ? Number(agentId) : (managerId ? Number(managerId) : null);
  const superAdminId = db.users.find(u => u.role === ROLES.SUPER_ADMIN)?.id || null;
  for (const n of db.numbers) {
    if (n.carrier !== range.carrier || String(n.carrierRangeId) !== String(range.externalId) || n.holderUserId || n.assignedClientId) continue;
    n.ownerAdminId = ownerId || superAdminId || n.ownerAdminId;
    n.poolOwnerId = ownerId || superAdminId || n.poolOwnerId || n.ownerAdminId;
  }
  save(db);
  return range;
}

function listAssignableTargets(requester) {
  const db = load();
  if (!requester) return [];
  if (requester.role === ROLES.SUPER_ADMIN) return db.users.filter(u => [ROLES.MANAGER, ROLES.AGENT, ROLES.CLIENT].includes(u.role) && u.status === 'active');
  if (requester.role === ROLES.MANAGER) {
    const agentIds = db.users.filter(u => u.role === ROLES.AGENT && u.parentManagerId === requester.id).map(u => u.id);
    return db.users.filter(u => u.status === 'active' && ((u.role === ROLES.AGENT && agentIds.includes(u.id)) || (u.role === ROLES.CLIENT && (u.parentManagerId === requester.id || agentIds.includes(Number(u.parentAdminId))))));
  }
  if (requester.role === ROLES.AGENT) return db.users.filter(u => u.role === ROLES.CLIENT && u.status === 'active' && Number(u.parentAdminId) === Number(requester.id));
  return [];
}

function bulkAllocateNumbers({ requester, rangeIds, targetUserIds, amountPerRange, rangeRates = {} }) {
  const db = load();
  const targets = listAssignableTargets(requester);
  const targetMap = new Map(targets.map(u => [Number(u.id), u]));
  const requestedTargets = [...new Set((targetUserIds || []).map(Number).filter(Number.isFinite))].map(id => targetMap.get(id)).filter(Boolean);
  const ranges = db.ranges.filter(r => (rangeIds || []).map(Number).includes(Number(r.id)));
  if (!requestedTargets.length) throw Object.assign(new Error('Select at least one active Agent, Manager or Client in your scope'), { code: 'BAD_TARGETS' });
  if (!ranges.length) throw Object.assign(new Error('Select at least one range'), { code: 'BAD_RANGES' });
  const amount = Math.floor(Number(amountPerRange));
  if (!Number.isFinite(amount) || amount < 1 || amount > 100000) throw Object.assign(new Error('Enter a valid number amount per selected range'), { code: 'BAD_AMOUNT' });

  // Only ranges visible to the requester may be used. Super Admin can use all ranges.
  const allowedRanges = requester.role === ROLES.SUPER_ADMIN ? ranges : ranges.filter(r =>
    (requester.role === ROLES.MANAGER && (Number(r.assignedManagerId) === Number(requester.id) || (r.assignedAgentId && db.users.find(u => u.id === r.assignedAgentId)?.parentManagerId === requester.id))) ||
    (requester.role === ROLES.AGENT && Number(r.assignedAgentId) === Number(requester.id))
  );
  if (allowedRanges.length !== ranges.length) throw Object.assign(new Error('One or more selected ranges are outside your scope'), { code: 'BAD_RANGES' });

  // Rate authority: Super Admin publishes the ceiling. Managers/Agents may
  // set the client-facing rate for every recipient they selected, but never
  // above that range's Super Admin rate. Rates are stored per recipient +
  // range so one user's price never overwrites another user's price.
  const suppliedRates = rangeRates || {};
  for (const range of ranges) {
    if (!Object.prototype.hasOwnProperty.call(suppliedRates, String(range.id))) continue;
    const rate = Number(suppliedRates[String(range.id)]);
    if (!Number.isFinite(rate) || rate < 0) {
      throw Object.assign(new Error(`Invalid rate for range ${range.name}`), { code: 'BAD_RANGES' });
    }
    if (requester.role === ROLES.SUPER_ADMIN) {
      range.superAdminRate = rate;
      range.rate = rate;
      continue;
    }
    const actualRate = Number(range.superAdminRate ?? range.rate ?? 0);
    if (rate > actualRate + 1e-12) {
      throw Object.assign(
        new Error(`Rate for ${range.name} cannot exceed the Super Admin rate (${actualRate.toFixed(4)}).`),
        { code: 'FORBIDDEN_RATE' }
      );
    }
    // Apply the selected rate to every selected recipient. A Manager can set
    // an Agent's rate; an Agent can set their Clients' rates.
    for (const target of requestedTargets) {
      const pricingOwnerId = target.role === ROLES.CLIENT
        ? (target.parentAdminId || target.parentManagerId || null)
        : target.id;
      if (!pricingOwnerId) continue;
      setUserRangeRate(pricingOwnerId, range.id, rate);
      // Keep the legacy country/operator card in sync for screens that still
      // use the older general rate-card representation.
      const base = db.superRateCards.find(c =>
        keyOf(c.country, c.operator) === keyOf(range.country, range.operator)
      );
      if (base) {
        let card = db.adminRateCards.find(c =>
          Number(c.adminId) === Number(pricingOwnerId) &&
          keyOf(c.country, c.operator) === keyOf(range.country, range.operator)
        );
        if (card) card.clientRate = rate;
        else db.adminRateCards.push({
          id: db.nextAdminRateCardId++,
          adminId: Number(pricingOwnerId),
          country: range.country,
          operator: range.operator,
          clientRate: rate,
          createdAt: new Date().toISOString()
        });
      }
    }
  }

  const availableByRange = new Map();
  for (const range of ranges) {
    const pool = db.numbers.filter(n => {
      if (String(n.carrierRangeId) !== String(range.externalId) || n.status !== 'available' || n.assignedClientId) return false;
      const holderOk = !n.holderUserId || Number(n.holderUserId) === Number(requester.id);
      const poolOwner = n.poolOwnerId == null ? null : Number(n.poolOwnerId);
      const ownerOk = requester.role === ROLES.SUPER_ADMIN ? (!n.holderUserId && (poolOwner == null || poolOwner === Number(requester.id) || Number(n.ownerAdminId) === Number(requester.id))) : (poolOwner === Number(requester.id) || Number(n.holderUserId) === Number(requester.id));
      return holderOk && ownerOk;
    });
    // Fisher-Yates shuffle: each target gets a different random slice.
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    availableByRange.set(range.id, pool);
  }

  const allocations = [];
  for (const target of requestedTargets) {
    for (const range of ranges) {
      const pool = availableByRange.get(range.id);
      const take = Math.min(amount, pool.length);
      const picked = pool.splice(0, take);
      for (const n of picked) {
        if (requester.role === ROLES.SUPER_ADMIN && (n.poolOwnerId == null || Number(n.poolOwnerId) === Number(requester.id))) n.poolOwnerId = target.role === ROLES.CLIENT ? (target.parentAdminId || target.parentManagerId || target.id) : target.id;
        else if (n.poolOwnerId == null) n.poolOwnerId = requester.id;
        n.holderUserId = target.id;
        n.holderRole = target.role;
        n.holderAssignedAt = new Date().toISOString();
        if (target.role === ROLES.CLIENT) {
          n.assignedClientId = target.id;
          n.status = 'assigned';
          n.ownerAdminId = target.parentAdminId ? Number(target.parentAdminId) : (target.parentManagerId ? Number(target.parentManagerId) : n.ownerAdminId);
        } else {
          n.assignedClientId = null;
          n.status = 'available';
          if (requester.role === ROLES.SUPER_ADMIN) n.ownerAdminId = target.id;
          if (target.role === ROLES.AGENT) {
            range.assignedAgentId = target.id;
            if (target.parentManagerId) range.assignedManagerId = Number(target.parentManagerId);
          } else if (target.role === ROLES.MANAGER) {
            range.assignedManagerId = target.id;
          }
        }
        allocations.push({ numberId: n.id, msisdn: n.msisdn, rangeId: range.id, targetId: target.id, targetRole: target.role, targetUsername: target.username });
      }
    }
  }
  const summary = requestedTargets.map(t => ({ targetId: t.id, targetRole: t.role, targetUsername: t.username, allocated: allocations.filter(a => a.targetId === t.id).length }));
  db.bulkAllocationHistory.unshift({ id: db.nextBulkAllocationId++, createdAt: new Date().toISOString(), requesterId: requester.id, requesterRole: requester.role, rangeIds: ranges.map(r => r.id), rangeNames: ranges.map(r => r.name), targetIds: requestedTargets.map(t => t.id), targetNames: requestedTargets.map(t => t.username), amountPerRange: amount, allocated: allocations.length, summary });
  save(db);
  return { allocated: allocations.length, requestedPerTarget: amount * ranges.length, targets: summary, allocations };
}

function listBulkAllocationHistory(requester, limit = 50) {
  const db = load();
  let rows = db.bulkAllocationHistory || [];
  if (requester?.role === ROLES.MANAGER) {
    const allowed = new Set(listAssignableTargets(requester).map(u => Number(u.id)).concat(Number(requester.id)));
    rows = rows.filter(h => h.requesterId === requester.id || (h.targetIds || []).some(id => allowed.has(Number(id))));
  } else if (requester?.role === ROLES.AGENT) {
    const allowed = new Set(listAssignableTargets(requester).map(u => Number(u.id)).concat(Number(requester.id)));
    rows = rows.filter(h => h.requesterId === requester.id || (h.targetIds || []).some(id => allowed.has(Number(id))));
  }
  return rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

// --- Number inventory helpers ---
// A number belongs to exactly one Admin's pool (ownerAdminId). It can be
// 'available' (unassigned), 'assigned' (rented by one of that admin's
// clients), or 'paused' (temporarily taken offline by the admin).

function createNumber({ msisdn, country, operator, ownerAdminId, carrier = null, carrierNumberId = null, carrierRangeId = null }) {
  const db = load();
  const exists = db.numbers.some((n) => n.msisdn === msisdn);
  if (exists) {
    const err = new Error('This number already exists');
    err.code = 'DUPLICATE';
    throw err;
  }
  const number = {
    id: db.nextNumberId++,
    msisdn,
    country,
    operator,
    ownerAdminId: Number(ownerAdminId),
    poolOwnerId: Number(ownerAdminId),
    assignedClientId: null,
    holderUserId: null,
    holderRole: null,
    status: 'available',
    carrier,
    carrierNumberId,
    carrierRangeId,
    createdAt: new Date().toISOString(),
  };
  db.numbers.push(number);
  save(db);
  return number;
}


function upsertNumbersBulk({ normalizedNumbers, ownerAdminId }) {
  const db = load();
  let imported = 0, updated = 0;
  const errors = [];
  const byMsisdn = new Map(db.numbers.map(n => [String(n.msisdn).trim(), n]));
  const rangesByExternal = new Map(db.ranges.map(r => [String(r.externalId), r]));
  const rangesByName = new Map(db.ranges.map(r => [String(r.name || '').trim().toLowerCase().replace(/\bLX\b/g, 'MRS'), r]));
  for (const n of normalizedNumbers || []) {
    const msisdn = String(n.msisdn || '').trim();
    if (!msisdn) continue;
    const rawRangeId = n.rangeId != null ? String(n.rangeId) : '';
    const range = rawRangeId ? (rangesByExternal.get(rawRangeId) || rangesByName.get(rawRangeId.trim().toLowerCase().replace(/\bLX\b/g, 'MRS'))) : null;
    const resolvedRangeId = range?.externalId ?? n.rangeId;
    const existing = byMsisdn.get(msisdn);
    if (existing) {
      // Never overwrite an allocated number's holder/assignment during a carrier sync.
      existing.carrier = 'lamix';
      existing.carrierNumberId = n.externalId;
      existing.carrierRangeId = resolvedRangeId;
      if (n.country) existing.country = n.country;
      if (n.operator) existing.operator = n.operator;
      if (!existing.ownerAdminId) existing.ownerAdminId = range?.assignedAgentId || range?.assignedManagerId || Number(ownerAdminId);
      if (existing.poolOwnerId === undefined || existing.poolOwnerId === null) existing.poolOwnerId = range?.assignedManagerId || range?.assignedAgentId || existing.ownerAdminId;
      updated += 1;
      continue;
    }
    const number = {
      id: db.nextNumberId++,
      msisdn,
      country: n.country || range?.country || 'Unknown',
      operator: n.operator || range?.operator || 'Unknown',
      ownerAdminId: Number(range?.assignedAgentId || range?.assignedManagerId || ownerAdminId),
      poolOwnerId: Number(range?.assignedManagerId || range?.assignedAgentId || ownerAdminId),
      assignedClientId: null,
      holderUserId: null,
      holderRole: null,
      status: 'available',
      carrier: 'lamix',
      carrierNumberId: n.externalId,
      carrierRangeId: resolvedRangeId,
      createdAt: new Date().toISOString(),
    };
    db.numbers.push(number);
    byMsisdn.set(msisdn, number);
    imported += 1;
  }
  save(db);
  return { imported, updated, errors };
}

function findNumberByMsisdn(msisdn) {
  const db = load();
  const wanted = String(msisdn || '').trim();
  return db.numbers.find((n) => String(n.msisdn).trim() === wanted);
}

function ensureCarrierNumber({ msisdn, ownerAdminId, carrierNumberId = null, carrierRangeId = null, rangeName = null, country = 'Unknown', operator = 'Unknown' }) {
  const db = load();
  const wanted = String(msisdn || '').trim();
  if (!wanted) return null;
  let existing = db.numbers.find((n) => String(n.msisdn || '').trim() === wanted);
  if (existing) return existing;
  const range = db.ranges.find(r =>
    (carrierRangeId != null && String(r.externalId) === String(carrierRangeId)) ||
    (rangeName && String(r.name || '').trim().toLowerCase() === String(rangeName).trim().toLowerCase())
  );
  const owner = Number(range?.assignedAgentId || range?.assignedManagerId || ownerAdminId || 0);
  existing = {
    id: db.nextNumberId++,
    msisdn: wanted,
    country: country || range?.country || 'Unknown',
    operator: operator || range?.operator || 'Unknown',
    ownerAdminId: owner,
    poolOwnerId: Number(range?.assignedManagerId || range?.assignedAgentId || owner),
    assignedClientId: null, holderUserId: null, holderRole: null, status: 'available',
    carrier: 'lamix', carrierNumberId, carrierRangeId: carrierRangeId || range?.externalId || null,
    createdAt: new Date().toISOString(),
  };
  db.numbers.push(existing);
  save(db);
  return existing;
}

function creditOwnerActualRateForCdr(record, number, actualRate) {
  const db = load();
  if (!record || record.adminBalanceCredit) return false;
  const client = record.clientId ? db.users.find(u => Number(u.id) === Number(record.clientId)) : null;
  let owner = null;
  if (client?.parentAdminId) {
    const agent = db.users.find(u => Number(u.id) === Number(client.parentAdminId) && u.role === ROLES.AGENT);
    if (agent) owner = agent;
  }
  if (!owner && client?.parentManagerId) {
    const manager = db.users.find(u => Number(u.id) === Number(client.parentManagerId) && u.role === ROLES.MANAGER);
    if (manager) owner = manager;
  }
  if (!owner) {
    const candidate = db.users.find(u => Number(u.id) === Number(number?.ownerAdminId) && [ROLES.MANAGER, ROLES.AGENT].includes(u.role));
    owner = candidate || null;
  }
  const amount = Number(actualRate);
  if (!owner || !Number.isFinite(amount) || amount <= 0) return false;
  owner.balance = Math.round((Number(owner.balance || 0) + amount) * 100) / 100;
  record.adminBalanceCredit = amount;
  record.adminBalanceUserId = owner.id;
  save(db);
  return true;
}

function ingestCarrierCdr({ carrier, externalId, numberId, sender, messageBody, status, carrierRate, createdAt, raw }) {
  const db = load();
  const number = db.numbers.find((n) => n.id === Number(numberId));
  if (!number) {
    const err = new Error('Number not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  // Carrier CDRs should be imported even when the number is currently
  // assigned only to a Manager/Agent or is still in inventory. Client earnings
  // are calculated only when a client is actually assigned. This prevents a
  // valid Lamix CDR from being silently discarded just because ownership is
  // not at the client level yet.

  const existing = db.cdr.find(
    (r) => r.carrier === carrier && String(r.carrierExternalId) === String(externalId)
  );
  if (existing) {
    let changed = false;
    // Safe migration for CDRs that were imported before holder snapshots were
    // added: only attribute the record if its receive time is on/after the
    // number's explicit current allocation timestamp. This prevents an OTP
    // received before allocation from being reassigned to the later holder.
    if (!existing.holderUserIdAtReceipt && number.holderUserId && number.holderAssignedAt) {
      const receivedAt = new Date(existing.createdAt || 0).getTime();
      const assignedAt = new Date(number.holderAssignedAt).getTime();
      if (Number.isFinite(receivedAt) && Number.isFinite(assignedAt) && receivedAt >= assignedAt) {
        const holderUser = db.users.find(u => Number(u.id) === Number(number.holderUserId));
        existing.holderUserIdAtReceipt = Number(number.holderUserId);
        existing.holderRoleAtReceipt = number.holderRole || holderUser?.role || null;
        existing.holderUsernameAtReceipt = holderUser?.username || null;
        if (existing.holderRoleAtReceipt === ROLES.CLIENT && !existing.clientId) {
          existing.clientId = Number(number.holderUserId);
          const rate = resolveClientRate(number, existing.clientId);
          existing.clientRateSnapshot = Number(existing.clientRateSnapshot || rate);
          existing.earning = Number(existing.earning || rate);
        }
        changed = true;
      }
    }
    // Lamix may provide the rate on a later poll. Do not leave an early zero
    // payout permanently stored just because the CDR is already Delivered.
    if (Number(carrierRate) > 0 && Number(existing.carrierRate || 0) !== Number(carrierRate)) {
      existing.carrierRate = Number(carrierRate);
      changed = true;
    }
    if (existing.status !== 'Delivered' && status === 'Delivered') {
      existing.status = 'Delivered';
      const earning = existing.clientId
        ? Number(existing.clientRateSnapshot ?? existing.earning ?? resolveClientRate(number, existing.clientId))
        : 0;
      existing.clientRateSnapshot = earning;
      existing.earning = earning;
      existing.carrierRate = Number(carrierRate) || 0;
      if (messageBody) existing.note = messageBody;
      existing.rawCarrierRecord = raw || existing.rawCarrierRecord;
      changed = true;
      if (earning > 0 && number.assignedClientId) adjustUserBalance(number.assignedClientId, earning);
      if (status === 'Delivered') {
        const range = number?.carrierRangeId != null ? findRangeForCdrValue(db, number.carrierRangeId) : null;
        const actual = Number(range?.superAdminRate || carrierRate || 0);
        creditOwnerActualRateForCdr(existing, number, actual);
      }
    }
    // Keep the inbound SMS body/CLI current even when the CDR status did not change.
    if (messageBody && existing.note !== messageBody) { existing.note = messageBody; changed = true; }
    if (sender && existing.sender !== sender) { existing.sender = sender; changed = true; }
    // Older rows may not have holder snapshots. Never infer them from the
    // current number state because that could incorrectly re-attribute an OTP
    // that arrived before allocation. New rows get the exact snapshot above.
    if (raw && !existing.rawCarrierRecord) { existing.rawCarrierRecord = raw; changed = true; }
    if (existing.status === 'Failed' && status === 'Delivered') { existing.status = 'Delivered'; changed = true; }
    return { record: existing, created: false, updated: changed };
  }

  // Snapshot the client at the moment the carrier CDR is first seen. This is
  // the ownership boundary: CDRs before allocation stay unowned, while CDRs
  // received during a rental stay with that client after release.
  const clientIdAtReceipt = number.assignedClientId || null;
  const earning = status === 'Delivered' && clientIdAtReceipt
    ? resolveClientRate(number, clientIdAtReceipt)
    : 0;
  // Snapshot the number holder at the exact moment this carrier CDR is
  // received. A Manager/Agent can own a number without it being rented to a
  // Client, so clientId alone is not enough to attribute direct OTP traffic.
  // This snapshot is also what lets us keep the CDR with the correct holder
  // after the number is later released/reassigned.
  const holderIdAtReceipt = number.holderUserId || null;
  const holderRoleAtReceipt = number.holderRole || null;
  const holderUser = holderIdAtReceipt ? db.users.find(u => Number(u.id) === Number(holderIdAtReceipt)) : null;
  const record = {
    id: db.nextCdrId++,
    numberId: number.id,
    msisdn: number.msisdn,
    clientId: clientIdAtReceipt,
    holderUserIdAtReceipt: holderIdAtReceipt,
    holderRoleAtReceipt: holderRoleAtReceipt,
    holderUsernameAtReceipt: holderUser?.username || null,
    adminId: number.ownerAdminId,
    sender: sender || 'Unknown',
    note: messageBody || '',
    earning,
    clientRateSnapshot: earning,
    status,
    enteredByUserId: null,
    carrier,
    carrierExternalId: String(externalId),
    carrierRate: Number(carrierRate) || 0,
    rawCarrierRecord: raw || null,
    createdAt: createdAt || new Date().toISOString(),
  };
  db.cdr.unshift(record);
  save(db);
  if (earning > 0 && number.assignedClientId) adjustUserBalance(number.assignedClientId, earning);
  if (status === 'Delivered') {
    const range = number?.carrierRangeId != null ? findRangeForCdrValue(db, number.carrierRangeId) : null;
    const actual = Number(range?.superAdminRate || carrierRate || 0);
    creditOwnerActualRateForCdr(record, number, actual);
  }
  return { record, created: true, updated: false };
}

function findNumberById(id) {
  const db = load();
  return db.numbers.find((n) => n.id === Number(id));
}

function updateNumber(id, patch) {
  const db = load();
  const number = db.numbers.find((n) => n.id === Number(id));
  if (!number) return null;
  Object.assign(number, patch);
  save(db);
  return number;
}

function listNumbers({ scopeAdminId, scopeClientId, scopeManagerId, rangeId, status, search, offset, limit } = {}) {
  const db = load();
  let numbers = db.numbers;
  if (scopeAdminId) {
    const adminId = Number(scopeAdminId);
    const admin = db.users.find(u => Number(u.id) === adminId);
    const clientIds = db.users.filter(u => u.role === ROLES.CLIENT && Number(u.parentAdminId) === adminId).map(u => Number(u.id));
    numbers = numbers.filter(n => Number(n.poolOwnerId) === adminId || Number(n.holderUserId) === adminId || clientIds.includes(Number(n.holderUserId)) || Number(n.assignedClientId) === adminId);
  }
  if (scopeManagerId) {
    const managerId = Number(scopeManagerId);
    const agentIds = db.users.filter(u => u.role === ROLES.AGENT && Number(u.parentManagerId) === managerId).map(u => Number(u.id));
    const clientIds = db.users.filter(u => u.role === ROLES.CLIENT && (Number(u.parentManagerId) === managerId || agentIds.includes(Number(u.parentAdminId)))).map(u => Number(u.id));
    const ids = new Set([managerId, ...agentIds, ...clientIds]);
    numbers = numbers.filter(n => ids.has(Number(n.poolOwnerId)) || ids.has(Number(n.holderUserId)) || ids.has(Number(n.assignedClientId)));
  }
  if (scopeClientId) {
    const cid = Number(scopeClientId);
    numbers = numbers.filter(n => Number(n.holderUserId) === cid || Number(n.assignedClientId) === cid);
  }
  if (rangeId) numbers = numbers.filter(n => String(n.carrierRangeId) === String(rangeId) || String(n.rangeId) === String(rangeId));
  if (status) numbers = numbers.filter(n => n.status === status);
  if (search) { const q=String(search).toLowerCase(); numbers=numbers.filter(n => String(n.msisdn).toLowerCase().includes(q) || String(n.country).toLowerCase().includes(q) || String(n.operator).toLowerCase().includes(q)); }
  numbers = [...numbers].sort((a,b)=>String(a.msisdn).localeCompare(String(b.msisdn)));
  const total = numbers.length;
  const sliced = Number.isFinite(Number(limit)) ? numbers.slice(Number(offset)||0, (Number(offset)||0)+Number(limit)) : numbers;
  return { total, numbers: sliced.map((n) => {
    const holder = n.holderUserId ? db.users.find((u) => u.id === Number(n.holderUserId)) : null;
    const client = n.assignedClientId ? db.users.find((u) => u.id === n.assignedClientId) : null;
    const admin = db.users.find((u) => u.id === n.ownerAdminId);
    const poolOwner = n.poolOwnerId ? db.users.find((u) => Number(u.id) === Number(n.poolOwnerId)) : null;
    const range = db.ranges.find(r => String(r.externalId) === String(n.carrierRangeId) || String(r.id) === String(n.rangeId));
    const superAdminRate = range ? (range.superAdminRate != null ? Number(range.superAdminRate) : Number(range.rate || 0)) : Number(n.rate || 0);
    const clientRate = client ? resolveClientRate(n) : null;
    return { ...n, rangeId: range ? range.id : null, rangeName: range ? range.name : null, assignedClientUsername: client ? client.username : null, holderUsername: holder ? holder.username : null, holderRole: holder ? holder.role : (n.holderRole || null), ownerAdminUsername: admin ? admin.username : null, poolOwnerId: n.poolOwnerId || null, poolOwnerUsername: poolOwner ? poolOwner.username : null, superAdminRate, clientRate, effectiveRate: clientRate != null ? clientRate : superAdminRate };
  }) };
}

function assignNumberToClient(numberId, clientId) {
  const db = load();
  const number = db.numbers.find((n) => n.id === Number(numberId));
  if (!number) return null;
  number.assignedClientId = Number(clientId);
  number.holderUserId = Number(clientId);
  number.holderRole = ROLES.CLIENT;
  number.holderAssignedAt = new Date().toISOString();
  number.status = 'assigned';
  save(db);
  return number;
}

function allocateNumberToUser(numberId, targetUserId, requester) {
  const db = load();
  const number = db.numbers.find(n => n.id === Number(numberId));
  if (!number) { const e = new Error('Number not found'); e.code = 'NOT_FOUND'; throw e; }
  if (number.status !== 'available' || number.assignedClientId || (number.holderUserId && Number(number.holderUserId) !== Number(requester.id))) { const e = new Error('Number is already allocated to another user.'); e.code = 'IN_USE'; throw e; }
  const target = listAssignableTargets(requester).find(u => Number(u.id) === Number(targetUserId));
  const poolOwner = number.poolOwnerId == null ? null : Number(number.poolOwnerId);
  const canUsePool = requester.role === ROLES.SUPER_ADMIN
    ? (!number.holderUserId && (poolOwner == null || poolOwner === Number(requester.id) || Number(number.ownerAdminId) === Number(requester.id)))
    : (poolOwner === Number(requester.id) || Number(number.holderUserId) === Number(requester.id));
  if (!canUsePool) { const e = new Error('This number is not in your allocated pool.'); e.code = 'BAD_POOL'; throw e; }
  if (!target) { const e = new Error('Recipient is outside your scope'); e.code = 'BAD_TARGET'; throw e; }
  if (requester.role === ROLES.SUPER_ADMIN && (number.poolOwnerId == null || Number(number.poolOwnerId) === Number(requester.id))) {
    number.poolOwnerId = target.role === ROLES.CLIENT ? (target.parentAdminId || target.parentManagerId || target.id) : target.id;
  } else if (number.poolOwnerId == null) {
    number.poolOwnerId = requester.role === ROLES.MANAGER || requester.role === ROLES.AGENT ? requester.id : (target.parentAdminId || target.parentManagerId || number.ownerAdminId);
  }
  number.holderUserId = target.id;
  number.holderRole = target.role;
  number.holderAssignedAt = new Date().toISOString();
  number.assignedClientId = target.role === ROLES.CLIENT ? target.id : null;
  number.status = target.role === ROLES.CLIENT ? 'assigned' : 'available';
  if (target.role === ROLES.AGENT) {
    if (requester.role === ROLES.SUPER_ADMIN) number.ownerAdminId = target.id;
    const range = db.ranges.find(r => String(r.externalId) === String(number.carrierRangeId) || Number(r.id) === Number(number.rangeId));
    if (range) {
      range.assignedAgentId = target.id;
      if (target.parentManagerId) range.assignedManagerId = Number(target.parentManagerId);
    }
  }
  if (target.role === ROLES.CLIENT && target.parentAdminId) number.ownerAdminId = Number(target.parentAdminId);
  if (target.role === ROLES.CLIENT && target.parentManagerId && !target.parentAdminId) number.ownerAdminId = Number(target.parentManagerId);
  if (target.role === ROLES.MANAGER) {
    if (requester.role === ROLES.SUPER_ADMIN) number.ownerAdminId = target.id;
    const range = db.ranges.find(r => String(r.externalId) === String(number.carrierRangeId) || Number(r.id) === Number(number.rangeId));
    if (range) range.assignedManagerId = target.id;
  }
  save(db);
  return { number, target: { id: target.id, username: target.username, role: target.role } };
}

function releaseNumber(numberId) {
  const db = load();
  const number = db.numbers.find((n) => n.id === Number(numberId));
  if (!number) return null;
  number.assignedClientId = null;
  number.holderUserId = null;
  number.holderRole = null;
  number.holderAssignedAt = null;
  number.status = 'available';
  save(db);
  return number;
}

// --- CDR helpers ---
// A CDR record is a manually logged "an SMS arrived on this number" event.
// Logging a 'Delivered' CDR immediately credits the assigned client's
// balance by the number's clientRate at the time of logging.

function createCdr({ numberId, sender, note, status, enteredByUserId }) {
  const db = load();
  const number = db.numbers.find((n) => n.id === Number(numberId));
  if (!number) {
    const err = new Error('Number not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!number.assignedClientId) {
    const err = new Error('This number is not currently rented by any client');
    err.code = 'UNASSIGNED';
    throw err;
  }
  // Snapshot the client at the moment the carrier CDR is first seen. This is
  // the ownership boundary: CDRs before allocation stay unowned, while CDRs
  // received during a rental stay with that client after release.
  const clientIdAtReceipt = number.assignedClientId || null;
  const earning = status === 'Delivered' && clientIdAtReceipt
    ? resolveClientRate(number, clientIdAtReceipt)
    : 0;
  const record = {
    id: db.nextCdrId++,
    numberId: number.id,
    msisdn: number.msisdn,
    clientId: clientIdAtReceipt,
    adminId: number.ownerAdminId,
    sender: sender || 'Unknown',
    note: note || '',
    earning,
    clientRateSnapshot: earning,
    status,
    enteredByUserId,
    createdAt: new Date().toISOString(),
  };
  db.cdr.unshift(record);
  save(db);

  if (earning > 0) {
    adjustUserBalance(number.assignedClientId, earning);
  }
  return record;
}

function normalizeCdrRangeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\b(?:lx|mrs)\b/gi, 'mrs').replace(/\s+/g, ' ');
}
function findRangeForCdrValue(db, value) {
  if (value === null || value === undefined || value === '') return null;
  const direct = db.ranges.find(r => String(r.externalId) === String(value));
  if (direct) return direct;
  const wanted = normalizeCdrRangeKey(value);
  return db.ranges.find(r => [r.name, r.sourceName, r.masterKey, r.externalId].some(v => normalizeCdrRangeKey(v) === wanted)) || null;
}

function listCdr({ scopeAdminId, scopeClientId, scopeManagerId } = {}) {
  const db = load();

  // Build indexes once. The previous implementation did a linear number/user
  // lookup for every CDR, which becomes very slow as the CDR table grows.
  const numberById = new Map(db.numbers.map(n => [Number(n.id), n]));
  const numberByMsisdn = new Map(db.numbers.map(n => [String(n.msisdn || '').trim(), n]));
  const userById = new Map(db.users.map(u => [Number(u.id), u]));
  const rangeByExternal = new Map(db.ranges.map(r => [String(r.externalId), r]));
  const rangeById = new Map(db.ranges.map(r => [Number(r.id), r]));

  const enriched = db.cdr.map((record) => {
    const number = numberById.get(Number(record.numberId)) || numberByMsisdn.get(String(record.msisdn || '').trim());

    // IMPORTANT: CDR ownership is a snapshot. An OTP received before a number
    // was allocated must never appear for the later holder; an OTP received
    // while allocated remains with that client even after the number is
    // released. Do not infer record.clientId from the number's current state.
    const clientId = record.clientId || null;
    const client = clientId ? userById.get(Number(clientId)) : null;
    const agent = client?.parentAdminId ? userById.get(Number(client.parentAdminId)) : null;
    const manager = client?.parentManagerId
      ? userById.get(Number(client.parentManagerId))
      : (agent?.parentManagerId ? userById.get(Number(agent.parentManagerId)) : null);
    const ownerAdminId = record.adminId || number?.ownerAdminId || null;
    const holderId = record.holderUserIdAtReceipt || null;
    const holderRole = record.holderRoleAtReceipt || null;
    const holder = holderId ? userById.get(Number(holderId)) : null;

    // Keep the payout attached to the CDR at the time the OTP was received.
    // For older records, earning is the best available client-payment value.
    const clientPayout = clientId
      ? Number(record.clientRateSnapshot ?? record.earning ?? (number ? resolveClientRate(number, clientId) : 0))
      : 0;
    // Resolve the range from every identifier Lamix/local storage may have
    // used. Older CDR rows can have no rangeName on the CDR itself and their
    // number may only retain the Lamix range name/external id.
    const rawRangeName = record.rangeName ||
      (record.rawCarrierRecord && (record.rawCarrierRecord.rangeName || record.rawCarrierRecord.range_name || record.rawCarrierRecord.range)) ||
      null;
    let range = number
      ? (rangeByExternal.get(String(number.carrierRangeId)) || rangeById.get(Number(number.rangeId)))
      : (record.rangeId ? rangeById.get(Number(record.rangeId)) : null);
    if (!range && rawRangeName) range = findRangeForCdrValue(db, rawRangeName);
    if (!range && number?.rangeName) range = findRangeForCdrValue(db, number.rangeName);
    if (!range && number?.carrierRangeId) range = findRangeForCdrValue(db, number.carrierRangeId);

    // Super Admin's original/range payout. Older imported ranges may have a
    // zero placeholder, so fall back to Lamix's carrier payout when present.
    const configuredPayout = range?.superAdminRate != null ? Number(range.superAdminRate) : NaN;
    const carrierPayout = Number(record.carrierRate || 0);
    const myPayout = Number.isFinite(configuredPayout) && configuredPayout > 0
      ? configuredPayout
      : carrierPayout;

    return {
      ...record,
      clientId,
      adminId: ownerAdminId,
      clientUsername: client?.username || null,
      assignedClientUsername: client?.username || null,
      agentUsername: agent?.username || null,
      managerUsername: manager?.username || null,
      holderUserIdAtReceipt: holderId,
      holderRoleAtReceipt: holderRole,
      holderUsernameAtReceipt: record.holderUsernameAtReceipt || holder?.username || null,
      clientPayout,
      clientRate: clientPayout,
      myPayout,
      // Always expose the resolved range name to the CDR UI, including older
      // records whose CDR row did not store rangeName directly.
      rangeName: String(range?.name || record.rangeName || rawRangeName || number?.rangeName || '').replace(/\bLX\b/gi, 'MRS') || null,
      holderUserId: number?.holderUserId || null,
      poolOwnerId: number?.poolOwnerId || null,
    };
  });

  let records = enriched.sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (scopeAdminId) {
    const agentId = Number(scopeAdminId);
    records = records.filter((r) => {
      // Client CDRs remain scoped through the Client -> Agent relationship.
      // Direct Agent-held CDRs are scoped through the holder snapshot.
      if (Number(r.holderUserIdAtReceipt) === agentId && r.holderRoleAtReceipt === ROLES.AGENT) return true;
      const client = r.clientId ? userById.get(Number(r.clientId)) : null;
      return Number(client?.parentAdminId) === agentId;
    });
  }
  if (scopeManagerId) {
    const managerId = Number(scopeManagerId);
    records = records.filter((r) => {
      // Direct Manager-held OTPs must appear in the Manager panel.
      if (Number(r.holderUserIdAtReceipt) === managerId && r.holderRoleAtReceipt === ROLES.MANAGER) return true;
      // Agent-held OTPs also belong to the Manager's scope.
      if (r.holderRoleAtReceipt === ROLES.AGENT) {
        const holderAgent = userById.get(Number(r.holderUserIdAtReceipt));
        if (Number(holderAgent?.parentManagerId) === managerId) return true;
      }
      const client = r.clientId ? userById.get(Number(r.clientId)) : null;
      if (!client) return false;
      if (Number(client.parentManagerId) === managerId) return true;
      const agent = client.parentAdminId ? userById.get(Number(client.parentAdminId)) : null;
      return Number(agent?.parentManagerId) === managerId;
    });
  }
  if (scopeClientId) {
    records = records.filter((r) => Number(r.clientId) === Number(scopeClientId));
  }
  return records;
}


// --- Payout request helpers ---
function getPayoutBoundary(date = new Date()) {
  // The payout cycle closes every Wednesday at 05:00 local server time.
  // From Wednesday 05:00 through 16:59 the just-completed period is payable.
  // After 17:00, the next Wednesday becomes the next accumulation boundary.
  const d = new Date(date);
  const boundary = new Date(d);
  boundary.setHours(5, 0, 0, 0);
  const day = d.getDay(); // Sunday=0 ... Wednesday=3
  const daysUntilWednesday = (3 - day + 7) % 7;
  boundary.setDate(boundary.getDate() + daysUntilWednesday);

  if (day === 3 && d.getHours() >= 17) {
    boundary.setDate(boundary.getDate() + 7);
  }
  return boundary;
}

function getLastApprovedPayoutEnd(userId) {
  const db = load();
  const rows = (db.payoutRequests || [])
    .filter(x => Number(x.requesterId) === Number(userId) && x.status === 'approved' && x.periodEnd)
    .sort((a,b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime());
  return rows.length ? new Date(rows[0].periodEnd) : null;
}

function getInitialPayoutStart(boundary) {
  const start = new Date(boundary);
  start.setDate(start.getDate() - 7);
  return start;
}

function isPayoutWindow(date = new Date()) {
  const d = new Date(date);
  const boundary = getPayoutBoundary(d);
  // If the boundary is in the future, payout is not available yet.
  // If exactly at the boundary or after it, allow only until 17:00 that day.
  if (d.getTime() < boundary.getTime()) return false;
  const close = new Date(boundary);
  close.setHours(17, 0, 0, 0);
  return d.getTime() < close.getTime();
}

function getCurrentPayoutPeriod(userId = null) {
  const now = new Date();
  const boundary = getPayoutBoundary(now);
  const lastApprovedEnd = userId ? getLastApprovedPayoutEnd(userId) : null;
  const fallbackStart = getInitialPayoutStart(boundary);
  const start = lastApprovedEnd && lastApprovedEnd.getTime() < boundary.getTime()
    ? lastApprovedEnd
    : fallbackStart;
  return { start, end: boundary };
}

function getWeeklyPayoutForUser(userId, role) {
  const { start, end } = getCurrentPayoutPeriod(userId);
  const records = listCdr(
    role === ROLES.AGENT ? { scopeAdminId: userId } :
    role === ROLES.MANAGER ? { scopeManagerId: userId } : {}
  );
  const payout = records
    .filter(r => {
      const t = new Date(r.createdAt).getTime();
      return t >= start.getTime() && t < end.getTime();
    })
    .reduce((sum, r) => {
      const original = Number(r.myPayout || 0);
      const client = Number(r.clientPayout || 0);
      return sum + Math.max(0, original - client);
    }, 0);

  const available = isPayoutWindow(new Date());
  return {
    amount: Math.round(payout * 1000) / 1000,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    availableOn: end.toISOString(),
    availableUntil: (() => {
      const d = new Date(end);
      d.setHours(17, 0, 0, 0);
      return d.toISOString();
    })(),
    isAvailable: available
  };
}

function createPayoutRequest({ requesterId, amount, paymentMethod, paymentInfo }) {
  const db = load();
  const user = db.users.find(u => u.id === Number(requesterId));
  if (!user || ![ROLES.MANAGER, ROLES.AGENT].includes(user.role)) {
    const e = new Error('Only Managers and Agents can request payouts'); e.code='FORBIDDEN'; throw e;
  }

  const period = getWeeklyPayoutForUser(user.id, user.role);
  if (!period.isAvailable) {
    const e = new Error('Payout requests are available every Wednesday from 5:00 AM to 5:00 PM.'); e.code='NOT_AVAILABLE'; throw e;
  }

  const requested = Number(amount);
  if (!Number.isFinite(requested) || requested < 10) {
    const e = new Error('Minimum payout request is $10'); e.code='MINIMUM'; throw e;
  }
  if (requested > period.amount + 1e-9) {
    const e = new Error(`Requested amount cannot exceed the available payout ($${period.amount.toFixed(3)})`); e.code='EXCEEDS'; throw e;
  }

  const info = String(paymentInfo || '').trim();
  const method = String(paymentMethod || '').toLowerCase();
  if (!['binance_email','usdt_address'].includes(method) || !info) {
    const e = new Error('Provide a Binance email or USDT address'); e.code='PAYMENT_INFO'; throw e;
  }

  user.payoutPaymentMethod = method;
  user.payoutPaymentInfo = info;
  user.payoutPaymentUpdatedAt = new Date().toISOString();

  const existing = db.payoutRequests.find(x =>
    Number(x.requesterId) === Number(user.id) &&
    x.periodEnd === period.periodEnd &&
    ['pending','approved'].includes(x.status)
  );
  if (existing) {
    const e = new Error('A payout request already exists for this payout period'); e.code='DUPLICATE'; throw e;
  }

  const manager = user.role === ROLES.AGENT && user.parentManagerId
    ? db.users.find(u => Number(u.id) === Number(user.parentManagerId))
    : null;
  const row = {
    id: db.nextPayoutRequestId++,
    requesterId: user.id,
    requesterRole: user.role,
    username: user.username,
    managerUsername: manager?.username || null,
    amount: Math.round(requested * 100) / 100,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    availableOn: period.availableOn,
    availableUntil: period.availableUntil,
    paymentMethod: method,
    paymentInfo: info,
    status: 'pending',
    createdAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null
  };
  db.payoutRequests.unshift(row);
  save(db);
  return row;
}

function listPayoutPaymentProfiles(viewer) {
  const db = load();
  if (viewer?.role !== ROLES.SUPER_ADMIN) return [];
  return db.users
    .filter(u => [ROLES.MANAGER, ROLES.AGENT].includes(u.role))
    .map(u => {
      const manager = u.role === ROLES.AGENT && u.parentManagerId
        ? db.users.find(m => Number(m.id) === Number(u.parentManagerId))
        : null;
      return {
        userId: u.id,
        username: u.username,
        role: u.role,
        managerUsername: manager?.username || null,
        paymentMethod: u.payoutPaymentMethod || null,
        paymentInfo: u.payoutPaymentInfo || null,
        updatedAt: u.payoutPaymentUpdatedAt || null
      };
    });
}
function reviewPayoutRequest(id, status, reviewer) {
  const db = load();
  const row = (db.payoutRequests || []).find(x => Number(x.id) === Number(id));
  if (!row) {
    const e = new Error('Payout request not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (row.status !== 'pending') {
    const e = new Error('This payout request has already been reviewed.');
    e.code = 'ALREADY_REVIEWED';
    throw e;
  }
  if (!reviewer || reviewer.role !== ROLES.SUPER_ADMIN) {
    const e = new Error('Only Super Admin can review payout requests.');
    e.code = 'FORBIDDEN';
    throw e;
  }

  if (!['approved', 'rejected'].includes(status)) {
    const e = new Error('Invalid payout request status.');
    e.code = 'INVALID_STATUS';
    throw e;
  }

  row.status = status;
  row.reviewedBy = reviewer.id;
  row.reviewedAt = new Date().toISOString();

  save(db);
  return row;
}

function listPayoutRequests(viewer) {
  const db = load();
  let rows = db.payoutRequests || [];
  if (viewer?.role !== ROLES.SUPER_ADMIN) {
    rows = rows.filter(x => Number(x.requesterId) === Number(viewer.id));
  }
  return rows.map(x => {
    const reviewer = x.reviewedBy ? db.users.find(u => Number(u.id) === Number(x.reviewedBy)) : null;
    const requester = db.users.find(u => Number(u.id) === Number(x.requesterId));
    const manager = requester?.role === ROLES.AGENT && requester.parentManagerId
      ? db.users.find(m => Number(m.id) === Number(requester.parentManagerId))
      : null;
    return {
      ...x,
      managerUsername: x.managerUsername || manager?.username || null,
      reviewerUsername: reviewer?.username || null
    };
  });
}
// --- Range request helpers ---
function createRangeRequest({ rangeId, requesterId }) {
  const db = load();
  const range = db.ranges.find(r => Number(r.id) === Number(rangeId));
  const requester = db.users.find(u => Number(u.id) === Number(requesterId));
  if (!range || !requester) { const e = new Error('Range or requester not found'); e.code='NOT_FOUND'; throw e; }
  const existing = db.rangeRequests.find(x => Number(x.rangeId) === Number(range.id) && Number(x.requesterId) === Number(requester.id) && x.status === 'pending');
  if (existing) { const e = new Error('You already have a pending request for this range.'); e.code='DUPLICATE'; throw e; }
  const row = { id: db.nextRangeRequestId++, rangeId: range.id, requesterId: requester.id, requesterRole: requester.role, status:'pending', createdAt:new Date().toISOString(), reviewedBy:null, reviewedAt:null };
  db.rangeRequests.unshift(row); save(db); return row;
}
function listRangeRequests(viewer) {
  const db = load();
  let rows = db.rangeRequests || [];
  if (viewer?.role === ROLES.SUPER_ADMIN) { /* all */ }
  else if (viewer?.role === ROLES.MANAGER) {
    const agentIds = db.users.filter(u => u.role===ROLES.AGENT && Number(u.parentManagerId)===Number(viewer.id)).map(u=>Number(u.id));
    const clientIds = db.users.filter(u => u.role===ROLES.CLIENT && (Number(u.parentManagerId)===Number(viewer.id) || agentIds.includes(Number(u.parentAdminId)))).map(u=>Number(u.id));
    const allowed = new Set([Number(viewer.id), ...agentIds, ...clientIds]);
    rows = rows.filter(x => allowed.has(Number(x.requesterId)));
  } else if (viewer?.role === ROLES.AGENT) {
    const clientIds = db.users.filter(u => u.role===ROLES.CLIENT && Number(u.parentAdminId)===Number(viewer.id)).map(u=>Number(u.id));
    const allowed = new Set([Number(viewer.id), ...clientIds]);
    rows = rows.filter(x => allowed.has(Number(x.requesterId)));
  } else if (viewer?.role === ROLES.CLIENT) rows = rows.filter(x => Number(x.requesterId)===Number(viewer.id));
  return rows.map(x => {
    const range = db.ranges.find(r=>Number(r.id)===Number(x.rangeId));
    const requester = db.users.find(u=>Number(u.id)===Number(x.requesterId));
    const reviewer = x.reviewedBy ? db.users.find(u=>Number(u.id)===Number(x.reviewedBy)) : null;
    return { ...x, rangeName:range?.name || 'Unknown range', requesterUsername:requester?.username || 'Unknown', reviewerUsername:reviewer?.username || null };
  });
}
function reviewRangeRequest(id, status, reviewer) {
  const db = load();
  const row = db.rangeRequests.find(x=>Number(x.id)===Number(id));
  if (!row) { const e=new Error('Range request not found'); e.code='NOT_FOUND'; throw e; }
  if (row.status !== 'pending') { const e=new Error('This request has already been reviewed.'); e.code='ALREADY_REVIEWED'; throw e; }
  const requester = db.users.find(u=>Number(u.id)===Number(row.requesterId));
  if (!requester) { const e=new Error('Requester not found'); e.code='NOT_FOUND'; throw e; }
  let allowed = reviewer.role===ROLES.SUPER_ADMIN;
  if (reviewer.role===ROLES.MANAGER) allowed = (requester.role===ROLES.AGENT && Number(requester.parentManagerId)===Number(reviewer.id)) || (requester.role===ROLES.CLIENT && (Number(requester.parentManagerId)===Number(reviewer.id) || Number(requester.parentAdminId)===Number(reviewer.id)));
  if (reviewer.role===ROLES.AGENT) allowed = requester.role===ROLES.CLIENT && Number(requester.parentAdminId)===Number(reviewer.id);
  if (!allowed) { const e=new Error('You cannot review this request.'); e.code='FORBIDDEN'; throw e; }
  row.status = status;
  row.reviewedBy = reviewer.id;
  row.reviewedAt = new Date().toISOString();
  if (status==='approved' && (requester.role===ROLES.MANAGER || requester.role===ROLES.AGENT)) {
    const range = db.ranges.find(r=>Number(r.id)===Number(row.rangeId));
    if (range) {
      if (requester.role===ROLES.MANAGER) { range.assignedManagerId=requester.id; range.assignedAgentId=null; }
      else { range.assignedManagerId=requester.parentManagerId ? Number(requester.parentManagerId) : null; range.assignedAgentId=requester.id; }
    }
  }
  save(db); return row;
}

// --- Session helpers ---
function createSession(userId) {
  const db = load();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  db.sessions.push({ token, userId, expiresAt });
  save(db);
  return token;
}

function getSession(token) {
  const db = load();
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    destroySession(token);
    return null;
  }
  return session;
}

function destroySession(token) {
  const db = load();
  db.sessions = db.sessions.filter((s) => s.token !== token);
  save(db);
}

function listUserAdminDetails(viewer) {
  const db = load();
  if (!viewer || ![ROLES.SUPER_ADMIN, ROLES.MANAGER].includes(viewer.role)) return [];

  let admins = db.users.filter(u => u.role === ROLES.AGENT && u.status !== 'deleted');
  if (viewer.role === ROLES.MANAGER) {
    admins = admins.filter(a => Number(a.parentManagerId) === Number(viewer.id));
  }

  const usersById = new Map(db.users.map(u => [Number(u.id), u]));
  const numbersById = new Map(db.numbers.map(n => [Number(n.id), n]));
  const cdrs = db.cdr || [];

  return admins.map(admin => {
    const clients = db.users.filter(c => c.role === ROLES.CLIENT && Number(c.parentAdminId) === Number(admin.id));
    const clientIds = new Set(clients.map(c => Number(c.id)));
    const agentCdrs = cdrs.filter(r => {
      const client = r.clientId ? usersById.get(Number(r.clientId)) : null;
      return Number(client?.parentAdminId) === Number(admin.id);
    });

    let totalEarned = 0;
    let grossPayout = 0;
    let clientPayout = 0;
    for (const r of agentCdrs) {
      const n = numbersById.get(Number(r.numberId));
      const range = n
        ? (db.ranges.find(x => String(x.externalId) === String(n.carrierRangeId)) ||
           db.ranges.find(x => Number(x.id) === Number(n.rangeId)))
        : null;
      const original = Number(range?.superAdminRate ?? range?.rate ?? r.carrierRate ?? 0);
      const client = Number(r.clientRateSnapshot ?? r.earning ?? 0);
      grossPayout += original;
      clientPayout += client;
      totalEarned += Math.max(0, original - client);
    }

    const manager = admin.parentManagerId ? usersById.get(Number(admin.parentManagerId)) : null;
    return {
      id: admin.id,
      username: admin.username,
      role: ROLES.AGENT,
      email: admin.email || null,
      status: admin.status,
      balance: Number(admin.balance || 0),
      managerUsername: manager?.username || null,
      clientCount: clients.length,
      smsCount: agentCdrs.length,
      successfulSms: agentCdrs.filter(r => r.status === 'Delivered' || r.status === 'Success').length,
      grossPayout: Math.round(grossPayout * 1000) / 1000,
      clientPayout: Math.round(clientPayout * 1000) / 1000,
      totalEarned: Math.round(totalEarned * 1000) / 1000,
      payoutPaymentMethod: admin.payoutPaymentMethod || null,
      payoutPaymentInfo: admin.payoutPaymentInfo || null,
      payoutPaymentUpdatedAt: admin.payoutPaymentUpdatedAt || null,
    };
  });
}


function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

module.exports = {
  ROLES,
  ensureSeed,
  initializePersistentDb,
  flushPersistence,
  getPersistenceStatus: () => ({ enabled: hasRemotePersistence(), error: PERSISTENCE_ERROR ? PERSISTENCE_ERROR.message : null }),
  findUserByUsername,
  findUserByEmail,
  findUserById,
  findFirstUserByRole,
  listUsersByRole,
  createUser,
  updateUser,
  adjustUserBalance,
  getCurrentPayoutPeriod,
  getWeeklyPayoutForUser,
  createPayoutRequest,
  listPayoutRequests,
  listPayoutPaymentProfiles,
  reviewPayoutRequest,
  listUserAdminDetails,
  listAdmins,
  listActiveAdminsPublic,
  listClients,
  createOrUpdateSuperRateCard,
  listSuperRateCards,
  findSuperRateCard,
  createOrUpdateAdminRateCard,
  listAdminRateCards,
  findAdminRateCardById,
  findAdminRateCard,
  getUserRangeRate,
  setUserRangeRate,
  resolveClientRate,
  createNumber,
  upsertNumbersBulk,
  findNumberById,
  findNumberByMsisdn,
  ensureCarrierNumber,
  updateNumber,
  listNumbers,
  assignNumberToClient,
  allocateNumberToUser,
  releaseNumber,
  createCdr,
  ingestCarrierCdr,
  listCdr,
  createSession,
  getSession,
  destroySession,
  sanitizeUser,
  upsertCarrierRange,
  listRanges,
  findRangeById,
  assignRange,
  listAssignableTargets,
  bulkAllocateNumbers,
  listBulkAllocationHistory,
  createLocalRange,
  importManualNumbersToRange,
  listUserNumberRanges,
  getDashboardStats,
  updateRange,
  createRangeRequest,
  listRangeRequests,
  reviewRangeRequest,
};
