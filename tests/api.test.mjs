// HTTP-level regression suite (ported from the Cloudflare D1 version).
//
//   npm test            runs against an in-memory MongoDB stand-in (no database needed)
//   npm run test:atlas  runs against MongoDB Atlas using MONGODB_URI from .env, in a temporary
//                       database ("slsea_test_<timestamp>") that is dropped afterwards
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createApp, deviceKey } from '../src/app.js';
import { createStore } from '../src/store.js';
import { ensureSchema } from '../src/schema.js';
import { seedDatabase, READING_COUNT, TICK_COUNT, INSTALLATION_COUNT } from '../src/seed.js';
import { loadAssets } from '../src/assets.js';

const useAtlas = process.argv.includes('--atlas');
let client;
let db;
if (useAtlas) {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be set (in .env) to run the Atlas tests.');
  const { MongoClient } = await import('mongodb');
  client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db(`slsea_test_${Date.now()}`);
} else {
  const { createFakeClient } = await import('./helpers/fake-mongo.js');
  client = createFakeClient();
  db = client.db('slsea_test');
}
console.log(useAtlas ? `Using MongoDB Atlas (temporary database ${db.databaseName})` : 'Using the in-memory MongoDB stand-in');

const secrets = { JWT_SECRET: 'test-jwt-secret', DEVICE_MASTER: 'test-device-master', USER_PASSWORD: 'test-password' };
const evidence = [];
let checks = 0;

