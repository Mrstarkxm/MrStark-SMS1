// MrStark Sms - Phase 1 backend
// Pure Node.js (no external dependencies): http, fs, crypto only.
const http = require('http');
const fs = require('fs');
const path = require('path');

const db = require('./lib/db');
const { verifyPassword } = require('./lib/hash');
const carrier = require('./lib/carrier');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'sid';

db.ensureSeed();

// ---------- small helpers ----------

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 10e6) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = db.getSession(token);
  if (!session) return null;
  const user = db.findUserById(session.userId);
  if (!user || user.status !== 'active') return null;
  return user;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname);
  // prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- validation helpers ----------

function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u);
}
function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function isValidPassword(p) {
  return typeof p === 'string' && p.length >= 8;
}

// ---------- API handlers ----------

const api = {};

api['POST /api/auth/login'] = async (req, res) => {
  const body = await readJsonBody(req);
  const { username, password } = body;
  if (!username || !password) {
    return sendJson(res, 400, { error: 'Username and password are required' });
  }
  const user = db.findUserByUsername(username) || db.findUserByEmail(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return sendJson(res, 401, { error: 'Invalid credentials' });
  }
  if (user.status !== 'active') {
    return sendJson(res, 403, { error: 'Account is suspended. Contact your administrator.' });
  }
  const token = db.createSession(user.id);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`
  );
  sendJson(res, 200, { user: db.sanitizeUser(user) });
};

api['POST /api/auth/logout'] = async (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) db.destroySession(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  sendJson(res, 200, { ok: true });
};

api['GET /api/auth/me'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  sendJson(res, 200, { user: db.sanitizeUser(user) });
};

// Public: list active admins so a new client can pick who they sign up under
api['GET /api/public/admins'] = async (req, res) => {
  sendJson(res, 200, { admins: db.listActiveAdminsPublic() });
};

// Public self-registration: always creates a CLIENT under a chosen admin.
// Admin and Super Admin accounts cannot be created through this endpoint.
api['POST /api/auth/register'] = async (req, res) => {
  const body = await readJsonBody(req);
  const { username, email, password, adminId, agentId } = body;

  if (!isValidUsername(username)) {
    return sendJson(res, 400, { error: 'Username must be 3-20 characters (letters, numbers, underscore)' });
  }
  if (email && !isValidEmail(email)) {
    return sendJson(res, 400, { error: 'A valid email is required when provided' });
  }
  if (!isValidPassword(password)) {
    return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
  }
  const admin = db.findUserById(adminId);
  const agent = db.findUserById(agentId || adminId);
  if (!agent || agent.role !== db.ROLES.AGENT || agent.status !== 'active') {
    return sendJson(res, 400, { error: 'Please select a valid, active admin/reseller' });
  }

  try {
    const user = db.createUser({
      role: db.ROLES.CLIENT,
      username,
      email,
      password,
      parentAdminId: agent.id,
    });
    const token = db.createSession(user.id);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`
    );
    sendJson(res, 201, { user: db.sanitizeUser(user) });
  } catch (e) {
    if (e.code === 'DUPLICATE') {
      return sendJson(res, 409, { error: 'Username or email already in use' });
    }
    console.error(e);
    sendJson(res, 500, { error: 'Registration failed' });
  }
};

// ---- Account profile / password ----
api['PATCH /api/account/profile'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  const body = await readJsonBody(req);
  if (body.username !== undefined && String(body.username).trim() !== user.username) return sendJson(res, 403, { error: 'Username cannot be changed' });
  if (body.email !== undefined && body.email && !isValidEmail(body.email)) return sendJson(res, 400, { error: 'Invalid email' });
  const updated = db.updateUser(user.id, { email: body.email ? String(body.email).trim() : '' });
  sendJson(res, 200, { user: db.sanitizeUser(updated) });
};
api['POST /api/account/password'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  const body = await readJsonBody(req);
  if (!verifyPassword(String(body.currentPassword || ''), user.passwordHash)) return sendJson(res, 400, { error: 'Current password is incorrect' });
  if (!isValidPassword(body.newPassword)) return sendJson(res, 400, { error: 'New password must be at least 8 characters' });
  const updated = db.updateUser(user.id, { passwordHash: require('./lib/hash').hashPassword(body.newPassword) });
  sendJson(res, 200, { user: db.sanitizeUser(updated) });
};

// ---- Super Admin: manage Managers ----
api['GET /api/managers'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || user.role !== db.ROLES.SUPER_ADMIN) return sendJson(res, 403, { error: 'Super Admin only' });
  const managers = db.listUsersByRole ? db.listUsersByRole(db.ROLES.MANAGER).map(db.sanitizeUser) : [];
  sendJson(res, 200, { managers });
};
api['POST /api/managers'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || user.role !== db.ROLES.SUPER_ADMIN) return sendJson(res, 403, { error: 'Super Admin only' });
  const body = await readJsonBody(req);
  const { username, email, password } = body;
  if (!isValidUsername(username) || (email && !isValidEmail(email)) || !isValidPassword(password)) return sendJson(res, 400, { error: 'Valid username, optional email and password (8+ chars) are required' });
  try {
    const manager = db.createUser({ role: db.ROLES.MANAGER, username, email, password, parentAdminId: null, parentManagerId: null });
    sendJson(res, 201, { manager: db.sanitizeUser(manager) });
  } catch (e) {
    if (e.code === 'DUPLICATE') return sendJson(res, 409, { error: 'Username or email already in use' });
    sendJson(res, 500, { error: 'Could not create manager' });
  }
};
api['PATCH /api/managers/:id'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user || user.role !== db.ROLES.SUPER_ADMIN) return sendJson(res, 403, { error: 'Super Admin only' });
  const target = db.findUserById(params.id);
  if (!target || target.role !== db.ROLES.MANAGER) return sendJson(res, 404, { error: 'Manager not found' });
  const body = await readJsonBody(req);
  const patch = {};
  if (body.status && ['active', 'suspended'].includes(body.status)) patch.status = body.status;
  if (body.balance !== undefined) {
    const bal = Number(body.balance);
    if (!Number.isFinite(bal) || bal < 0) return sendJson(res, 400, { error: 'Invalid balance' });
    patch.balance = Math.round(bal * 100) / 100;
  }
  const updated = db.updateUser(target.id, patch); if (!updated) return sendJson(res, 404, { error: 'Manager not found' }); sendJson(res, 200, { manager: db.sanitizeUser(updated) });
};

