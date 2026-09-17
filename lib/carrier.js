// Lamix REST API adapter. Uses Node 18+ built-in fetch; no npm dependency.
const db = require('./db');

const DEFAULT_BASE_URL = 'https://panel.lamix.org/api/v1';
const DEFAULT_TEST_PANEL_URL = 'https://panel.lamix.org/test-panel';
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.LAMIX_POLL_INTERVAL_MS || 1000));
const REQUEST_GAP_MS = Math.max(0, Number(process.env.LAMIX_REQUEST_GAP_MS || 0));
const MAX_RETRIES = Math.max(1, Number(process.env.LAMIX_MAX_RETRIES || 3));
let lastRequestAt = 0;
let lastCdrDiagnostics = [];
let lastBrowserCdrSyncAt = 0;
let lastNumberDiagnostics = [];

function config() {
  const token = String(process.env.LAMIX_API_TOKEN || '').trim();
  const baseUrl = String(process.env.LAMIX_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const ownerAdminId = Number(process.env.LAMIX_DEFAULT_OWNER_ADMIN_ID || 0);
  const sessionCookie = String(process.env.LAMIX_SESSION_COOKIE || '').trim();
  const csrfToken = String(process.env.LAMIX_CSRF_TOKEN || '').trim();
  const testPanelUrl = String(process.env.LAMIX_TEST_PANEL_URL || DEFAULT_TEST_PANEL_URL).trim().replace(/\/+$/, '');
  return { token, baseUrl, ownerAdminId, sessionCookie, csrfToken, testPanelUrl };
}

function isConfigured() {
  const c = config();
  return Boolean(c.token || c.sessionCookie);
}

function safeConfig() {
  const c = config();
  return {
    configured: Boolean(c.token || c.sessionCookie),
    testPanelSessionConfigured: Boolean(c.sessionCookie),
    baseUrl: c.baseUrl,
    ownerAdminId: c.ownerAdminId || null,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

function unwrapList(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  // Lamix has returned list payloads in a few common envelopes over time:
  // {items:[...]}, {data:[...]}, {data:{items:[...]}}, and paginated
  // {data:{data:[...]}}. Walk only object/array containers so we don't
  // accidentally treat unrelated nested values as records.
  const queue = [payload];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.length) return current;
      continue;
    }
    for (const key of keys) {
      if (Array.isArray(current[key])) return current[key];
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return [];
}

function first(obj, names, fallback = null) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null && obj[name] !== '') return obj[name];
  }
  return fallback;
}

function normalizePhone(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    value = first(value, ['msisdn','number','phone','value','destination','to','recipient'], '');
  }
  return String(value).trim();
}

function canonicalPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function findFieldDeep(item, names) {
  if (!item || typeof item !== 'object') return null;
  const direct = first(item, names, null);
  if (direct !== null) return direct;
  const queue = Object.values(item).filter(v => v && typeof v === 'object');
  const seen = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    const hit = first(cur, names, null);
    if (hit !== null) return hit;
    for (const v of Object.values(cur)) if (v && typeof v === 'object') queue.push(v);
  }
  return null;
}

function normalizeStatus(value) {
  // Lamix CDR rows are inbound SMS records. Some CDR responses do not expose a
  // delivery-status field at all; the previous code treated a missing status as
  // Failed, which incorrectly marked every such SMS as failed. Explicit failure
  // states still remain Failed; an omitted/unknown state is treated as received.
  if (value === null || value === undefined || String(value).trim() === '') return 'Delivered';
  const s = String(value).trim().toLowerCase();
  if (['1', 'delivered', 'delivery', 'received', 'receive', 'inbound', 'ok', 'success', 'successful', 'billable', 'billed', 'complete', 'completed'].includes(s)) return 'Delivered';
  if (['0', 'failed', 'failure', 'rejected', 'undelivered', 'expired', 'error', 'blocked', 'invalid'].includes(s)) return 'Failed';
  // Unknown provider status: don't falsely report an inbound SMS as Failed.
  return 'Delivered';
}

function extractMessageBody(item) {
  const value = first(item, ['message', 'messageBody', 'message_body', 'body', 'text', 'content', 'sms', 'messageText', 'message_text', 'messageContent', 'message_content', 'smsText', 'sms_text'], '');
  return value == null ? '' : String(value);
}

function normalizeRange(item) {
  const rawName = first(item, ['name', 'range', 'label']);
  const name = rawName == null ? rawName : String(rawName).replace(/\bLX\b/gi, 'MRS');
  return {
    id: first(item, ['id', 'rangeId', 'range_id']),
    name,
    country: first(item, ['country', 'countryCode', 'country_code']),
    operator: first(item, ['operator', 'network', 'carrier', 'mno']),
    rate: Number(first(item, ['rate', 'payoutRate', 'payout_rate', 'price'], 0)) || 0,
  };
}

function normalizeNumber(item, rangesById) {
  const rangeId = first(item, ['rangeId', 'range_id', 'range']);
  let range = rangeId !== null && rangesById ? rangesById.get(String(rangeId)) : null;
  // Lamix /numbers may return the range NAME instead of its external id.
  if (!range && rangeId != null && rangesById) {
    const wanted = String(rangeId).trim().toLowerCase().replace(/\bLX\b/g, 'MRS');
    for (const candidate of rangesById.values()) {
      const name = String(candidate?.name || '').trim().toLowerCase();
      if (name === wanted) { range = candidate; break; }
    }
  }
  const canonicalRangeId = range?.externalId ?? rangeId;
  return {
    externalId: first(item, ['id', 'numberId', 'number_id']),
    msisdn: normalizePhone(first(item, ['msisdn', 'number', 'phone', 'destination', 'to'])),
    country: first(item, ['country', 'countryCode', 'country_code']) || (range && range.country) || 'Unknown',
    operator: first(item, ['operator', 'network', 'carrier', 'mno']) || (range && range.operator) || 'Unknown',
    rangeId: canonicalRangeId,
    rangeName: range && range.name,
  };
}

function normalizeRangeLookupKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\b(?:lx|mrs)\b/gi, 'mrs').replace(/\s+/g, ' ');
}
function findRangeForCdr(rangeValue, rangesById) {
  if (rangeValue === null || rangeValue === undefined || !rangesById) return null;
  const direct = rangesById.get(String(rangeValue));
  if (direct) return direct;
  const wanted = normalizeRangeLookupKey(rangeValue);
  for (const candidate of rangesById.values()) {
    if ([candidate?.name, candidate?.sourceName, candidate?.masterKey, candidate?.externalId, ...(candidate?.externalIds || [])].some(k => normalizeRangeLookupKey(k) === wanted)) return candidate;
  }
  return null;
}

function normalizeCdr(item, rangesById) {
  const rangeId = first(item, ['rangeId', 'range_id', 'range']);
  const range = findRangeForCdr(rangeId, rangesById);
  const externalId = findFieldDeep(item, ['id', 'cdrId', 'cdr_id', 'messageId', 'message_id', 'uuid', 'transactionId', 'transaction_id']);
  const msisdn = normalizePhone(findFieldDeep(item, ['number', 'msisdn', 'destination', 'destinationNumber', 'destination_number', 'recipient', 'recipientNumber', 'recipient_number', 'to', 'did', 'phoneNumber', 'phone_number']));
  const sender = findFieldDeep(item, ['from', 'sender', 'cli', 'cliNumber', 'cli_number', 'source', 'originator', 'sourceNumber', 'source_number']) || 'Unknown';
  const messageBody = extractMessageBody(item);
  const timestamp = findFieldDeep(item, ['createdAt', 'created_at', 'receivedAt', 'received_at', 'timestamp', 'time', 'date', 'datetime']);
  const carrierRate = Number(first(item, ['rate', 'payoutRate', 'payout_rate', 'price'], range ? range.rate : 0)) || Number(range?.rate || 0) || 0;
  return {
    externalId: externalId !== null ? String(externalId) : null,
    msisdn,
    sender: String(sender || 'Unknown'),
    messageBody,
    status: normalizeStatus(first(item, ['status', 'deliveryStatus', 'delivery_status', 'state'])),
    carrierRate,
    rangeId,
    country: first(item, ['country', 'countryCode', 'country_code']) || (range && range.country) || '',
    operator: first(item, ['operator', 'network', 'carrier', 'mno']) || (range && range.operator) || '',
    createdAt: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
    raw: item,
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, query = {}, timeoutMs = 10000) {
  const c = config();
  if (!c.token) {
    const err = new Error('Lamix is not configured. Set LAMIX_API_TOKEN in the server environment.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  // Lamix REST authentication uses the token query parameter. Keep the token
  // out of logs/UI, but send it to the provider exactly as their API expects.
  qs.set('token', c.token);
  const authenticatedEndpoint = `${c.baseUrl}${path}?${qs}`;

  let attempt = 0;
  while (true) {
    const gap = REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (gap > 0) await sleep(gap);
    lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1500, Number(timeoutMs) || 10000));
    try {
      const response = await fetch(authenticatedEndpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${c.token}`,
          'X-API-Key': c.token,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text }; }

      if (response.ok) return body;

      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = Number(retryAfterHeader);
      const isRateLimited = response.status === 429 || String(body.error || '').toLowerCase() === 'rate_limited';
      if (isRateLimited && attempt < MAX_RETRIES) {
        attempt += 1;
        const backoff = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : Math.min(30000, 1500 * (2 ** (attempt - 1)));
        await sleep(backoff);
        continue;
      }

      const err = new Error(body.error || body.message || `Lamix API returned HTTP ${response.status}`);
      err.code = `HTTP_${response.status}`;
      err.status = response.status;
      err.retryAfter = retryAfterHeader;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function requestSessionPath(path, query = {}) {
  const c = config();
  if (!c.sessionCookie) {
    const err = new Error('Lamix Test Panel session is not configured. Set LAMIX_SESSION_COOKIE from your Lamix browser session.');
    err.code = 'TEST_PANEL_SESSION_NOT_CONFIGURED';
    throw err;
  }
  const url = new URL(path, c.testPanelUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = {
      Accept: '*/*',
      Referer: c.testPanelUrl,
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: c.sessionCookie,
    };
    if (c.csrfToken) headers['X-CSRF-Token'] = c.csrfToken;
    const response = await fetch(url, { method:'GET', headers, signal:controller.signal });
    const text = await response.text();
    let body={}; try { body=text ? JSON.parse(text):{}; } catch { body={raw:text}; }
    if (!response.ok) {
      const err=new Error(body?.error || body?.message || `Lamix Test Panel returned HTTP ${response.status}`);
      err.status=response.status; err.code=`TEST_PANEL_HTTP_${response.status}`; throw err;
    }
    return body;
  } finally { clearTimeout(timer); }
}

function testPanelApiPath() { return '/api/test-numbers'; }

async function fetchTestNumbersExact({limit=25, offset=0}={}) {
  const payload = await requestSessionPath(testPanelApiPath(), {limit, offset});
  const rows = unwrapList(payload, ['data','testNumbers','test_numbers','numbers','records','items','results']);
  const total = Number(first(payload, ['total','count','totalCount','total_count'], rows.length)) || rows.length;
  const normalized = rows.map(raw => {
    const rawRange = first(raw, ['rangeName','range_name','range','name','label'], 'Unknown range');
    const number = normalizePhone(first(raw, ['msisdn','number','phone','testNumber','test_number','value'], ''));
    const prefix = first(raw, ['prefix','countryCode','country_code','dialCode','dial_code'], number ? number.replace(/^\\+/, '').slice(0,3) : '');
    return { rangeName: String(rawRange).replace(/\\bLX\\b/g,'MRS'), prefix: String(prefix || ''), msisdn:number, raw };
  }).filter(x=>x.msisdn);
  return { rows: normalized, total, raw: payload };
}

async function fetchRecentInboundExact({limit=25, offset=0}={}) {
  // Exact Lamix Test Panel endpoint captured from the authenticated
  // /test-panel page HAR: GET /api/test-cdrs?limit=25&offset=0
  const payload = await requestSessionPath('/api/test-cdrs', { limit, offset });
  const rows = unwrapList(payload, ['rows','data','testCdrs','test_cdrs','recentInbound','recent_inbound','cdrs','records','items','results']);
  const total = Number(first(payload, ['total','count','totalCount','total_count'], rows.length)) || rows.length;
  return { rows, total, raw: payload };
}

async function fetchRanges() {
  const payload = await request('/ranges');
  return unwrapList(payload, ['ranges', 'records', 'items']).map(normalizeRange);
}

async function fetchNumbers(ranges = []) {
  // Lamix may cap a collection response at 500 and may silently ignore some
  // pagination parameters. Keep the probes small and record exactly what the
  // carrier returned so we can identify the supported pagination mode instead
  // of repeatedly syncing the same 500 records forever.
  const all = [];
  const seen = new Set();
  lastNumberDiagnostics = [];

  const addRows = rows => {
    let added = 0;
    for (const row of rows || []) {
      const rawKey = first(row, ['id','numberId','number_id','msisdn','number','phone'], null);
      const key = rawKey != null ? String(rawKey).trim() : JSON.stringify(row);
      if (!key || seen.has(key)) continue;
      seen.add(key); all.push(row); added += 1;
    }
    return added;
  };

  const probe = async (label, query) => {
    try {
      const payload = await request('/numbers', query);
      const rows = unwrapList(payload, ['numbers','records','items','data','results']);
      const added = addRows(rows);
      const total = Number(first(payload, ['count','total','totalCount','total_count'], 0)) || 0;
      const next = first(payload, ['after','next','nextCursor','next_cursor'], null);
      lastNumberDiagnostics.push({
        label, query, ok: true, rows: rows.length, added, total: total || null,
        hasNext: Boolean(next),
        keys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 30) : [],
        rowKeys: rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 40) : [],
        sample: rows[0] || null,
      });
      return { rows, total, next };
    } catch (e) {
      lastNumberDiagnostics.push({ label, query, ok: false, error: e.message });
      return { rows: [], total: 0, next: null };
    }
  };

  const firstProbe = await probe('page-1', { limit: 500, page: 1 });
  const total = firstProbe.total;

  if (firstProbe.next) {
    await probe('cursor-next', { limit: 500, cursor: firstProbe.next });
  }

  // Try the common page form only for a few pages. If it is ignored, the
  // diagnostics will show identical samples and we stop rather than wasting
  // hundreds of requests every background cycle.
  for (let page = 2; page <= 5; page++) {
    if (total && all.length >= total) break;
    const before = all.length;
    const r = await probe(`page-${page}`, { limit: 500, page });
    if (!r.rows.length || all.length === before) break;
  }

  // Offset/skip are tried only when the page strategy did not produce a new
  // page. These are the most common alternatives for a hard 500-row cap.
  if ((!total || all.length < total) && all.length <= 500) {
    for (const [label, key] of [['offset-500','offset'], ['skip-500','skip']]) {
      const before = all.length;
      const r = await probe(label, { limit: 500, [key]: 500 });
      if (all.length > before) {
        // If this form works, continue it up to a safe ceiling.
        for (let n = 1000; n <= 20000; n += 500) {
          if (total && all.length >= total) break;
          const beforeN = all.length;
          const rr = await probe(`${key}-${n}`, { limit: 500, [key]: n });
          if (!rr.rows.length || all.length === beforeN) break;
        }
        break;
      }
    }
  }

  // Some APIs expose pageNumber/pageNo instead of page. Only probe these if
  // all previous pagination forms still return the same 500-record window.
  if ((!total || all.length < total) && all.length <= 500 && firstProbe.rows.length === 500) {
    for (const [label, key] of [['pageNumber-2','pageNumber'], ['pageNo-2','pageNo']]) {
      const before = all.length;
      const r = await probe(label, { limit: 500, [key]: 2 });
      if (all.length > before) {
        for (let n = 3; n <= 20; n++) {
          if (total && all.length >= total) break;
          const beforeN = all.length;
          const rr = await probe(`${key}-${n}`, { limit: 500, [key]: n });
          if (!rr.rows.length || all.length === beforeN) break;
        }
        break;
      }
    }
  }

  // IMPORTANT: Lamix can return a maximum of 500 numbers for the unfiltered
  // collection while still supporting range-filtered requests. When a new
  // range is added, it may therefore never appear in the first 500 global
  // rows. Probe each known range directly so every range gets a chance to
  // return its own inventory. We try the common filter spellings and stop
  // probing alternate spellings once one of them actually adds records.
  for (const range of ranges || []) {
    const rangeId = range?.id;
    const rangeName = range?.name;
    if (rangeId == null && !rangeName) continue;

    let addedForRange = 0;
    const candidates = [];
    if (rangeId != null) {
      candidates.push(['rangeId', { limit: 500, rangeId: String(rangeId) }]);
      candidates.push(['range_id', { limit: 500, range_id: String(rangeId) }]);
      candidates.push(['carrierRangeId', { limit: 500, carrierRangeId: String(rangeId) }]);
    }
    if (rangeName) {
      candidates.push(['rangeName', { limit: 500, range: String(rangeName) }]);
    }

    for (const [label, query] of candidates) {
      const before = all.length;
      const r = await probe(`range-${String(rangeId ?? rangeName)}-${label}`, query);
      addedForRange += Math.max(0, all.length - before);
      if (r.rows.length && all.length > before) break;
    }
  }

  return all;
}
async function fetchCdrsFast() {
  // Fast path used by the live scanner. Cache-bust the provider request and
  // keep the timeout short so a slow/temporary Lamix response cannot stall
  // the whole polling loop for 10+ seconds.
  const payload = await request('/cdrs', { limit: 250, _ts: Date.now() }, 3500);
  return unwrapList(payload, ['cdrs', 'cdr', 'messages', 'records', 'items', 'results', 'data', 'rows']);
}

async function fetchCdrsBackgroundFast() {
  try {
    const rows = await fetchCdrsFast();
    if (rows.length) return rows;
  } catch (e) {
    lastCdrDiagnostics = [{ path: '/cdrs', query: { limit: 250 }, ok: false, error: e.message, fast: true }];
  }

  // Only fall back when the fast endpoint is empty. Run the two most common
  // Lamix variants in parallel instead of the old 14-request serial probe.
  const attempts = [
    ['/cdrs', { page: 1, limit: 250, _ts: Date.now() }],
    ['/cdrs', { perPage: 250, _ts: Date.now() }],
  ];
  const results = await Promise.allSettled(attempts.map(([path, query]) => request(path, query, 3500)));
  const diagnostics = [];
  let best = [];
  results.forEach((result, i) => {
    const [path, query] = attempts[i];
    if (result.status === 'fulfilled') {
      const rows = unwrapList(result.value, ['cdrs', 'cdr', 'messages', 'records', 'items', 'results', 'data', 'rows']);
      diagnostics.push({ path, query, ok: true, rows: rows.length, fastFallback: true });
      if (rows.length > best.length) best = rows;
    } else {
      diagnostics.push({ path, query, ok: false, error: result.reason?.message || String(result.reason), fastFallback: true });
    }
  });
  lastCdrDiagnostics = diagnostics;
  return best;
}

async function fetchCdrs() {
  // Do not stop at the first successful-but-empty response. Some Lamix
  // deployments return an empty result when an unsupported date/filter
  // parameter is supplied, while the same collection endpoint returns the
  // actual feed without that filter. Try the plain collection first, then
  // common pagination/date variants and keep the largest non-empty result.
  const fromIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const fromDate = fromIso.slice(0, 10);
  const attempts = [
    ['/cdrs', { limit: 250 }],
    ['/cdrs', { page: 1 }],
    ['/cdrs', { perPage: 250 }],
    ['/cdrs', { page: 1, limit: 250 }],
    ['/cdrs', { per_page: 250 }],
    ['/cdrs', { from: fromIso, limit: 250 }],
    ['/cdrs', { start: fromIso, limit: 250 }],
    ['/cdrs', { startDate: fromDate, limit: 250 }],
    ['/cdrs', { date_from: fromDate, limit: 250 }],
    ['/cdr', { limit: 250 }],
    ['/cdr', { page: 1, limit: 250 }],
    ['/cdr', { perPage: 250 }],
    ['/sms/cdrs', { limit: 250 }],
    ['/messages/cdrs', { limit: 250 }],
  ];
  const errors = [];
  const diagnostics = [];
  let best = [];
  let successful = false;

  for (const [path, query] of attempts) {
    try {
      const payload = await request(path, query);
      successful = true;
      const rows = unwrapList(payload, ['cdrs', 'cdr', 'messages', 'message', 'sms', 'records', 'rows', 'items', 'results', 'list', 'transactions', 'logs', 'data', 'payload', 'result']);
      const keys = payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).slice(0, 20) : [];
      diagnostics.push({ path, query, ok: true, rows: rows.length, keys, rowKeys: rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]).slice(0, 40) : [], sample: rows[0] && typeof rows[0] === 'object' ? rows[0] : null });
      if (rows.length > best.length) best = rows;
      // A useful non-empty response is enough; the first plain /cdrs request
      // is preferred because it is least likely to be affected by filter-name
      // differences between Lamix deployments.
      if (rows.length > 0) { lastCdrDiagnostics = diagnostics.slice(-12); return rows; }
    } catch (e) {
      diagnostics.push({ path, query, ok: false, error: e.message, status: e.status || null });
      errors.push(`${path}: ${e.message}`);
    }
  }

  lastCdrDiagnostics = diagnostics.slice(-12);
  if (best.length) return best;
  if (successful) return [];
  const err = new Error(`Could not fetch Lamix CDRs. ${errors.join(' | ')}`);
  err.code = 'CDR_FETCH_FAILED';
  throw err;
}

function findLocalNumber(msisdn) {
  const exact = db.findNumberByMsisdn(msisdn);
  if (exact) return exact;
  const canonical = canonicalPhone(msisdn);
  if (!canonical) return null;
  const listed = db.listNumbers({ limit: 100000 });
  const all = listed && Array.isArray(listed.numbers) ? listed.numbers : (Array.isArray(listed) ? listed : []);
  let hit = all.find(n => canonicalPhone(n.msisdn) === canonical);
  if (hit) return hit;
  // Handle local-vs-provider country-prefix differences (e.g. 03xx vs 92xx).
  const local = canonical.replace(/^92/, '0');
  if (local !== canonical) hit = all.find(n => canonicalPhone(n.msisdn) === local);
  return hit || null;
}

async function syncCdrOnly() {
  const startedAt = Date.now();
  const c = config();
  if (!c.token) { const err = new Error('Lamix is not configured. Set LAMIX_API_TOKEN in the server environment.'); err.code='NOT_CONFIGURED'; throw err; }
  // Background polling must use the same resilient CDR discovery as manual sync.
  // The fast single-endpoint probe can legitimately return an empty envelope on
  // some Lamix deployments even though a compatible CDR endpoint is populated.
  const cdrItems = await fetchCdrsBackgroundFast();
  db.beginPersistenceBatch();
  try {
    const result = { rangesFetched: 0, numbersFetched: 0, cdrsFetched: cdrItems.length, numbersImported: 0, numbersUpdated: 0, cdrsImported: 0, cdrsUpdated: 0, cdrsSkipped: 0, skipReasons: {missingNumber:0, unmatchedMsisdn:0, ingestError:0, duplicateOrExisting:0}, errors: [] };
    const dbRanges = db.listRanges({});
    const rangesById = new Map();
    for (const r of dbRanges) {
      if (r.externalId != null) rangesById.set(String(r.externalId), r);
      for (const ext of (r.externalIds || [])) rangesById.set(String(ext), r);
      if (r.name) rangesById.set(normalizeRangeLookupKey(r.name), r);
      if (r.masterKey) rangesById.set(normalizeRangeLookupKey(r.masterKey), r);
    }
    for (const raw of cdrItems) {
      const cdr = normalizeCdr(raw, rangesById);
      if (!cdr.msisdn) { result.cdrsSkipped++; result.skipReasons.missingNumber++; continue; }
      const number = findLocalNumber(cdr.msisdn);
      let resolvedNumber = number;
      if (!resolvedNumber) resolvedNumber = db.ensureCarrierNumber({ msisdn: cdr.msisdn, ownerAdminId: c.ownerAdminId || db.findFirstUserByRole(db.ROLES.SUPER_ADMIN)?.id, carrierRangeId: cdr.rangeId, rangeName: first(raw, ['range','rangeName','range_name']), country: cdr.country, operator: cdr.operator });
      if (!resolvedNumber) { result.cdrsSkipped++; result.skipReasons.unmatchedMsisdn++; continue; }
      const externalId = cdr.externalId || `${cdr.msisdn}|${cdr.sender}|${cdr.createdAt}`;
      try {
        const outcome = db.ingestCarrierCdr({ carrier:'lamix', externalId, numberId:resolvedNumber.id, sender:cdr.sender, messageBody:cdr.messageBody, status:cdr.status, carrierRate:cdr.carrierRate, createdAt:cdr.createdAt, raw:cdr.raw });
        if (outcome.created) result.cdrsImported++; else if (outcome.updated) result.cdrsUpdated++;
      } catch (e) { result.cdrsSkipped++; result.skipReasons.ingestError++; result.errors.push(`cdr ${externalId}: ${e.message}`); }
    }
    result.durationMs=Date.now()-startedAt; result.syncedAt=new Date().toISOString(); result.cdrDiagnostics = lastCdrDiagnostics; return result;
  } finally {
    // Never leave the process in a persistence-batch state if an unexpected
    // error occurs during a Lamix poll. Warm Vercel instances can be reused.
    db.endPersistenceBatch();
  }
}

let testPanelCache = { expiresAt: 0, data: null, promise: null };

function normalizeRangeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\b(lx|mrs)\b/g, 'mrs').replace(/\s+/g, ' ');
}

async function fetchTestNumbers(ranges) {
  const all = [];
  const seen = new Set();
  const add = rows => {
    let added = 0;
    for (const row of rows || []) {
      const raw = first(row, ['id','numberId','number_id','msisdn','number','phone'], null);
      const key = raw != null ? String(raw).trim() : JSON.stringify(row);
      if (!key || seen.has(key)) continue;
      seen.add(key); all.push(row); added++;
    }
    return added;
  };
  let total = 0;
  for (let page = 1; page <= 20; page++) {
    const payload = await request('/numbers', { limit: 500, page });
    const rows = unwrapList(payload, ['numbers','records','items','data','results']);
    total = Number(first(payload, ['count','total','totalCount','total_count'], total)) || total;
    const added = add(rows);
    if (!rows.length || !added || (total && all.length >= total)) break;
  }
  if (all.length < Math.min(total || 500, 5000) && all.length <= 500) {
    for (let offset = 500; offset < 5000; offset += 500) {
      try {
        const payload = await request('/numbers', { limit: 500, offset });
        const rows = unwrapList(payload, ['numbers','records','items','data','results']);
        const added = add(rows);
        if (!rows.length || !added) break;
        if (total && all.length >= total) break;
      } catch (_) { break; }
    }
  }
  const byExternal = new Map((ranges || []).map(r => [String(r.id), r]));
  const byKey = new Map();
  for (const r of ranges || []) {
    byKey.set(normalizeRangeKey(r.name), r);
    if (r.sourceName) byKey.set(normalizeRangeKey(r.sourceName), r);
  }
  return all.map(raw => {
    const n = normalizeNumber(raw, byExternal);
    const rawRange = first(raw, ['rangeName','range_name','range'], null);
    const local = byExternal.get(String(n.rangeId)) || byKey.get(normalizeRangeKey(rawRange)) || byKey.get(normalizeRangeKey(n.rangeName));
    return {
      rangeName: local?.name || n.rangeName || (rawRange ? String(rawRange).replace(/\bLX\b/g,'MRS') : 'Unknown range'),
      prefix: local?.prefix || (n.msisdn ? String(n.msisdn).replace(/^\+/, '').slice(0,3) : ''),
      msisdn: n.msisdn,
    };
  }).filter(x => x.msisdn);
}

async function getTestPanelData(options = {}) {
  const limit = Math.min(500, Math.max(1, Number(options.limit || 25)));
  const offset = Math.max(0, Number(options.offset || 0));
  const search = String(options.search || '').trim().toLowerCase();
  const inboundLimit = Math.min(500, Math.max(1, Number(options.inboundLimit || 25)));
  const inboundOffset = Math.max(0, Number(options.inboundOffset || 0));
  const inboundSearch = String(options.inboundSearch || '').trim().toLowerCase();
  const includeSensitive = options.includeSensitive === true;
  const key = `${limit}|${offset}|${search}|${inboundLimit}|${inboundOffset}|${inboundSearch}|${includeSensitive ? 's' : 'n'}`;
  if (testPanelCache.data && testPanelCache.expiresAt > Date.now() && testPanelCache.data.key === key) return testPanelCache.data;
  if (testPanelCache.promise && testPanelCache.key === key) return testPanelCache.promise;
  testPanelCache.key = key;
  testPanelCache.promise = (async () => {
    // The Lamix Test Panel search box is client-facing but the API request
    // captured from the real page only exposes limit/offset. Fetch the full
    // test-number collection when a search term is present so searching is
    // across ALL test numbers, not only the 25 currently displayed.
    const [exact, exactInbound] = await Promise.all([
      search ? fetchTestNumbersExact({limit: 5000, offset: 0}) : fetchTestNumbersExact({limit, offset}),
      inboundSearch ? fetchRecentInboundExact({limit: 5000, offset: 0}) : fetchRecentInboundExact({limit: inboundLimit, offset: inboundOffset})
    ]);
    const localRanges = db.listRanges({});
    const byKey = new Map();
    for (const r of localRanges) {
      byKey.set(normalizeRangeKey(r.name), r);
      if (r.sourceName) byKey.set(normalizeRangeKey(r.sourceName), r);
    }
    let rows = exact.rows.map(x => {
      const local = byKey.get(normalizeRangeKey(x.rangeName));
      return {...x, rangeName: local?.name || x.rangeName};
    });
    let numberTotal = exact.total;
    if (search) {
      rows = rows.filter(x => `${x.rangeName} ${x.prefix} ${x.msisdn}`.toLowerCase().includes(search));
      numberTotal = rows.length;
      rows = rows.slice(offset, offset + limit);
    }
    let recentInbound = exactInbound.rows.map(raw => {
      const range = first(raw,['rangeName','range_name','range','name','label'],'Unknown range');
      const number = normalizePhone(first(raw,['receivedNumber','received_number','msisdn','number','phone','testNumber','test_number','destination','to'],''));
      const sender = first(raw,['senderCli','sender_cli','sender','from','cli','source','originator'],'Unknown');
      const createdAt = first(raw,['receivedAt','received_at','createdAt','created_at','timestamp','time','date','datetime'],new Date().toISOString());
      const local=byKey.get(normalizeRangeKey(range));
      return {createdAt:new Date(createdAt).toISOString(),rangeName:local?.name || String(range).replace(/\bLX\b/g,'MRS'),msisdn:number,sender:String(sender||'Unknown')};
    }).filter(x=>x.msisdn).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    // Lamix's Test Panel endpoint intentionally masks CLI values (for example
    // CatXXXX) and does not include the SMS body. Super Admins in MrStark may
    // see the unmasked values when the server also has the privileged Lamix
    // API token. Enrich only this role's response from the normal Lamix CDR
    // feed, matching by test number and closest receive time.
    if (includeSensitive && recentInbound.length) {
      try {
        let privilegedRows = await fetchCdrsFast();
        if (!privilegedRows.length) privilegedRows = await fetchCdrs();
        const normalizedPrivileged = privilegedRows.map(raw => normalizeCdr(raw, new Map())).filter(x => x.msisdn);
        recentInbound = recentInbound.map(item => {
          const t = new Date(item.createdAt).getTime();
          let best = null;
          let bestDiff = Infinity;
          for (const cdr of normalizedPrivileged) {
            if (canonicalPhone(cdr.msisdn) !== canonicalPhone(item.msisdn)) continue;
            const diff = Math.abs(new Date(cdr.createdAt).getTime() - t);
            if (diff < bestDiff) { best = cdr; bestDiff = diff; }
          }
          if (best && bestDiff <= 10 * 60 * 1000) {
            return {
              ...item,
              fullSender: best.sender && !/x{2,}$/i.test(String(best.sender)) ? String(best.sender) : '',
              messageBody: best.messageBody ? String(best.messageBody) : ''
            };
          }
          return {...item, fullSender:'', messageBody:''};
        });
      } catch (e) {
        // Keep the exact Test Panel feed working even if the optional privileged
        // enrichment endpoint is unavailable. Never expose partial sensitive data.
        recentInbound = recentInbound.map(item => ({...item, fullSender:'', messageBody:''}));
      }
    }
    let recentInboundTotal = exactInbound.total;
    if (inboundSearch) {
      recentInbound = recentInbound.filter(x => `${x.rangeName} ${x.msisdn} ${x.sender} ${x.fullSender || ''} ${x.messageBody || ''}`.toLowerCase().includes(inboundSearch));
      recentInboundTotal = recentInbound.length;
      recentInbound = recentInbound.slice(inboundOffset, inboundOffset + inboundLimit);
    }
    const data={key,testNumbers:rows,total:numberTotal,recentInbound,recentInboundTotal,canViewFullInbound:includeSensitive,fetchedAt:new Date().toISOString(),source:'lamix-test-panel'};
    testPanelCache={expiresAt:Date.now()+5000,data,promise:null,key};
    return data;
  })().catch(err=>{testPanelCache.promise=null; throw err;});
  return testPanelCache.promise;
}

async function testConnection() {
  const ranges = await fetchRanges();
  return { ok: true, ranges: ranges.length, baseUrl: config().baseUrl };
}

async function sync() {
  const startedAt = Date.now();
  db.beginPersistenceBatch();
  try {
  const c = config();
  if (!c.token) {
    const err = new Error('Lamix is not configured. Set LAMIX_API_TOKEN in the server environment.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  let ranges = [];
  let numbers = [];
  let cdrItems = [];
  const errors = [];

  try { ranges = await fetchRanges(); } catch (e) { errors.push(`ranges: ${e.message}`); }
  try { numbers = await fetchNumbers(ranges); } catch (e) { errors.push(`numbers: ${e.message}`); }
  try { cdrItems = await fetchCdrs(); } catch (e) { errors.push(`cdrs: ${e.message}`); }

  // Persist Lamix ranges first. Numbers remain linked to their carrier range;
  // the Super Admin can later allocate a whole range to an Agent.
  for (const range of ranges) {
    if (range.id !== null) db.upsertCarrierRange({
      carrier: 'lamix', externalId: range.id, name: range.name, sourceName: range.sourceName,
      country: range.country, operator: range.operator, rate: range.rate
    });
  }
  const rangesById = new Map(ranges.filter(r => r.id !== null).map(r => [String(r.id), r]));
  const ownerAdminId = c.ownerAdminId || db.findFirstUserByRole(db.ROLES.SUPER_ADMIN)?.id;
  const result = {
    rangesFetched: ranges.length,
    numbersFetched: numbers.length,
    cdrsFetched: cdrItems.length,
    numbersImported: 0,
    numbersUpdated: 0,
    cdrsImported: 0,
    cdrsUpdated: 0,
    cdrsSkipped: 0,
    errors,
    skipReasons: { missingNumber: 0, unmatchedMsisdn: 0, ingestError: 0, duplicateOrExisting: 0 },
  };

  if (ownerAdminId) {
    const normalized = numbers.map(raw => normalizeNumber(raw, rangesById)).filter(n => n.msisdn);
    const outcome = db.upsertNumbersBulk({ normalizedNumbers: normalized, ownerAdminId });
    result.numbersImported = outcome.imported;
    result.numbersUpdated = outcome.updated;
    if (outcome.errors.length) errors.push(...outcome.errors);
  } else {
    errors.push('No Super Admin owner found. Set LAMIX_DEFAULT_OWNER_ADMIN_ID before importing numbers.');
  }

  for (const raw of cdrItems) {
    const cdr = normalizeCdr(raw, rangesById);
    if (!cdr.msisdn) { result.cdrsSkipped += 1; result.skipReasons.missingNumber += 1; continue; }
    const number = findLocalNumber(cdr.msisdn);
    // Import the carrier CDR even when the number is not currently assigned
    // to a client. db.ingestCarrierCdr stores it with clientId=null and will
    // only create an earning when a client is actually assigned. Previously
    // this early check silently discarded valid Lamix traffic and made the
    // sync report zero imported CDRs for inventory/agent-held numbers.
    let resolvedNumber = number;
    if (!resolvedNumber) resolvedNumber = db.ensureCarrierNumber({ msisdn: cdr.msisdn, ownerAdminId, carrierRangeId: cdr.rangeId, rangeName: first(raw, ['range','rangeName','range_name']), country: cdr.country, operator: cdr.operator });
    if (!resolvedNumber) {
      result.cdrsSkipped += 1;
      result.skipReasons.unmatchedMsisdn += 1;
      continue;
    }
    const externalId = cdr.externalId || `${cdr.msisdn}|${cdr.sender}|${cdr.createdAt}`;
    try {
      const outcome = db.ingestCarrierCdr({
        carrier: 'lamix',
        externalId,
        numberId: resolvedNumber.id,
        sender: cdr.sender,
        messageBody: cdr.messageBody,
        status: cdr.status,
        carrierRate: cdr.carrierRate,
        createdAt: cdr.createdAt,
        raw: cdr.raw,
      });
      if (outcome.created) result.cdrsImported += 1;
      else if (outcome.updated) result.cdrsUpdated += 1;
    } catch (e) {
      result.cdrsSkipped += 1;
      result.skipReasons.ingestError += 1;
      errors.push(`cdr ${externalId}: ${e.message}`);
    }
  }

  result.durationMs = Date.now() - startedAt;
  result.syncedAt = new Date().toISOString();
  result.cdrDiagnostics = lastCdrDiagnostics;
  result.numberDiagnostics = lastNumberDiagnostics;
  return result;
  } finally {
    db.endPersistenceBatch();
  }
}

async function syncInventoryOnly() {
  const startedAt = Date.now();
  db.beginPersistenceBatch();
  try {
  const c = config();
  if (!c.token) { const err = new Error('Lamix is not configured. Set LAMIX_API_TOKEN in the server environment.'); err.code='NOT_CONFIGURED'; throw err; }

  const errors = [];
  let ranges = [];
  let numbers = [];
  try { ranges = await fetchRanges(); } catch (e) { errors.push(`ranges: ${e.message}`); }
  try { numbers = await fetchNumbers(ranges); } catch (e) { errors.push(`numbers: ${e.message}`); }

  for (const range of ranges) {
    if (range.id !== null) db.upsertCarrierRange({
      carrier: 'lamix', externalId: range.id, name: range.name, sourceName: range.sourceName,
      country: range.country, operator: range.operator, rate: range.rate
    });
  }

  const rangesById = new Map(ranges.filter(r => r.id !== null).map(r => [String(r.id), r]));
  const ownerAdminId = c.ownerAdminId || db.findFirstUserByRole(db.ROLES.SUPER_ADMIN)?.id;
  const result = {
    rangesFetched: ranges.length,
    numbersFetched: numbers.length,
    cdrsFetched: 0,
    numbersImported: 0,
    numbersUpdated: 0,
    cdrsImported: 0,
    cdrsUpdated: 0,
    cdrsSkipped: 0,
    errors,
    skipReasons: { missingNumber: 0, unmatchedMsisdn: 0, ingestError: 0, duplicateOrExisting: 0 },
    backgroundInventory: true,
    syncedAt: new Date().toISOString(),
  };

  if (ownerAdminId) {
    const normalized = numbers.map(raw => normalizeNumber(raw, rangesById)).filter(n => n.msisdn);
    const outcome = db.upsertNumbersBulk({ normalizedNumbers: normalized, ownerAdminId });
    result.numbersImported = outcome.imported;
    result.numbersUpdated = outcome.updated;
    if (outcome.errors.length) errors.push(...outcome.errors);
  } else {
    errors.push('No Super Admin owner found. Set LAMIX_DEFAULT_OWNER_ADMIN_ID before importing numbers.');
  }

  result.durationMs = Date.now() - startedAt;
  result.numberDiagnostics = lastNumberDiagnostics;
  return result;
  } finally {
    db.endPersistenceBatch();
  }
}

let timer = null;
let inventoryTimer = null;
let lastResult = null;
let running = false;
let cdrRunning = false;
let inventoryRunning = false;
let browserAutoRunning = false;
let lastBrowserInventoryAt = 0;
const INVENTORY_POLL_INTERVAL_MS = Math.max(2000, Number(process.env.LAMIX_INVENTORY_POLL_INTERVAL_MS || 3000));

function getStatus() {
  return {
    ...safeConfig(),
    running,
    lastResult,
    cdrDiagnostics: lastCdrDiagnostics,
    numberDiagnostics: lastNumberDiagnostics,
  };
}

async function runBackgroundSync() {
  // This endpoint is intentionally CDR-only. Inventory/range scanning is much
  // heavier and used to run every few seconds alongside the CDR scan, making a
  // new OTP wait behind hundreds of number/range requests. Keep the live feed
  // path small and let inventory use its own slower schedule.
  if (!isConfigured()) return { skipped: true, reason: 'not configured', status: getStatus() };
  if (browserAutoRunning) return { skipped: true, reason: 'background CDR sync already running', status: getStatus() };
  const now = Date.now();
  if (now - lastBrowserCdrSyncAt < 1200) return { skipped: true, reason: 'background CDR sync cooldown', status: getStatus() };
  lastBrowserCdrSyncAt = now;
  browserAutoRunning = true;
  try {
    const cdr = await syncCdrOnly();
    lastResult = { ...(lastResult || {}), ...cdr, backgroundBrowser: true, backgroundBrowserAt: new Date().toISOString() };
    return lastResult;
  } finally {
    browserAutoRunning = false;
  }
}

async function runBackgroundInventorySync() {
  if (!isConfigured()) return { skipped: true, reason: 'not configured', status: getStatus() };
  if (inventoryRunning) return { skipped: true, reason: 'background inventory sync already running', status: getStatus() };
  inventoryRunning = true;
  try {
    const inventory = await syncInventoryOnly();
    lastBrowserInventoryAt = Date.now();
    lastResult = { ...(lastResult || {}), inventory, ...inventory, backgroundInventory: true, backgroundInventoryAt: new Date().toISOString() };
    return lastResult;
  } finally {
    inventoryRunning = false;
  }
}

async function runSync() {
  if (running) return { skipped: true, reason: 'sync already running', message: 'A sync is already running. Please wait for it to finish.', status: getStatus() };
  running = true;
  try {
    lastResult = await sync();
    return lastResult;
  } finally {
    running = false;
  }
}

function start() {
  if (timer || inventoryTimer) return;

  // CDR and inventory are deliberately independent background jobs. The old
  // implementation blocked inventory whenever the 1-second CDR job was active,
  // which could make automatic number/range refresh appear completely dead.
  timer = setInterval(() => {
    if (!isConfigured() || cdrRunning) return;
    cdrRunning = true;
    syncCdrOnly()
      .then(r => { lastResult = { ...(lastResult || {}), ...r, background: true, backgroundCdrAt: new Date().toISOString() }; })
      .catch(e => console.error('[Lamix] background CDR sync failed:', e.message))
      .finally(() => { cdrRunning = false; });
  }, POLL_INTERVAL_MS);

  inventoryTimer = setInterval(() => {
    if (!isConfigured() || inventoryRunning) return;
    inventoryRunning = true;
    syncInventoryOnly()
      .then(r => { lastResult = { ...(lastResult || {}), ...r, backgroundInventory: true, backgroundInventoryAt: new Date().toISOString() }; })
      .catch(e => console.error('[Lamix] background inventory sync failed:', e.message))
      .finally(() => { inventoryRunning = false; });
  }, INVENTORY_POLL_INTERVAL_MS);

  // Run immediately on startup, then continue on the interval. Inventory and
  // CDR jobs never consult the manual `running` flag, so a manual Sync Now can
  // never disable the automatic scanner.
  if (isConfigured()) {
    setTimeout(() => {
      if (inventoryRunning) return;
      inventoryRunning = true;
      syncInventoryOnly()
        .then(r => { lastResult = { ...(lastResult || {}), ...r, backgroundInventory: true, backgroundInventoryAt: new Date().toISOString() }; })
        .catch(e => console.error('[Lamix] startup inventory sync failed:', e.message))
        .finally(() => { inventoryRunning = false; });
    }, 250);
  }
}

module.exports = { config: safeConfig, isConfigured, testConnection, runSync, runBackgroundSync, runBackgroundInventorySync, getStatus, start, getTestPanelData };