try {
  await ensureSchema(db, { warn: message => console.warn('schema warning:', message) });
  console.log('Seeding...');
  await seedDatabase(db);
  const app = createApp({ store: createStore({ client, db }), secrets, assets: loadAssets() });

  async function call(method, path, { token, device, body, headers = {}, expected = 200, label } = {}) {
    const request = new Request('https://api.example' + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(device ? { 'X-Device-Key': device } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const r = await app.fetch(request);
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    assert.equal(r.status, expected, `${label || path}: ${raw}`);
    checks++;
    evidence.push({ label: label || `${method} ${path}`, status: r.status });
    return { r, data, raw };
  }

  const b = '/solar/v1.0';
  async function login(username) {
    return (await call('POST', b + '/auth/tokens', { body: { username, password: secrets.USER_PASSWORD } })).data.access_token;
  }

  // ---- Seed fixture ----
  const admin = await login('asset-admin');
  const national = await login('national');
  const province = await login('western');
  const district = await login('colombo');
  assert.equal(await db.collection('readings').countDocuments({}), READING_COUNT);
  const readingOwners = await db.collection('readings').distinct('installation_id');
  assert.equal(readingOwners.length, INSTALLATION_COUNT); // every reading belongs to a seeded installation
  assert.equal(await db.collection('installations').countDocuments({}), INSTALLATION_COUNT);
  checks += 3;

  // ---- Every read endpoint responds for a national user ----
  for (const path of ['/health', '/provinces', '/provinces/1', '/provinces/1/districts', '/districts/1', '/districts/1/grid-substations',
    '/grid-substations/1', '/grid-substations/1/installations', '/installations', '/installations/1', '/installations/1/composite',
    '/installations/1/last-known-reading', '/installations/1/readings', '/installations/1/readings/1', '/readings',
    '/districts/1/generation-summary']) {
    await call('GET', b + path, { token: national });
  }

  // ---- Pagination, sorting and filters ----
  const page = await call('GET', b + '/installations/1/readings?limit=10&sort=timestamp', { token: national });
  assert.equal(page.data.total_count, TICK_COUNT);
  assert.equal(page.data.items.length, 10);
  assert.ok(page.data.links.next);
  checks += 3;
  const nextUrl = new URL(page.data.links.next);
  const next = await call('GET', nextUrl.pathname + nextUrl.search, { token: national });
  assert.ok(next.data.links.previous);
  assert.ok(next.data.items[0].timestamp > page.data.items[9].timestamp);
  checks += 2;
  const filtered = await call('GET',
    b + '/readings?district_id=1&province_id=1&substation_id=1&from=2026-10-01T00:00:00%2B05:30&to=2026-10-02T00:00:00%2B05:30&sort=timestamp&limit=100',
    { token: national });
  assert.equal(filtered.data.total_count, 768); // 8 installations x 96 quarter-hours in one civil day
  checks++;

  // ---- Representation validators (ETag / 304) ----
  for (const path of ['/installations/1', '/installations/1/composite', '/installations/1/last-known-reading', '/installations/1/readings', '/provinces']) {
    const got = await call('GET', b + path, { token: national });
    const cached = await call('GET', b + path, { token: national, headers: { 'If-None-Match': 'W/' + got.r.headers.get('ETag') }, expected: 304 });
    assert.equal(cached.raw, '');
    checks++;
  }

  // ---- Jurisdiction scoping ----
  await call('GET', b + '/districts/2', { token: district, expected: 403 });
  await call('GET', b + '/installations/2', { token: district, expected: 403 });
  await call('GET', b + '/provinces/2/districts', { token: province, expected: 403 });
  const visible = await call('GET', b + '/installations', { token: district });
  assert.equal(visible.data.total_count, 8);
  checks++;
  await call('GET', b + '/readings?district_id=2', { token: district }); // intersection with scope: allowed, empty
  const emptyScope = await call('GET', b + '/readings?district_id=2', { token: district });
  assert.equal(emptyScope.data.total_count, 0);
  checks++;
  const provinceView = await call('GET', b + '/installations', { token: province });
  assert.equal(provinceView.data.total_count, 24); // Western province: Colombo, Gampaha, Kalutara = 3 substations x 8
  checks++;

  // ---- Authentication and request errors ----
  await call('GET', b + '/provinces', { expected: 401 });
  await call('POST', b + '/auth/tokens', { body: { username: 'national', password: 'wrong' }, expected: 401 });
  await call('POST', b + '/auth/tokens', { body: { username: { $ne: null }, password: secrets.USER_PASSWORD }, expected: 401, label: 'operator injection in username' });
  await call('GET', b + '/installations/999', { token: national, expected: 404 });
  await call('GET', b + '/readings?limit=101', { token: national, expected: 400 });
  await call('GET', b + '/readings?sort=power_kw', { token: national, expected: 400 });
  await call('GET', b + '/readings?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z', { token: national, expected: 400 });
  await call('GET', b + '/readings?unknown=1', { token: national, expected: 400 });
  await call('GET', b + '/provinces', { token: national, headers: { Accept: 'application/xml' }, expected: 406 });
  await call('POST', '/maintenance/seed', { token: admin, body: { phase: 'metadata' }, expected: 404, label: 'maintenance endpoints are gone' });

  // ---- Device ingestion ----
  const dk = await deviceKey(secrets, 1);
  const reading = { timestamp: '2026-10-07T20:00:00Z', power_kw: 0, cumulative_energy_kwh: 1600, voltage: 230 };
  const created = await call('POST', b + '/installations/1/readings', { device: dk, body: reading, expected: 201 });
  assert.ok(created.r.headers.get('Location'));
  checks++;
  const stored = await call('GET', new URL(created.r.headers.get('Location')).pathname, { token: national });
  assert.equal(stored.data.timestamp, '2026-10-07T20:00:00.000Z');
  assert.equal(stored.data.id, READING_COUNT + 1); // ids continue after the seeded readings
  checks += 2;
  await call('POST', b + '/installations/1/readings', { device: dk, body: reading }); // identical retry -> 200
  await call('POST', b + '/installations/1/readings', { device: dk, body: { ...reading, voltage: 231 }, expected: 409 });
  await call('POST', b + '/installations/2/readings', { device: dk, body: reading, expected: 403 });
  await call('POST', b + '/installations/1/readings', { token: national, body: reading, expected: 401 });
  await call('GET', b + '/installations/1', { device: dk, expected: 401 });
  await call('POST', b + '/installations/1/readings', { device: dk, body: { ...reading, power_kw: -1 }, expected: 422 });
  await call('POST', b + '/installations/1/readings', { device: dk, body: { ...reading, timestamp: '2026-10-07T20:15:00Z', cumulative_energy_kwh: 1000 }, expected: 409 }); // counter went backwards
  await call('POST', b + '/installations/1/readings', { device: dk, body: { ...reading, timestamp: '2026-10-07T19:45:00Z', cumulative_energy_kwh: 1700 }, expected: 409 }); // earlier instant but larger counter
  await call('POST', b + '/installations/1/readings', { device: dk, body: { ...reading, timestamp: '2026-10-07T20:15:00Z', cumulative_energy_kwh: 1601 }, expected: 201 });
  await call('POST', b + '/installations/1/readings', { device: dk, body: { ...reading, timestamp: '2099-01-01T00:00:00Z' }, expected: 422 }); // future clock

  // Readings are append-only: the API offers no way to change or remove them.
  await call('PUT', b + '/installations/1/readings/1', { token: admin, body: reading, expected: 405 });
  await call('DELETE', b + '/installations/1/readings/1', { token: admin, expected: 405 });
  await call('PATCH', b + '/installations/1/readings/1', { token: admin, body: reading, expected: 405 });
  assert.equal(await db.collection('readings').countDocuments({ _id: 1 }), 1);
  checks++;

  // ---- Asset administration (optimistic concurrency with If-Match) ----
  const input = { name: 'Test Solar Asset', meter_id: 'TEST-MTR-001', capacity_kw: 5 };
  await call('POST', b + '/grid-substations/1/installations', { token: national, body: input, expected: 403 });
  const asset = await call('POST', b + '/grid-substations/1/installations', { token: admin, body: input, expected: 201 });
  const id = asset.data.id;
  assert.equal(id, INSTALLATION_COUNT + 1);
  checks++;
  await call('POST', b + '/grid-substations/1/installations', { token: admin, body: input, expected: 409, label: 'duplicate meter_id' });
  let got = await call('GET', b + '/installations/' + id, { token: admin });
  await call('PUT', b + '/installations/' + id, { token: admin, body: { ...input, substation_id: 1 }, expected: 428 });
  await call('PUT', b + '/installations/' + id, { token: admin, headers: { 'If-Match': '"wrong"' }, body: { ...input, substation_id: 1 }, expected: 412 });
  const replaced = await call('PUT', b + '/installations/' + id, { token: admin, headers: { 'If-Match': got.r.headers.get('ETag') }, body: { ...input, name: 'Replaced Asset', substation_id: 1 } });
  const retry = await call('PUT', b + '/installations/' + id, { token: admin, headers: { 'If-Match': replaced.r.headers.get('ETag') }, body: { ...input, name: 'Replaced Asset', substation_id: 1 } });
  assert.equal(retry.data.version, replaced.data.version); // identical replacement is idempotent
  assert.equal(replaced.data.version, 2);
  checks += 2;
  // An asset without history may move to another substation (and then belongs to another jurisdiction).
  const moved = await call('PUT', b + '/installations/' + id, { token: admin, headers: { 'If-Match': retry.r.headers.get('ETag') }, body: { ...input, name: 'Replaced Asset', substation_id: 2 } });
  assert.equal(moved.data.substation_id, 2);
  await call('GET', b + '/installations/' + id, { token: district, expected: 403 });
  const district2Assets = await call('GET', b + '/grid-substations/2/installations', { token: national });
  assert.ok(district2Assets.data.items.some(x => x.id === id));
  checks += 2;
  await call('DELETE', b + '/installations/' + id, { token: admin, headers: { 'If-Match': moved.r.headers.get('ETag') }, expected: 204 });
  await call('DELETE', b + '/installations/' + id, { token: admin, expected: 204 }); // idempotent
  await call('GET', b + '/installations/' + id, { token: admin, expected: 404 });

  // History protection: an installation with readings cannot be deleted or moved.
  got = await call('GET', b + '/installations/1', { token: admin });
  await call('DELETE', b + '/installations/1', { token: admin, headers: { 'If-Match': got.r.headers.get('ETag') }, expected: 409 });
  await call('PUT', b + '/installations/1', { token: admin, headers: { 'If-Match': got.r.headers.get('ETag') }, body: { name: got.data.name, meter_id: got.data.meter_id, capacity_kw: got.data.capacity_kw, substation_id: 2 }, expected: 409 });

  // ---- Generation summary ----
  const summary = await call('GET', b + '/districts/1/generation-summary?date=2026-10-01', { token: national });
  assert.equal(summary.data.installation_count, 8);
  assert.equal(summary.data.energy_covered_installations, 8);
  assert.equal(summary.data.energy_complete, true);
  assert.ok(summary.data.energy_kwh > 0);
  checks += 4;
  await call('GET', b + '/districts/1/generation-summary?date=nope', { token: national, expected: 400 });
  await call('GET', b + '/districts/2/generation-summary', { token: district, expected: 403 });

  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify({
    passed: checks,
    failed: 0,
    store: useAtlas ? 'MongoDB Atlas' : 'in-memory MongoDB stand-in (tests/helpers/fake-mongo.js)',
    seed: { provinces: 9, districts: 25, substations: 25, installations: INSTALLATION_COUNT, readings: READING_COUNT },
    evidence,
  }, null, 2));
  console.log(`${checks} assertions passed against ${useAtlas ? 'MongoDB Atlas' : 'the in-memory stand-in'}; full seed and authorization verified.`);
} finally {
  if (useAtlas) await db.dropDatabase();
  await client.close();
}