// ---- Super Admin: manage Admins ----

api['GET /api/admins'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const admins = db.listAdmins().filter(a => user.role === db.ROLES.SUPER_ADMIN || a.parentManagerId === user.id).map(db.sanitizeUser);
  sendJson(res, 200, { admins });
};

api['POST /api/admins'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const body = await readJsonBody(req);
  const { username, email, password } = body;
  if (user.role === db.ROLES.MANAGER && body.managerId) return sendJson(res, 400, { error: 'Managers cannot create managers' });
  if (!isValidUsername(username)) {
    return sendJson(res, 400, { error: 'Username must be 3-20 characters (letters, numbers, underscore)' });
  }
  if (email && !isValidEmail(email)) {
    return sendJson(res, 400, { error: 'A valid email is required when provided' });
  }
  if (!isValidPassword(password)) {
    return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
  }
  try {
    const admin = db.createUser({
      role: db.ROLES.AGENT,
      username,
      email,
      password,
      parentAdminId: null,
      parentManagerId: user.role === db.ROLES.MANAGER ? user.id : (body.managerId || null),
    });
    sendJson(res, 201, { admin: db.sanitizeUser(admin) });
  } catch (e) {
    if (e.code === 'DUPLICATE') {
      return sendJson(res, 409, { error: 'Username or email already in use' });
    }
    console.error(e);
    sendJson(res, 500, { error: 'Could not create admin' });
  }
};

api['PATCH /api/admins/:id'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const target = db.findUserById(params.id);
  if (!target || target.role !== db.ROLES.AGENT)
 {
    return sendJson(res, 404, { error: 'Admin not found' });
  }
  if (user.role === db.ROLES.MANAGER && target.parentManagerId !== user.id) return sendJson(res, 403, { error: 'Agent is outside your scope' });
  const body = await readJsonBody(req);
  const patch = {};
  if (body.status && ['active', 'suspended'].includes(body.status)) {
    patch.status = body.status;
  }
  if (body.balance !== undefined) {
    if (user.role !== db.ROLES.SUPER_ADMIN) return sendJson(res, 403, { error: 'Only Super Admin can edit balances' });
    const bal = Number(body.balance);
    if (!Number.isFinite(bal) || bal < 0) return sendJson(res, 400, { error: 'Invalid balance' });
    patch.balance = Math.round(bal * 100) / 100;
  }
  const updated = db.updateUser(target.id, patch);
  sendJson(res, 200, { admin: db.sanitizeUser(updated) });
};

// ---- Users overview (Super Admin + Manager) ----
api['GET /api/users'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const admins = db.listUserAdminDetails(user);
  sendJson(res, 200, { admins });
};

// ---- Admin & Super Admin: manage Clients ----

api['GET /api/clients'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const scopeAdminId = user.role === db.ROLES.AGENT ? user.id : null;
  const scopeManagerId = user.role === db.ROLES.MANAGER ? user.id : null;
  const clients = db.listClients({ scopeAdminId, scopeManagerId }).map(db.sanitizeUser);
  sendJson(res, 200, { clients });
};

api['POST /api/clients'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const body = await readJsonBody(req);
  const { username, email, password } = body;
  if (!isValidUsername(username)) {
    return sendJson(res, 400, { error: 'Username must be 3-20 characters (letters, numbers, underscore)' });
  }
  if (email && !isValidEmail(email)) {
    return sendJson(res, 400, { error: 'A valid email is required when provided' });
  }
  if (!isValidPassword(password)) {
    return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
  }

  // Super Admin may assign to any Agent. A Manager can create either a
  // direct Manager client or a client belonging to one of their Agents.
  // An Agent can only create a client for itself.
  let parentAdminId = user.role === db.ROLES.AGENT ? user.id : (body.agentId ? Number(body.agentId) : null);
  let parentManagerId = user.role === db.ROLES.MANAGER ? user.id : null;
  if (body.agentId) {
    const targetAgent = db.findUserById(body.agentId);
    if (!targetAgent || targetAgent.role !== db.ROLES.AGENT) return sendJson(res, 400, { error: 'Invalid agent selected' });
    if (user.role === db.ROLES.MANAGER && Number(targetAgent.parentManagerId) !== Number(user.id)) return sendJson(res, 403, { error: 'Agent is outside your manager scope' });
    parentAdminId = targetAgent.id;
    parentManagerId = null; // Agent-owned clients are visible only to that Agent.
  }

  try {
    const client = db.createUser({
      role: db.ROLES.CLIENT,
      username,
      email,
      password,
      parentAdminId,
      parentManagerId,
    });
    sendJson(res, 201, { client: db.sanitizeUser(client) });
  } catch (e) {
    if (e.code === 'DUPLICATE') {
      return sendJson(res, 409, { error: 'Username or email already in use' });
    }
    console.error(e);
    sendJson(res, 500, { error: 'Could not create client' });
  }
};

