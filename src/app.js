// SLSEA Solar Generation API: routing, authentication, authorisation, validation and representations.
//
// The handler takes a Fetch API Request and returns a Response (Node 22 provides both globally).
// It never touches the database directly: all persistence goes through the `store` (src/store.js, MongoDB).
// Behaviour, status codes, error bodies and ETags are the same as in the Cloudflare D1 version.

export const BASE = '/solar/v1.0';

export class ApiError extends Error {
  constructor(status, code, message, detail = {}) {
    super(message);
    Object.assign(this, { status, code, detail });
  }
}
const fail = (status, code, message, detail) => { throw new ApiError(status, code, message, detail); };

// ---------------------------------------------------------------------------------------------
// Encoding and token helpers
// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64 = str => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/** Per-installation device credential derived from DEVICE_MASTER. `secrets` needs DEVICE_MASTER. */
export async function deviceKey(secrets, id) {
  return `${id}.${await hmac(secrets.DEVICE_MASTER, `installation:${id}`)}`;
}

/** One-hour bearer token for a user id. `secrets` needs JWT_SECRET. */
export async function signToken(secrets, id) {
  const head = b64(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64(enc.encode(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600, iss: 'slsea-solar', aud: 'slsea-read' })));
  return `${head}.${body}.${await hmac(secrets.JWT_SECRET, `${head}.${body}`)}`;
}

const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

// ---------------------------------------------------------------------------------------------
// Authentication and authorisation
// ---------------------------------------------------------------------------------------------

