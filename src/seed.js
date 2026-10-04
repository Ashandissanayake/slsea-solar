// Synthetic SLSEA dataset: 9 provinces, 25 districts, 25 substations, 200 installations, 4 users and
// 673 fifteen-minute readings per installation (134 600 readings). Identical to the D1 version's fixture.
// Seeding is idempotent and resumable: existing documents are left untouched.

export const PROVINCES = [
  ['Western', ['Colombo', 'Gampaha', 'Kalutara']],
  ['Central', ['Kandy', 'Matale', 'Nuwara Eliya']],
  ['Southern', ['Galle', 'Matara', 'Hambantota']],
  ['Northern', ['Jaffna', 'Kilinochchi', 'Mannar', 'Mullaitivu', 'Vavuniya']],
  ['Eastern', ['Trincomalee', 'Batticaloa', 'Ampara']],
  ['North Western', ['Kurunegala', 'Puttalam']],
  ['North Central', ['Anuradhapura', 'Polonnaruwa']],
  ['Uva', ['Badulla', 'Monaragala']],
  ['Sabaragamuwa', ['Ratnapura', 'Kegalle']],
];

export const INSTALLATION_COUNT = 200;
export const TICK_COUNT = 673; // 30 Sep 2026 00:00 to 7 Oct 2026 00:00 (Asia/Colombo), both ends inclusive
export const READING_COUNT = INSTALLATION_COUNT * TICK_COUNT; // 134 600

const FIRST_TICK = Date.parse('2026-09-30T00:00:00+05:30');
const SUBSTATION_COUNT = 25;
const fixed = (value, digits) => Number(value.toFixed(digits));

/** The shared daylight curve: output fraction and cumulative energy fraction for each 15-minute tick. */
export function buildTicks() {
  let energy = 0;
  const ticks = [];
  for (let n = 0; n < TICK_COUNT; n++) {
    const hour = (n % 96) / 4;
    const fraction = hour >= 6 && hour <= 18 ? Math.sin((hour - 6) * Math.PI / 12) : 0;
    energy += fraction * 0.25;
    ticks.push({
      n,
      timestamp: new Date(FIRST_TICK + n * 900000),
      fraction: fixed(fraction, 6),
      energyFraction: fixed(energy, 6),
    });
  }
  return ticks;
}

const upsert = doc => ({ updateOne: { filter: { _id: doc._id }, update: { $setOnInsert: doc }, upsert: true } });

function isDuplicateKeyOnly(error) {
  if (error?.code === 11000) return true;
  const writeErrors = [].concat(error?.writeErrors ?? []);
  return writeErrors.length > 0 && writeErrors.every(w => w.code === 11000);
}

/** Reference data, users, installations and counters. */
export async function seedMetadata(db) {
  const provinceOps = [];
  const districtOps = [];
  const substationOps = [];
  const provinceOfDistrict = new Map();
  let districtId = 0;
  PROVINCES.forEach(([provinceName, districtNames], p) => {
    provinceOps.push(upsert({ _id: p + 1, name: provinceName }));
    for (const name of districtNames) {
      districtId++;
      provinceOfDistrict.set(districtId, p + 1);
      districtOps.push(upsert({ _id: districtId, province_id: p + 1, name }));
      substationOps.push(upsert({ _id: districtId, district_id: districtId, name: `${name} Grid` }));
    }
  });

  const userOps = [
    { _id: 1, username: 'asset-admin', role: 'admin', province_id: null, district_id: null },
    { _id: 2, username: 'national', role: 'national', province_id: null, district_id: null },
    { _id: 3, username: 'western', role: 'province', province_id: 1, district_id: null },
    { _id: 4, username: 'colombo', role: 'district', province_id: null, district_id: 1 },
  ].map(upsert);

  const installationOps = [];
  for (let i = 1; i <= INSTALLATION_COUNT; i++) {
    const substationId = ((i - 1) % SUBSTATION_COUNT) + 1; // substation n belongs to district n
    installationOps.push(upsert({
      _id: i,
      substation_id: substationId,
      district_id: substationId,
      province_id: provinceOfDistrict.get(substationId),
      name: `Solar Site ${String(i).padStart(3, '0')}`,
      meter_id: `SL-MTR-${String(i).padStart(6, '0')}`,
      capacity_kw: 3 + (i % 8) * 0.5,
      version: 1,
      lock_seq: 0,
    }));
  }

  const write = (name, ops) => db.collection(name).bulkWrite(ops, { ordered: false });
  await write('provinces', provinceOps);
  await write('districts', districtOps);
  await write('grid_substations', substationOps);
  await write('users', userOps);
  await write('installations', installationOps);

  // Ids for installations and readings created later through the API continue after the seeded ones.
  // Reserving the reading ids first guarantees API-created readings can never collide with seeded ones.
  await db.collection('counters').updateOne({ _id: 'installations' }, { $max: { seq: INSTALLATION_COUNT } }, { upsert: true });
  await db.collection('counters').updateOne({ _id: 'readings' }, { $max: { seq: READING_COUNT } }, { upsert: true });
  return { provinces: PROVINCES.length, districts: districtId, grid_substations: districtId, installations: INSTALLATION_COUNT, users: userOps.length };
}

/** Readings for installations first..last (inclusive). Skips installations that are already complete. */
export async function seedReadings(db, { first = 1, last = INSTALLATION_COUNT, log = () => {} } = {}) {
  const ticks = buildTicks();
  const readings = db.collection('readings');
  const installations = await db.collection('installations')
    .find({ _id: { $gte: first, $lte: last } }, { projection: { capacity_kw: 1 } })
    .sort({ _id: 1 }).toArray();

  let seeded = 0;
  for (const { _id: id, capacity_kw: capacity } of installations) {
    if (await readings.countDocuments({ installation_id: id }) >= TICK_COUNT) continue;
    const docs = ticks.map(t => ({
      _id: (id - 1) * TICK_COUNT + t.n + 1,
      installation_id: id,
      timestamp: t.timestamp,
      power_kw: fixed(capacity * t.fraction, 3),
      cumulative_energy_kwh: fixed(1000 + id * 10 + capacity * t.energyFraction, 3),
      voltage: fixed(230 + ((t.n + id) % 9) - 4, 1),
    }));
    try {
      await readings.insertMany(docs, { ordered: false });
    } catch (error) {
      if (!isDuplicateKeyOnly(error)) throw error; // resuming a partly seeded installation
    }
    seeded++;
    if (seeded % 20 === 0) log(`  readings seeded for ${seeded} installations...`);
  }
  return { installations_seeded: seeded };
}

export async function seedDatabase(db, { log = () => {} } = {}) {
  log('Seeding provinces, districts, substations, users and installations...');
  const metadata = await seedMetadata(db);
  log('Seeding readings...');
  const readings = await seedReadings(db, { log });
  return { ...metadata, ...readings, readings: await db.collection('readings').countDocuments({}) };
}