api['PATCH /api/clients/:id'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const target = db.findUserById(params.id);
  if (!target || target.role !== db.ROLES.CLIENT) {
    return sendJson(res, 404, { error: 'Client not found' });
  }
  // Ownership check: an Admin may only touch their own clients.
  if (user.role === db.ROLES.AGENT && target.parentAdminId !== user.id) {
    return sendJson(res, 403, { error: 'You do not manage this client' });
  }
  if (user.role === db.ROLES.MANAGER && target.parentManagerId !== user.id && !(target.parentAdminId && db.findUserById(target.parentAdminId)?.parentManagerId === user.id)) {
    return sendJson(res, 403, { error: 'You do not manage this client' });
  }
  const body = await readJsonBody(req);
  const patch = {};
  if (body.status && ['active', 'suspended'].includes(body.status)) {
    patch.status = body.status;
  }
  if (body.balance !== undefined) {
    if (user.role !== db.ROLES.SUPER_ADMIN) {
      return sendJson(res, 403, { error: 'Only Super Admin can edit balances' });
    }
    const bal = Number(body.balance);
    if (!Number.isFinite(bal) || bal < 0) {
      return sendJson(res, 400, { error: 'Invalid balance' });
    }
    patch.balance = bal;
  }
  const updated = db.updateUser(target.id, patch);
  sendJson(res, 200, { client: db.sanitizeUser(updated) });
};

// ---- Numbers (Phase 2) ----

api['GET /api/numbers/ranges'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  sendJson(res, 200, { ranges: db.listUserNumberRanges(user.id, user.role) });
};

api['GET /api/dashboard/stats'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  sendJson(res, 200, db.getDashboardStats(user.id, user.role));
};

api['GET /api/numbers'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  const q = url.parse(req.url, true).query;
  let scope = {};
  if (user.role === db.ROLES.SUPER_ADMIN) scope = {};
  else if (user.role === db.ROLES.AGENT) scope = { scopeAdminId: user.id };
  else if (user.role === db.ROLES.MANAGER) scope = { scopeManagerId: user.id };
  else scope = { scopeAdminId: user.parentAdminId, scopeClientId: user.id };
  const limit = q.limit !== undefined ? Math.min(100, Math.max(1, Number(q.limit) || 25)) : undefined;
  const offset = q.page !== undefined && limit ? (Math.max(1, Number(q.page) || 1) - 1) * limit : 0;
  const result = db.listNumbers({ ...scope, rangeId: q.rangeId || null, status: q.status || null, search: q.search || '', offset, limit });
  sendJson(res, 200, { numbers: result.numbers, total: result.total, page: limit ? Math.floor(offset / limit) + 1 : 1, limit: limit || result.total });
};

api['POST /api/numbers'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const body = await readJsonBody(req);
  const { msisdn, country, operator } = body;
  if (!msisdn || typeof msisdn !== 'string' || msisdn.trim().length < 5) {
    return sendJson(res, 400, { error: 'A valid number is required' });
  }
  if (!country || !operator) {
    return sendJson(res, 400, { error: 'Country and operator are required' });
  }

  let ownerAdminId = user.id;
  let directTarget = null;
  if (body.targetUserId) {
    directTarget = db.findUserById(body.targetUserId);
    if (!directTarget || ![db.ROLES.MANAGER,db.ROLES.AGENT,db.ROLES.CLIENT].includes(directTarget.role)) return sendJson(res,400,{error:'Invalid recipient'});
    const allowed = user.role === db.ROLES.SUPER_ADMIN || (user.role === db.ROLES.MANAGER && (directTarget.parentManagerId === user.id || directTarget.id === user.id)) || (user.role === db.ROLES.AGENT && (directTarget.id === user.id || directTarget.parentAdminId === user.id));
    if (!allowed) return sendJson(res,403,{error:'Recipient is outside your scope'});
    ownerAdminId = directTarget.role === db.ROLES.AGENT ? directTarget.id : (directTarget.role === db.ROLES.CLIENT ? (directTarget.parentAdminId || directTarget.parentManagerId || user.id) : directTarget.id);
  } else if (user.role === db.ROLES.SUPER_ADMIN && body.ownerAdminId) {
    const targetAdmin = db.findUserById(body.ownerAdminId);
    if (!targetAdmin || ![db.ROLES.MANAGER,db.ROLES.AGENT].includes(targetAdmin.role)) return sendJson(res, 400, { error: 'Invalid Manager/Agent selected' });
    ownerAdminId = targetAdmin.id;
  }

  // A number can only be added for a country/operator the owning admin has
  // already priced in their Rate Card - this keeps rate management in one
  // place instead of scattered per-number.
  const rateCard = db.findAdminRateCard(ownerAdminId, country, operator);
  if (!rateCard) {
    return sendJson(res, 400, {
      error: 'Set a client rate for this country/operator in Rate Cards first',
    });
  }

  try {
    const number = db.createNumber({ msisdn: msisdn.trim(), country, operator, ownerAdminId });
    if (directTarget) {
      number.holderUserId = directTarget.id;
      number.holderRole = directTarget.role;
      number.assignedClientId = directTarget.role === db.ROLES.CLIENT ? directTarget.id : null;
      number.status = directTarget.role === db.ROLES.CLIENT ? 'assigned' : 'available';
      db.updateNumber(number.id, number);
      if (directTarget.role === db.ROLES.AGENT || directTarget.role === db.ROLES.MANAGER) {
        const rr = db.findRangeByNumber ? db.findRangeByNumber(number.id) : null;
      }
    }
    sendJson(res, 201, { number: { ...number, effectiveRate: rateCard.clientRate } });
  } catch (e) {
    if (e.code === 'DUPLICATE') return sendJson(res, 409, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Could not create number' });
  }
};

api['PATCH /api/numbers/:id'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const number = db.findNumberById(params.id);
  if (!number) return sendJson(res, 404, { error: 'Number not found' });
  if (user.role === db.ROLES.AGENT && number.ownerAdminId !== user.id) {
    return sendJson(res, 403, { error: 'You do not manage this number' });
  }
  const body = await readJsonBody(req);
  const patch = {};
  if (body.status && ['available', 'paused'].includes(body.status)) {
    if (number.assignedClientId) {
      return sendJson(res, 400, { error: 'Release the number from its client before changing status' });
    }
    patch.status = body.status;
  }
  const updated = db.updateNumber(number.id, patch);
  sendJson(res, 200, { number: updated });
};

// Admin/Super Admin manually assigns a number to one of the admin's own clients
api['POST /api/numbers/:id/assign'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const number = db.findNumberById(params.id);
  if (!number) return sendJson(res, 404, { error: 'Number not found' });
  if (user.role === db.ROLES.AGENT && number.ownerAdminId !== user.id) {
    return sendJson(res, 403, { error: 'You do not manage this number' });
  }
  if (number.status === 'assigned') {
    return sendJson(res, 400, { error: 'Number is already assigned - release it first' });
  }
  const body = await readJsonBody(req);
  const client = db.findUserById(body.clientId);
  if (!client || client.role !== db.ROLES.CLIENT) return sendJson(res, 400, { error: 'Invalid client' });
  const managerOwnsClient = user.role === db.ROLES.MANAGER && (Number(client.parentManagerId) === Number(user.id) || (client.parentAdminId && db.findUserById(client.parentAdminId)?.parentManagerId === user.id));
  const agentOwnsClient = user.role === db.ROLES.AGENT && Number(client.parentAdminId) === Number(user.id);
  const allowedClient = user.role === db.ROLES.SUPER_ADMIN || managerOwnsClient || agentOwnsClient;
  if (!allowedClient) return sendJson(res, 403, { error: 'That client is outside your scope' });
  if (user.role !== db.ROLES.SUPER_ADMIN && Number(number.holderUserId) !== Number(user.id) && Number(number.poolOwnerId) !== Number(user.id)) return sendJson(res, 403, { error: 'This number is not in your allocated pool' });
  const updated = db.assignNumberToClient(number.id, client.id);
  sendJson(res, 200, { number: updated });
};

// Client rents an available number themselves
api['POST /api/numbers/:id/rent'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user || user.role !== db.ROLES.CLIENT) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const number = db.findNumberById(params.id);
  if (!number) return sendJson(res, 404, { error: 'Number not found' });
  if (number.ownerAdminId !== user.parentAdminId) {
    return sendJson(res, 403, { error: 'This number is not available to you' });
  }
  if (number.status !== 'available') {
    return sendJson(res, 400, { error: 'Number is not available' });
  }
  const updated = db.assignNumberToClient(number.id, user.id);
  sendJson(res, 200, { number: updated });
};