/** kind: 'read' (any user), 'admin' (asset administrator only) or 'device' (X-Device-Key). */
async function authenticate(r, ctx, kind = 'read') {
  if (kind === 'device') {
    const key = r.headers.get('X-Device-Key') || '';
    const id = Number(key.split('.')[0]);
    if (!Number.isSafeInteger(id) || id < 1 || !safeEqual(key, await deviceKey(ctx, id))) {
      fail(401, 'UNAUTHENTICATED', 'Valid installation credentials are required.');
    }
    return { role: 'device', installation_id: id };
  }

  const token = (r.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const parts = token.split('.');
  let claim;
  try {
    if (parts.length !== 3 || !safeEqual(parts[2], await hmac(ctx.JWT_SECRET, `${parts[0]}.${parts[1]}`))) throw new Error('bad signature');
    claim = JSON.parse(new TextDecoder().decode(unb64(parts[1])));
    if (!(claim.exp > Date.now() / 1000) || claim.iss !== 'slsea-solar' || claim.aud !== 'slsea-read' || !Number.isSafeInteger(claim.sub)) {
      throw new Error('bad claims');
    }
  } catch {
    fail(401, 'UNAUTHENTICATED', 'A valid unexpired bearer token is required.');
  }
  const user = await ctx.store.getUserById(claim.sub); // database errors are not authentication failures
  if (!user) fail(401, 'UNAUTHENTICATED', 'A valid unexpired bearer token is required.');
  if (kind === 'admin' && user.role !== 'admin') fail(403, 'FORBIDDEN', 'Only the asset administrator can perform this operation.');
  return user;
}

function authorize(u, d) {
  if ((u.role === 'district' && u.district_id !== d.id) || (u.role === 'province' && u.province_id !== d.province_id)) {
    fail(403, 'JURISDICTION_DENIED', 'The resource is outside the authenticated jurisdiction.');
  }
}

// ---------------------------------------------------------------------------------------------
// Responses and request parsing
// ---------------------------------------------------------------------------------------------

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

async function entityTag(data) {
  return `"${b64(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(data))))}"`;
}

async function representation(r, data, status = 200, headers = {}) {
  const text = JSON.stringify(data);
  const etag = await entityTag(data);
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache, no-transform', Vary: 'Authorization', ETag: etag, ...headers };
  const ifNoneMatch = (r.headers.get('If-None-Match') || '').split(',');
  if (status === 200 && r.method === 'GET' && ifNoneMatch.some(v => v.trim() === '*' || v.trim().replace(/^W\//, '') === etag)) {
    return new Response(null, { status: 304, headers: h });
  }
  return new Response(text, { status, headers: h });
}

function idValue(s) {
  if (!/^\d+$/.test(s) || Number(s) < 1 || !Number.isSafeInteger(Number(s))) fail(400, 'INVALID_ID', 'Identifiers must be positive integers.');
  return Number(s);
}

async function body(r, fields) {
  if (!(r.headers.get('Content-Type') || '').startsWith('application/json')) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request bodies must use application/json.');
  if (Number(r.headers.get('Content-Length') || 0) > 16384) fail(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 16 KiB.');
  const text = await r.text();
  if (enc.encode(text).length > 16384) fail(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 16 KiB.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail(400, 'INVALID_JSON', 'The request body is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(422, 'VALIDATION_ERROR', 'A JSON object is required.');
  const extra = Object.keys(parsed).filter(k => !fields.includes(k));
  if (extra.length) fail(422, 'VALIDATION_ERROR', 'Unknown properties are not accepted.', { properties: extra });
  return parsed;
}

function query(url, allowed) {
  for (const [k] of url.searchParams) {
    if (!allowed.includes(k) || url.searchParams.getAll(k).length > 1) fail(400, 'INVALID_QUERY', 'Unknown or repeated query parameter.', { parameter: k });
  }
}

function timeValue(v, field) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(v || '') || !Number.isFinite(Date.parse(v))) {
    fail(422, 'VALIDATION_ERROR', 'Timestamps must be RFC 3339 values with an explicit offset.', { field });
  }
  return new Date(v).toISOString();
}

/** province_id, district_id and substation_id query filters as validated integers. */
function idFilters(url) {
  const filters = {};
  for (const name of ['province_id', 'district_id', 'substation_id']) {
    if (url.searchParams.has(name)) filters[name] = idValue(url.searchParams.get(name));
  }
  return filters;
}

// ---------------------------------------------------------------------------------------------
// Lookups that answer 404 when the row is missing
// ---------------------------------------------------------------------------------------------

async function getInstallation(ctx, id) {
  const row = await ctx.store.getInstallation(id);
  if (!row) fail(404, 'NOT_FOUND', 'Installation not found.');
  return row;
}
async function getDistrict(ctx, id) {
  const row = await ctx.store.getDistrict(id);
  if (!row) fail(404, 'NOT_FOUND', 'District not found.');
  return row;
}
async function getSubstation(ctx, id) {
  const row = await ctx.store.getSubstation(id);
  if (!row) fail(404, 'NOT_FOUND', 'Grid substation not found.');
  return row;
}
const assetData = i => ({ id: i.id, substation_id: i.substation_id, name: i.name, meter_id: i.meter_id, capacity_kw: i.capacity_kw, version: i.version });

// ---------------------------------------------------------------------------------------------
// Collections: provinces, districts, grid substations, installations
// ---------------------------------------------------------------------------------------------

async function collection(r, ctx, url, u, type, parent) {
  const { store } = ctx;
  let items;
  if (type === 'provinces') {
    items = await store.listProvinces(u);
  }
  if (type === 'districts') {
    if (!await store.getProvince(parent)) fail(404, 'NOT_FOUND', 'Province not found.');
    if (u.role === 'province' && u.province_id !== parent) fail(403, 'JURISDICTION_DENIED', 'Province is outside the authenticated jurisdiction.');
    if (u.role === 'district' && (await getDistrict(ctx, u.district_id)).province_id !== parent) {
      fail(403, 'JURISDICTION_DENIED', 'Province is outside the authenticated jurisdiction.');
    }
    items = await store.listDistricts(u, parent);
  }
  if (type === 'grid-substations') {
    authorize(u, await getDistrict(ctx, parent));
    items = await store.listSubstations(parent);
  }
  if (type === 'installations') {
    query(url, ['province_id', 'district_id', 'substation_id']);
    if (parent) {
      const s = await getSubstation(ctx, parent);
      authorize(u, { id: s.district_id, province_id: s.province_id });
    }
    items = await store.listInstallations(u, { substationId: parent, filters: idFilters(url) });
  }
  return representation(r, { items, total_count: items.length });
}

// ---------------------------------------------------------------------------------------------
// Reading history
// ---------------------------------------------------------------------------------------------

async function history(r, ctx, url, u, installationId) {
  query(url, ['offset', 'limit', 'sort', 'from', 'to', 'province_id', 'district_id', 'substation_id']);
  if (installationId) {
    const i = await getInstallation(ctx, installationId);
    authorize(u, { id: i.district_id, province_id: i.province_id });
  }
  const filters = idFilters(url);
  let from;
  let to;
  if (url.searchParams.has('from')) from = timeValue(url.searchParams.get('from'), 'from');
  if (url.searchParams.has('to')) to = timeValue(url.searchParams.get('to'), 'to');
  if (from && to && from >= to) fail(400, 'INVALID_WINDOW', 'from must precede to.');

  const offset = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 25);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail(400, 'INVALID_PAGINATION', 'offset must be non-negative and limit must be between 1 and 100.');
  }
  const sort = url.searchParams.get('sort') || '-timestamp';
  if (!['timestamp', '-timestamp'].includes(sort)) fail(400, 'INVALID_SORT', 'sort must be timestamp or -timestamp.');

  const { total, items } = await ctx.store.readingHistory({
    user: u, installationId, filters, from, to, dir: sort[0] === '-' ? -1 : 1, offset, limit,
  });

  const link = o => {
    const next = new URL(url);
    next.searchParams.set('offset', o);
    next.searchParams.set('limit', limit);
    return next.href;
  };
  const links = {
    self: link(offset),
    next: offset + limit < total ? link(offset + limit) : null,
    previous: offset > 0 ? link(Math.max(0, offset - limit)) : null,
  };
  const headerLinks = [
    links.next ? `<${links.next}>; rel="next"` : null,
    links.previous ? `<${links.previous}>; rel="prev"` : null,
  ].filter(Boolean).join(', ');
  return representation(r, { items, total_count: total, offset, limit, links }, 200, headerLinks ? { Link: headerLinks } : {});
}

// ---------------------------------------------------------------------------------------------
// Device ingestion
// ---------------------------------------------------------------------------------------------

async function ingest(r, ctx, id) {
  const device = await authenticate(r, ctx, 'device');
  if (device.installation_id !== id) fail(403, 'INSTALLATION_DENIED', 'Device credentials permit ingestion for one installation only.');
  const installation = await getInstallation(ctx, id);

  const b = await body(r, ['timestamp', 'power_kw', 'cumulative_energy_kwh', 'voltage']);
  const timestamp = timeValue(b.timestamp, 'timestamp');
  for (const k of ['power_kw', 'cumulative_energy_kwh', 'voltage']) {
    if (typeof b[k] !== 'number' || !Number.isFinite(b[k]) || b[k] < 0) fail(422, 'VALIDATION_ERROR', 'Non-negative finite numbers are required.', { field: k });
  }
  if (b.power_kw > installation.capacity_kw * 1.2 || b.voltage > 300 || Date.parse(timestamp) > Date.now() + 300000) {
    fail(422, 'VALIDATION_ERROR', 'Reading exceeds physical bounds or the permitted clock tolerance.');
  }

  const location = new URL(`${BASE}/installations/${id}/readings/`, r.url).href;
  const existing = await ctx.store.findReading(id, timestamp);
  if (existing) {
    if (existing.power_kw === b.power_kw && existing.cumulative_energy_kwh === b.cumulative_energy_kwh && existing.voltage === b.voltage) {
      return representation(r, existing, 200, { Location: location + existing.id }); // identical retry
    }
    fail(409, 'READING_CONFLICT', 'A different reading already occupies this installation timestamp.');
  }

  // The store enforces monotonic cumulative counters atomically (transaction), as well as on retries.
  const result = await ctx.store.insertReading(id, timestamp, {
    power_kw: b.power_kw, cumulative_energy_kwh: b.cumulative_energy_kwh, voltage: b.voltage,
  });
  if (result.status === 'missing') fail(404, 'NOT_FOUND', 'Installation not found.');
  if (result.status !== 'created') fail(409, 'COUNTER_CONFLICT', 'Reading conflicts with the existing cumulative counter or a concurrent insertion.');
  return representation(r, result.reading, 201, { Location: location + result.reading.id });
}

// ---------------------------------------------------------------------------------------------
// Asset administration
// ---------------------------------------------------------------------------------------------

function validateAsset(b) {
  for (const k of ['name', 'meter_id']) {
    if (typeof b[k] !== 'string' || b[k].trim().length < 1 || b[k].length > 120) {
      fail(422, 'VALIDATION_ERROR', 'name and meter_id must contain 1 to 120 characters.', { field: k });
    }
  }
  if (typeof b.capacity_kw !== 'number' || !Number.isFinite(b.capacity_kw) || b.capacity_kw <= 0 || b.capacity_kw > 1000) {
    fail(422, 'VALIDATION_ERROR', 'capacity_kw must be positive and no greater than 1000.');
  }
  return { ...b, substation_id: idValue(String(b.substation_id)) };
}

async function mutateAsset(r, ctx, id, parent) {
  await authenticate(r, ctx, 'admin');
  const { store } = ctx;

  if (r.method === 'POST') {
    const b = validateAsset({ ...await body(r, ['name', 'meter_id', 'capacity_kw']), substation_id: parent });
    const substation = await getSubstation(ctx, parent);
    const created = await store.createInstallation(substation, b);
    return representation(r, created, 201, { Location: new URL(`${BASE}/installations/${created.id}`, r.url).href });
  }

  const current = await store.getInstallation(id);
  if (!current) {
    if (r.method === 'DELETE') return new Response(null, { status: 204 });
    fail(404, 'NOT_FOUND', 'Installation not found.');
  }
  const etag = await entityTag(assetData(current));
  if (!r.headers.has('If-Match')) fail(428, 'PRECONDITION_REQUIRED', 'If-Match is required for installation changes.');
  if (r.headers.get('If-Match') !== etag) fail(412, 'PRECONDITION_FAILED', 'The installation has changed since it was retrieved.');

  if (r.method === 'DELETE') {
    const result = await store.deleteInstallation(id, current.version);
    if (result === 'history') fail(409, 'HISTORY_PROTECTED', 'An installation with historical readings cannot be deleted.');
    if (result === 'stale') fail(412, 'PRECONDITION_FAILED', 'A concurrent change prevented deletion.');
    return new Response(null, { status: 204 });
  }

  const b = validateAsset(await body(r, ['substation_id', 'name', 'meter_id', 'capacity_kw']));
  const substation = await getSubstation(ctx, b.substation_id);
  if (current.name === b.name && current.meter_id === b.meter_id && current.capacity_kw === b.capacity_kw && current.substation_id === b.substation_id) {
    return representation(r, assetData(current)); // idempotent replacement
  }
  const moving = b.substation_id !== current.substation_id;
  const result = await store.replaceInstallation(id, current.version, b, substation, moving);
  if (result.status === 'history') fail(409, 'HISTORY_PROTECTED', 'Moving an installation with history would rewrite its historical jurisdiction.');
  if (result.status === 'stale') fail(412, 'PRECONDITION_FAILED', 'A concurrent change prevented replacement.');
  return representation(r, result.installation);
}

// ---------------------------------------------------------------------------------------------
// District generation summary
// ---------------------------------------------------------------------------------------------

async function summary(r, ctx, url, u, id) {
  query(url, ['date']);
  authorize(u, await getDistrict(ctx, id));
  // Default to the current civil day in Sri Lanka (UTC+05:30).
  const day = url.searchParams.get('date') || new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day))) fail(400, 'INVALID_DATE', 'date must be a valid YYYY-MM-DD date.');
  const start = new Date(`${day}T00:00:00+05:30`).toISOString();
  const end = new Date(Date.parse(start) + 86400000).toISOString();
  const now = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();

  const rows = await ctx.store.districtSnapshot(id, start, end);
  const fresh = rows.filter(x => x.timestamp && Date.parse(now) - Date.parse(x.timestamp) <= 30 * 60000);
  const coverage = rows.filter(x => x.start_energy !== null && x.finish_energy !== null);
  return representation(r, {
    district_id: id,
    date: day,
    timezone: 'Asia/Colombo',
    as_of: now,
    installation_count: rows.length,
    reporting_count: rows.filter(x => x.timestamp).length,
    fresh_installation_count: fresh.length,
    stale_installation_count: rows.length - fresh.length,
    last_known_total_power_kw: +rows.reduce((s, x) => s + (x.power_kw || 0), 0).toFixed(3),
    current_total_power_kw: +fresh.reduce((s, x) => s + x.power_kw, 0).toFixed(3),
    energy_kwh: +coverage.reduce((s, x) => s + Math.max(0, x.finish_energy - x.start_energy), 0).toFixed(3),
    energy_covered_installations: coverage.length,
    energy_complete: coverage.length === rows.length && Date.parse(end) <= Date.now(),
  });
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