// Release a number back to the pool - the renting client, their admin, or
// the super admin may all do this.
api['POST /api/numbers/:id/release'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  const number = db.findNumberById(params.id);
  if (!number) return sendJson(res, 404, { error: 'Number not found' });

  const isOwnerAdmin = user.role === db.ROLES.AGENT && number.ownerAdminId === user.id;
  const isManagerScope = user.role === db.ROLES.MANAGER && (number.ownerAdminId === user.id || number.holderUserId === user.id || (number.ownerAdminId && db.findUserById(number.ownerAdminId)?.parentManagerId === user.id) || (number.holderUserId && db.findUserById(number.holderUserId)?.parentManagerId === user.id));
  const isRentingClient = user.role === db.ROLES.CLIENT && number.assignedClientId === user.id;
  const isSuperAdmin = user.role === db.ROLES.SUPER_ADMIN;
  if (!isOwnerAdmin && !isManagerScope && !isRentingClient && !isSuperAdmin) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const updated = db.releaseNumber(number.id);
  sendJson(res, 200, { number: updated });
};

api['POST /api/numbers/bulk'] = async (req, res) => {
  const user=getCurrentUser(req); if(!user || ![db.ROLES.SUPER_ADMIN,db.ROLES.MANAGER,db.ROLES.AGENT].includes(user.role)) return sendJson(res,403,{error:'Forbidden'});
  const body=await readJsonBody(req); const ids=Array.isArray(body.numberIds)?body.numberIds.map(Number).filter(Number.isFinite):[]; const action=String(body.action||'');
  if(!ids.length) return sendJson(res,400,{error:'Select at least one number'});
  const out=[];
  for(const id of ids){ const n=db.findNumberById(id); if(!n) continue;
    const managerAgentIds=user.role===db.ROLES.MANAGER ? (await Promise.resolve(db.listAdmins().filter(a=>a.parentManagerId===user.id).map(a=>a.id))) : [];
    const inScope=user.role===db.ROLES.SUPER_ADMIN
      || (user.role===db.ROLES.AGENT && (Number(n.poolOwnerId)===Number(user.id) || Number(n.holderUserId)===Number(user.id) || (n.assignedClientId && db.findUserById(n.assignedClientId)?.parentAdminId===user.id)))
      || (user.role===db.ROLES.MANAGER && (Number(n.poolOwnerId)===Number(user.id) || Number(n.holderUserId)===Number(user.id) || managerAgentIds.includes(Number(n.holderUserId)) || (n.assignedClientId && (db.findUserById(n.assignedClientId)?.parentManagerId===user.id || managerAgentIds.includes(Number(db.findUserById(n.assignedClientId)?.parentAdminId))))));
    if(!inScope) continue;
    if(action==='unassign'){ db.releaseNumber(n.id); out.push(n.id); }
    else if(action==='return'){ db.releaseNumber(n.id); db.updateNumber(n.id,{ownerAdminId: db.findFirstUserByRole(db.ROLES.SUPER_ADMIN)?.id || n.ownerAdminId}); out.push(n.id); }
    else if(action==='pause'){ db.updateNumber(n.id,{status:'paused'}); out.push(n.id); }
    else if(action==='activate'){ if(!n.assignedClientId) db.updateNumber(n.id,{status:'available'}); out.push(n.id); }
    else if(action==='assign' && body.clientId){ const c=db.findUserById(body.clientId); const canClient=c&&c.role===db.ROLES.CLIENT&&n.status==='available'&&(user.role===db.ROLES.SUPER_ADMIN || (user.role===db.ROLES.AGENT&&Number(c.parentAdminId)===Number(user.id)) || (user.role===db.ROLES.MANAGER&&(Number(c.parentManagerId)===Number(user.id)||(c.parentAdminId&&managerAgentIds.includes(Number(c.parentAdminId)))))); if(canClient){db.assignNumberToClient(n.id,c.id);out.push(n.id);} }
  }
  sendJson(res,200,{updated:out.length,numberIds:out});
};

// ---- CDR / SMS earnings (Phase 2) ----

// ---- Number ranges / allocation ----
api['GET /api/ranges'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  // The SMS Ranges catalog is intentionally visible to every logged-in user.
  // Allocation/number access is still protected by the normal scope rules;
  // this endpoint is only the carrier-style catalogue so users can request a range.
  return sendJson(res, 200, { ranges: db.listRanges({ includeAll: true, viewerUserId: user.id, viewerRole: user.role }) });
};

api['GET /api/range-requests'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error:'Not authenticated' });
  return sendJson(res, 200, { requests: db.listRangeRequests(user) });
};

api['POST /api/range-requests'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error:'Not authenticated' });
  if (user.role === db.ROLES.SUPER_ADMIN) return sendJson(res, 400, { error:'Super Admin does not need to request ranges.' });
  const body = await readJsonBody(req);
  try {
    const row = db.createRangeRequest({ rangeId: body.rangeId, requesterId: user.id });
    return sendJson(res, 201, { request: db.listRangeRequests(user).find(x=>Number(x.id)===Number(row.id)) || row });
  } catch(e) {
    if (e.code === 'DUPLICATE') return sendJson(res, 409, { error:e.message });
    if (e.code === 'NOT_FOUND') return sendJson(res, 404, { error:e.message });
    console.error(e); return sendJson(res, 500, { error:'Could not create range request' });
  }
};

api['PATCH /api/range-requests/:id'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error:'Not authenticated' });
  const body = await readJsonBody(req);
  const status = String(body.status || '').toLowerCase();
  if (!['approved','rejected'].includes(status)) return sendJson(res, 400, { error:'Status must be approved or rejected' });
  try {
    const row = db.reviewRangeRequest(params.id, status, user);
    return sendJson(res, 200, { request: db.listRangeRequests(user).find(x=>Number(x.id)===Number(row.id)) || row });
  } catch(e) {
    if (['NOT_FOUND','FORBIDDEN','ALREADY_REVIEWED'].includes(e.code)) return sendJson(res, e.code==='NOT_FOUND'?404:403, { error:e.message });
    console.error(e); return sendJson(res, 500, { error:'Could not review range request' });
  }
};
api['POST /api/manual-import'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || user.role !== db.ROLES.SUPER_ADMIN) return sendJson(res, 403, { error:'Super Admin only' });
  const body = await readJsonBody(req);
  const name = String(body.name || '').trim();
  const country = String(body.country || '').trim() || 'Unknown';
  const operator = String(body.operator || '').trim() || 'Manual';
  const numbers = Array.isArray(body.numbers) ? body.numbers : [];
  if (!name) return sendJson(res,400,{error:'Range name is required'});
  if (!numbers.length) return sendJson(res,400,{error:'No numbers found in the uploaded file'});
  if (numbers.length > 50000) return sendJson(res,400,{error:'Maximum 50,000 numbers per import'});
  try {
    const range = db.createLocalRange({ name, country, operator, clientRate: 0 });
    const result = db.importManualNumbersToRange({ rangeId:range.id, numbers, ownerAdminId:user.id });
    sendJson(res,201,{ range:db.listRanges({}).find(r=>Number(r.id)===Number(range.id)), imported:result.imported, skipped:result.skipped });
  } catch(e) { console.error(e); sendJson(res,500,{error:e.message||'Could not import numbers'}); }
};

api['POST /api/ranges'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) return sendJson(res, 403, { error: 'Forbidden' });
  const body = await readJsonBody(req);
  const name = String(body.name || '').trim(), country = String(body.country || '').trim(), operator = String(body.operator || '').trim();
  const rate = Number(body.clientRate ?? body.rate);
  if (!name || !country || !operator) return sendJson(res, 400, { error: 'Range name, country and operator are required' });
  if (!Number.isFinite(rate) || rate < 0) return sendJson(res, 400, { error: 'A valid range rate is required' });
  let managerId = null, agentId = null;
  if (user.role === db.ROLES.MANAGER) { managerId = user.id; agentId = body.agentId ? Number(body.agentId) : null; if (agentId) { const a=db.findUserById(agentId); if(!a || a.role!==db.ROLES.AGENT || a.parentManagerId!==user.id) return sendJson(res,400,{error:'Agent is outside your manager scope'}); } }
  if (user.role === db.ROLES.AGENT) agentId = user.id;
  if (user.role === db.ROLES.SUPER_ADMIN) { managerId = body.managerId ? Number(body.managerId) : null; agentId = body.agentId ? Number(body.agentId) : null; if(agentId){const a=db.findUserById(agentId);if(!a||a.role!==db.ROLES.AGENT)return sendJson(res,400,{error:'Invalid agent'}); if(!managerId) managerId=a.parentManagerId||null;} }
  const range = db.createLocalRange({ name, country, operator, clientRate: rate, managerId, agentId });
  sendJson(res, 201, { range: db.listRanges({}).find(r => r.id === range.id) });
};