const pattern = suffix => new RegExp(`^${BASE}${suffix}$`);
const ROUTES = {
  readings: pattern('/installations/(\\d+)/readings'),
  substationInstallations: pattern('/grid-substations/(\\d+)/installations'),
  installationItem: pattern('/installations/(\\d+)'),
  provinceDistricts: pattern('/provinces/(\\d+)/districts'),
  province: pattern('/provinces/(\\d+)'),
  districtSubstations: pattern('/districts/(\\d+)/grid-substations'),
  districtSummary: pattern('/districts/(\\d+)/generation-summary'),
  district: pattern('/districts/(\\d+)'),
  substation: pattern('/grid-substations/(\\d+)'),
  installationDetail: pattern('/installations/(\\d+)(?:/(composite|last-known-reading|readings)(?:/(\\d+))?)?'),
};

async function route(r, ctx) {
  const url = new URL(r.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const method = r.method;
  const { store, assets } = ctx;

  // Documentation and contract
  if (path === '/' || path === '/docs') return new Response(assets.DOCS, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  if (path === '/openapi.json') return json(assets.OPENAPI);
  if (path === '/swagger-ui-bundle.js') return new Response(assets.SWAGGER_JS, { headers: { 'Content-Type': 'application/javascript' } });
  if (path === '/swagger-ui.css') return new Response(assets.SWAGGER_CSS, { headers: { 'Content-Type': 'text/css' } });

  // Health
  if (path === `${BASE}/health` && method === 'GET') {
    return representation(r, { status: 'ok', database: 'connected', seed_reading_count: await store.readingCount(), version: '1.0.0' });
  }

  // Authentication
  if (path === `${BASE}/auth/tokens` && method === 'POST') {
    const b = await body(r, ['username', 'password']);
    if (!safeEqual(b.password, ctx.USER_PASSWORD)) fail(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    // Only plain strings may reach the database query (prevents operator injection such as {"$ne": null}).
    const user = typeof b.username === 'string' ? await store.getUserByUsername(b.username) : null;
    if (!user) fail(401, 'INVALID_CREDENTIALS', 'Invalid username or password.');
    return json({ access_token: await signToken(ctx, user.id), token_type: 'Bearer', expires_in: 3600, user });
  }

  // Writes
  let m;
  if ((m = path.match(ROUTES.readings)) && method === 'POST') return ingest(r, ctx, idValue(m[1]));
  if ((m = path.match(ROUTES.substationInstallations)) && method === 'POST') return mutateAsset(r, ctx, null, idValue(m[1]));
  if ((m = path.match(ROUTES.installationItem)) && ['PUT', 'DELETE'].includes(method)) return mutateAsset(r, ctx, idValue(m[1]));

  const known = ctx.knownPaths.some(re => re.test(path));
  if (method !== 'GET') {
    if (known) fail(405, 'METHOD_NOT_ALLOWED', 'This HTTP method is not supported.', { allowed: ['GET'] });
    fail(404, 'NOT_FOUND', 'Resource not found.');
  }

  // Reads (authenticated)
  const u = await authenticate(r, ctx);
  if (path === `${BASE}/provinces`) return collection(r, ctx, url, u, 'provinces');
  if ((m = path.match(ROUTES.provinceDistricts))) return collection(r, ctx, url, u, 'districts', idValue(m[1]));
  if ((m = path.match(ROUTES.province))) {
    const id = idValue(m[1]);
    const p = await store.getProvince(id);
    if (!p) fail(404, 'NOT_FOUND', 'Province not found.');
    if (u.role === 'province' && u.province_id !== id) fail(403, 'JURISDICTION_DENIED', 'Province outside jurisdiction.');
    if (u.role === 'district' && (await getDistrict(ctx, u.district_id)).province_id !== id) fail(403, 'JURISDICTION_DENIED', 'Province outside jurisdiction.');
    return representation(r, p);
  }
  if ((m = path.match(ROUTES.districtSubstations))) return collection(r, ctx, url, u, 'grid-substations', idValue(m[1]));
  if ((m = path.match(ROUTES.districtSummary))) return summary(r, ctx, url, u, idValue(m[1]));
  if ((m = path.match(ROUTES.district))) {
    const d = await getDistrict(ctx, idValue(m[1]));
    authorize(u, d);
    return representation(r, d);
  }
  if ((m = path.match(ROUTES.substationInstallations))) return collection(r, ctx, url, u, 'installations', idValue(m[1]));
  if ((m = path.match(ROUTES.substation))) {
    const s = await getSubstation(ctx, idValue(m[1]));
    authorize(u, { id: s.district_id, province_id: s.province_id });
    return representation(r, { id: s.id, district_id: s.district_id, name: s.name });
  }
  if (path === `${BASE}/installations`) return collection(r, ctx, url, u, 'installations');
  if (path === `${BASE}/readings`) return history(r, ctx, url, u);

  if ((m = path.match(ROUTES.installationDetail))) {
    const id = idValue(m[1]);
    const i = await getInstallation(ctx, id);
    authorize(u, { id: i.district_id, province_id: i.province_id });
    const data = assetData(i);
    const [, , part, readingId] = m;
    if (!part) return representation(r, data);
    if (part === 'readings' && !readingId) return history(r, ctx, url, u, id);
    if (part === 'readings') {
      const row = await store.getReading(id, idValue(readingId));
      if (!row) fail(404, 'NOT_FOUND', 'Reading not found for this installation.');
      return representation(r, row);
    }
    const last = await store.lastReading(id);
    if (part === 'last-known-reading') {
      if (!last) fail(404, 'NO_READINGS', 'Installation has no readings.');
      return representation(r, last);
    }
    const [s, d, p, count] = await Promise.all([
      getSubstation(ctx, i.substation_id),
      getDistrict(ctx, i.district_id),
      store.getProvince(i.province_id),
      store.countReadings(id),
    ]);
    return representation(r, {
      installation: data,
      grid_substation: { id: s.id, name: s.name, district_id: s.district_id },
      district: d,
      province: p,
      last_known_reading: last,
      reading_count: count,
    });
  }
  fail(404, 'NOT_FOUND', 'Resource not found.');
}

const acceptsJson = r => r.headers.get('Accept').split(',').some(x => x.includes('application/json') || x.includes('*/*') || x.includes('text/html'));

async function handle(r, ctx) {
  try {
    if (r.headers.has('Accept') && !acceptsJson(r) && !new URL(r.url).pathname.match(/\.(js|css)$/)) {
      fail(406, 'NOT_ACCEPTABLE', 'The API provides JSON representations.');
    }
    return await route(r, ctx);
  } catch (e) {
    if (e instanceof ApiError) {
      return json({ error: { code: e.code, message: e.message, detail: e.detail } }, e.status, {
        ...(e.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="slsea"' } : {}),
        ...(e.status === 405 ? { Allow: 'GET' } : {}),
      });
    }
    if (e?.code === 11000) { // MongoDB duplicate key (for example a repeated meter_id)
      return json({ error: { code: 'RESOURCE_CONFLICT', message: 'A unique resource identifier already exists.', detail: {} } }, 409);
    }
    if (e?.name === 'MongoServerSelectionError' || e?.name === 'MongoNetworkError') {
      console.error('Database unavailable', String(e.message));
      return json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The database is temporarily unavailable.', detail: {} } }, 503, { 'Retry-After': '5' });
    }
    console.error('Unhandled API error', String(e?.message ?? e));
    return json({ error: { code: 'INTERNAL_ERROR', message: 'The service could not complete the request.', detail: {} } }, 500);
  }
}

/**
 * @param store    data-access object from createStore()
 * @param secrets  { JWT_SECRET, DEVICE_MASTER, USER_PASSWORD }
 * @param assets   { OPENAPI, DOCS, SWAGGER_JS, SWAGGER_CSS } from loadAssets()
 * @returns        { fetch(request): Promise<Response> }
 */
export function createApp({ store, secrets, assets }) {
  const knownPaths = Object.keys(assets.OPENAPI.paths).map(p => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`));
  const ctx = { ...secrets, store, assets, knownPaths };
  return { fetch: request => handle(request, ctx) };
}