api['PATCH /api/ranges/:id'] = async (req, res, params) => {
  const user = getCurrentUser(req); const range = db.findRangeById(params.id);
  if (!user || !range) return sendJson(res, 404, { error: 'Range not found' });
  const manager = range.assignedManagerId ? db.findUserById(range.assignedManagerId) : null;
  const agent = range.assignedAgentId ? db.findUserById(range.assignedAgentId) : null;
  const allowed = user.role === db.ROLES.SUPER_ADMIN || (user.role === db.ROLES.MANAGER && (range.assignedManagerId===user.id || agent?.parentManagerId===user.id)) || (user.role===db.ROLES.AGENT && range.assignedAgentId===user.id);
  if (!allowed) return sendJson(res,403,{error:'You do not manage this range'});
  const body=await readJsonBody(req);
  const patch={};
  if(body.superAdminRate!==undefined){
    if(user.role !== db.ROLES.SUPER_ADMIN) return sendJson(res,403,{error:'Only Super Admin can change the range payout rate'});
    const rate=Number(body.superAdminRate); if(!Number.isFinite(rate)||rate<0)return sendJson(res,400,{error:'Invalid range payout rate'}); patch.superAdminRate=rate;
  }
  if(body.clientRate!==undefined){
    return sendJson(res,403,{error:'Only Super Admin can edit SMS rates'});
  }
  if(body.name!==undefined){
    if(user.role!==db.ROLES.SUPER_ADMIN) return sendJson(res,403,{error:'Only Super Admin can edit a range name'});
    patch.name=body.name;
  }
  if(body.country!==undefined){
    if(user.role!==db.ROLES.SUPER_ADMIN) return sendJson(res,403,{error:'Only Super Admin can edit range details'});
    patch.country=body.country;
  }
  if(body.operator!==undefined){
    if(user.role!==db.ROLES.SUPER_ADMIN) return sendJson(res,403,{error:'Only Super Admin can edit range details'});
    patch.operator=body.operator;
  }
  if(body.limit!==undefined){
    if(user.role!==db.ROLES.SUPER_ADMIN) return sendJson(res,403,{error:'Only Super Admin can edit range limits'});
    patch.limit=body.limit;
  }
  const updated=db.updateRange(range.id,patch); sendJson(res,200,{range:db.listRanges({}).find(r=>r.id===updated.id)});
};

api['POST /api/ranges/:id/assign'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER].includes(user.role)) return sendJson(res, 403, { error: 'Super Admin or Manager only' });
  const body = await readJsonBody(req);
  const agent = body.agentId ? db.findUserById(body.agentId) : null;
  const manager = body.managerId ? db.findUserById(body.managerId) : null;
  if (user.role === db.ROLES.MANAGER && manager && manager.id !== user.id) return sendJson(res, 403, { error: 'Manager can only use their own manager scope' });
  if (user.role === db.ROLES.MANAGER && agent && agent.parentManagerId !== user.id) return sendJson(res, 403, { error: 'Agent is outside your manager scope' });
  if (agent && agent.role !== db.ROLES.AGENT) return sendJson(res, 400, { error: 'Invalid agent' });
  if (manager && manager.role !== db.ROLES.MANAGER) return sendJson(res, 400, { error: 'Invalid manager' });
  if (agent && manager && agent.parentManagerId !== manager.id) return sendJson(res, 400, { error: 'Agent does not belong to selected manager' });
  const range = db.assignRange(params.id, { managerId: manager?.id || (agent?.parentManagerId || null), agentId: agent?.id || null });
  if (!range) return sendJson(res, 404, { error: 'Range not found' });
  sendJson(res, 200, { range: db.listRanges({}).find(r => r.id === range.id) });
};

api['POST /api/numbers/:id/allocate'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) return sendJson(res, 403, { error: 'Forbidden' });
  const body = await readJsonBody(req);
  try {
    const result = db.allocateNumberToUser(params.id, body.targetUserId, user);
    sendJson(res, 200, result);
  } catch (e) {
    if (['NOT_FOUND','IN_USE','BAD_TARGET','BAD_POOL'].includes(e.code)) return sendJson(res, 400, { error: e.message });
    console.error(e); sendJson(res, 500, { error: 'Number allocation failed' });
  }
};

// ---- Bulk number allocation ----
api['GET /api/bulk-add/targets'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) return sendJson(res, 403, { error: 'Forbidden' });
  const targets = db.listAssignableTargets(user).map(u => ({ id: u.id, username: u.username, role: u.role, status: u.status, parentAdminId: u.parentAdminId, parentManagerId: u.parentManagerId }));
  const ranges = db.listRanges({
    ...(user.role === db.ROLES.SUPER_ADMIN ? {} : user.role === db.ROLES.MANAGER ? { scopeManagerId: user.id } : { scopeAgentId: user.id }),
    viewerUserId: user.id,
    viewerRole: user.role
  });
  sendJson(res, 200, { targets, ranges });
};

api['GET /api/bulk-add/history'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) return sendJson(res, 403, { error: 'Forbidden' });
  sendJson(res, 200, { history: db.listBulkAllocationHistory(user, 100) });
};

api['POST /api/bulk-add'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) return sendJson(res, 403, { error: 'Forbidden' });
  const body = await readJsonBody(req);
  try {
    const result = db.bulkAllocateNumbers({ requester: user, rangeIds: body.rangeIds, targetUserIds: body.targetUserIds, amountPerRange: body.amountPerRange, rangeRates: body.rangeRates || {} });
    sendJson(res, 200, result);
  } catch (e) {
    if (['BAD_TARGETS','BAD_RANGES','BAD_AMOUNT','FORBIDDEN_RATE'].includes(e.code)) return sendJson(res, 400, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Bulk allocation failed' });
  }
};

// ---- Carrier / Lamix integration ----

api['GET /api/test-panel'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  if (!carrier.isConfigured()) return sendJson(res, 503, { error: 'Lamix is not configured. Set LAMIX_SESSION_COOKIE for the Lamix Test Panel.' });
  try {
    const url = new URL(req.url, 'http://localhost');
    const result = await carrier.getTestPanelData({
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
      search: url.searchParams.get('search'),
      inboundLimit: url.searchParams.get('inboundLimit'),
      inboundOffset: url.searchParams.get('inboundOffset'),
      inboundSearch: url.searchParams.get('inboundSearch'),
      includeSensitive: user.role === db.ROLES.SUPER_ADMIN
    });
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, e.status || 502, { error: e.message, retryAfter: e.retryAfter || null });
  }
};

api['GET /api/carrier/status'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  if (user.role !== db.ROLES.SUPER_ADMIN) {
    return sendJson(res, 403, { error: 'Super Admin only' });
  }
  sendJson(res, 200, carrier.getStatus());
};

api['POST /api/carrier/test'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || user.role !== db.ROLES.SUPER_ADMIN) {
    return sendJson(res, 403, { error: 'Super Admin only' });
  }
  try {
    const result = await carrier.testConnection();
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, e.status || 502, { error: e.message, retryAfter: e.retryAfter || null });
  }
};

api['POST /api/carrier/sync'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || user.role !== db.ROLES.SUPER_ADMIN) {
    return sendJson(res, 403, { error: 'Super Admin only' });
  }
  try {
    const result = await carrier.runSync();
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, e.status || 502, { error: e.message, retryAfter: e.retryAfter || null });
  }
};

api['GET /api/cdr'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });

  let records;
  if (user.role === db.ROLES.SUPER_ADMIN) {
    records = db.listCdr({});
  } else if (user.role === db.ROLES.MANAGER) {
    records = db.listCdr({ scopeManagerId: user.id });
  } else if (user.role === db.ROLES.AGENT) {
    records = db.listCdr({ scopeAdminId: user.id });
  } else {
    records = db.listCdr({ scopeClientId: user.id });
  }
  sendJson(res, 200, { cdr: records });
};

// Manual CDR entry - "I saw this SMS arrive on this number" - logged by the
// admin who owns the number (or the super admin). Crediting the client's
// balance happens automatically inside db.createCdr for 'Delivered' entries.
api['POST /api/cdr'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const body = await readJsonBody(req);
  const { numberId, sender, note, status } = body;
  if (!numberId) return sendJson(res, 400, { error: 'A number is required' });
  if (!['Delivered', 'Failed'].includes(status)) {
    return sendJson(res, 400, { error: 'Status must be Delivered or Failed' });
  }
  const number = db.findNumberById(numberId);
  if (!number) return sendJson(res, 404, { error: 'Number not found' });
  if (user.role === db.ROLES.AGENT && number.ownerAdminId !== user.id) {
    return sendJson(res, 403, { error: 'You do not manage this number' });
  }
  try {
    const record = db.createCdr({
      numberId,
      sender,
      note,
      status,
      enteredByUserId: user.id,
    });
    sendJson(res, 201, { cdr: record });
  } catch (e) {
    if (e.code === 'UNASSIGNED') return sendJson(res, 400, { error: e.message });
    if (e.code === 'NOT_FOUND') return sendJson(res, 404, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Could not log CDR entry' });
  }
};

// ---- Rate Cards (Phase 3) ----

// Super Admin's base rate cards - readable by everyone logged in (Admins
// need to see them to price their own rates against), writable by Super
// Admin only.
api['GET /api/rate-cards/base'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error: 'Not authenticated' });
  sendJson(res, 200, { rateCards: db.listSuperRateCards() });
};

api['POST /api/rate-cards/base'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || user.role !== db.ROLES.SUPER_ADMIN) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const body = await readJsonBody(req);
  const { country, operator, baseRate } = body;
  if (!country || !operator) {
    return sendJson(res, 400, { error: 'Country and operator are required' });
  }
  const rate = Number(baseRate);
  if (!Number.isFinite(rate) || rate < 0) {
    return sendJson(res, 400, { error: 'Base rate must be a positive number' });
  }
  const card = db.createOrUpdateSuperRateCard({ country, operator, baseRate: rate });
  sendJson(res, 200, { rateCard: card });
};

// An Admin's own client-facing rate per country/operator. Admin sets
// whatever they like ("apni marzi") - the Super Admin's base rate is shown
// alongside purely as a reference so the Admin can see their margin.
api['GET /api/rate-cards/admin'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT, db.ROLES.CLIENT].includes(user.role)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  const scopeAdminId = user.role === db.ROLES.AGENT ? user.id : (user.role === db.ROLES.CLIENT ? user.parentAdminId : (user.role === db.ROLES.MANAGER ? null : null));
  sendJson(res, 200, { rateCards: db.listAdminRateCards({ scopeAdminId }) });
};

api['POST /api/rate-cards/admin'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || user.role !== db.ROLES.SUPER_ADMIN) {
    return sendJson(res, 403, { error: 'Only Super Admin can edit SMS rates' });
  }
  const body = await readJsonBody(req);
  const { country, operator, clientRate } = body;
  if (!country || !operator) {
    return sendJson(res, 400, { error: 'Country and operator are required' });
  }
  const rate = Number(clientRate);
  if (!Number.isFinite(rate) || rate < 0) {
    return sendJson(res, 400, { error: 'Client rate must be a positive number' });
  }

  let adminId = user.id;
  if (user.role === db.ROLES.SUPER_ADMIN && body.adminId) {
    const targetAdmin = db.findUserById(body.adminId);
    if (!targetAdmin || ![db.ROLES.MANAGER, db.ROLES.AGENT].includes(targetAdmin.role)) {
      return sendJson(res, 400, { error: 'Invalid Manager/Agent selected' });
    }
    adminId = targetAdmin.id;
  } else if (user.role === db.ROLES.SUPER_ADMIN && !body.adminId) {
    return sendJson(res, 400, { error: 'Select which Manager/Agent this client rate is for' });
  }
  if (user.role === db.ROLES.MANAGER && body.adminId && Number(body.adminId) !== Number(user.id)) return sendJson(res,403,{error:'Managers can only change their own client rates'});
  if (user.role === db.ROLES.AGENT && body.adminId && Number(body.adminId) !== Number(user.id)) return sendJson(res,403,{error:'Agents can only change their own client rates'});

  try {
    const card = db.createOrUpdateAdminRateCard({ adminId, country, operator, clientRate: rate });
    sendJson(res, 200, { rateCard: card });
  } catch (e) {
    if (e.code === 'NO_BASE_RATE') return sendJson(res, 400, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: 'Could not save rate card' });
  }
};


// ---- Weekly payouts (Wednesday -> Wednesday) ----
api['GET /api/payouts'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return sendJson(res, 401, { error:'Not authenticated' });
  if (![db.ROLES.SUPER_ADMIN, db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) {
    return sendJson(res, 403, { error:'Only Managers and Agents can use payouts' });
  }
  const period = user.role === db.ROLES.SUPER_ADMIN
    ? null
    : db.getWeeklyPayoutForUser(user.id, user.role);
  sendJson(res, 200, {
    requests: db.listPayoutRequests(user),
    period,
    paymentProfiles: user.role === db.ROLES.SUPER_ADMIN ? db.listPayoutPaymentProfiles(user) : undefined
  });
};

api['POST /api/payouts'] = async (req, res) => {
  const user = getCurrentUser(req);
  if (!user || ![db.ROLES.MANAGER, db.ROLES.AGENT].includes(user.role)) {
    return sendJson(res, 403, { error:'Only Managers and Agents can request payouts' });
  }
  const body = await readJsonBody(req);
  try {
    const row = db.createPayoutRequest({
      requesterId: user.id,
      amount: body.amount,
      paymentMethod: body.paymentMethod,
      paymentInfo: body.paymentInfo
    });
    sendJson(res, 201, { request: row });
  } catch(e) {
    if (['FORBIDDEN','MINIMUM','EXCEEDS','PAYMENT_INFO','DUPLICATE','NOT_AVAILABLE'].includes(e.code)) {
      return sendJson(res, 400, { error:e.message });
    }
    console.error(e); sendJson(res, 500, { error:'Could not create payout request' });
  }
};

api['PATCH /api/payouts/:id'] = async (req, res, params) => {
  const user = getCurrentUser(req);
  if (!user || user.role !== db.ROLES.SUPER_ADMIN) {
    return sendJson(res, 403, { error:'Only Super Admin can review payout requests' });
  }
  const body = await readJsonBody(req);
  const status = String(body.status || '').toLowerCase();
  if (!['approved','rejected'].includes(status)) return sendJson(res, 400, { error:'Status must be approved or rejected' });
  try {
    const row = db.reviewPayoutRequest(params.id, status, user);
    sendJson(res, 200, { request: row });
  } catch(e) {
    if (['NOT_FOUND','FORBIDDEN','ALREADY_REVIEWED'].includes(e.code)) return sendJson(res, e.code==='NOT_FOUND'?404:403, { error:e.message });
    console.error(e); sendJson(res, 500, { error:'Could not review payout request' });
  }
};

// ---------- router ----------

function matchRoute(method, pathname) {
  // exact match first
  const exactKey = `${method} ${pathname}`;
  if (api[exactKey]) return { handler: api[exactKey], params: {} };

  // param match e.g. /api/admins/:id
  for (const key of Object.keys(api)) {
    const [m, routePath] = key.split(' ');
    if (m !== method) continue;
    if (!routePath.includes(':')) continue;
    const routeParts = routePath.split('/');
    const pathParts = pathname.split('/');
    if (routeParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = pathParts[i];
      } else if (routeParts[i] !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: api[key], params };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname.startsWith('/api/')) {
    const match = matchRoute(req.method, pathname);
    if (!match) return sendJson(res, 404, { error: 'Not found' });
    try {
      await match.handler(req, res, match.params);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    }
    return;
  }

  // Friendly URL -> file mapping
  let filePath = pathname;
  if (filePath === '/') filePath = '/login.html';
  if (filePath === '/login') filePath = '/login.html';
  if (filePath === '/register') filePath = '/register.html';
  if (filePath === '/dashboard') filePath = '/dashboard.html';

  serveStatic(req, res, filePath);
});

// Local development keeps the original always-on Lamix scanner. Vercel
// functions are short-lived, so background setInterval jobs must not be used there.
if (!process.env.VERCEL) {
  carrier.start();
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`MrStark Sms server running at http://localhost:${PORT}`);
  });
}

// Export the Node HTTP handler for Vercel Serverless Functions.
module.exports = server;
