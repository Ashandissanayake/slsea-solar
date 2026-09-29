// MongoDB schema: collections, indexes and server-side validation.
// This replaces drizzle/0000_solar_schema.sql from the Cloudflare D1 version.
//
// Identifiers stay integers (stored as _id) so the public API contract is unchanged.

export const COLLECTION_NAMES = [
  'provinces', 'districts', 'grid_substations', 'installations', 'users', 'readings', 'counters',
];

const int = ['int', 'long'];

// $jsonSchema validators correspond to the CHECK constraints in the SQL schema.
export const VALIDATORS = {
  installations: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['substation_id', 'district_id', 'province_id', 'name', 'meter_id', 'capacity_kw', 'version'],
      properties: {
        substation_id: { bsonType: int },
        district_id: { bsonType: int },
        province_id: { bsonType: int },
        name: { bsonType: 'string', minLength: 1 },
        meter_id: { bsonType: 'string', minLength: 1 },
        capacity_kw: { bsonType: 'number', minimum: 0, exclusiveMinimum: true, maximum: 1000 },
        version: { bsonType: int, minimum: 1 },
      },
    },
  },
  users: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['username', 'role'],
      properties: {
        username: { bsonType: 'string' },
        role: { enum: ['national', 'province', 'district', 'admin'] },
        province_id: { bsonType: [...int, 'null'] },
        district_id: { bsonType: [...int, 'null'] },
      },
    },
  },
  readings: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['installation_id', 'timestamp', 'power_kw', 'cumulative_energy_kwh', 'voltage'],
      properties: {
        installation_id: { bsonType: int },
        timestamp: { bsonType: 'date' },
        power_kw: { bsonType: 'number', minimum: 0 },
        cumulative_energy_kwh: { bsonType: 'number', minimum: 0 },
        voltage: { bsonType: 'number', minimum: 0, maximum: 300 },
      },
    },
  },
};

// [collection, key pattern, options]
export const INDEXES = [
  ['provinces', { name: 1 }, { unique: true }],
  ['districts', { name: 1 }, { unique: true }],
  ['districts', { province_id: 1 }, {}],
  ['grid_substations', { district_id: 1 }, {}],
  ['installations', { meter_id: 1 }, { unique: true }],
  ['installations', { substation_id: 1 }, {}],
  ['installations', { district_id: 1 }, {}],
  ['installations', { province_id: 1 }, {}],
  ['users', { username: 1 }, { unique: true }],
  // One reading per installation and instant; also serves history paging and "latest reading" lookups.
  ['readings', { installation_id: 1, timestamp: 1 }, { unique: true }],
  // Serves national and regional history sorted by time.
  ['readings', { timestamp: 1, _id: 1 }, {}],
];

/**
 * Creates indexes and validators. Safe to run on every start-up.
 * Index failures are fatal (uniqueness is part of the API contract).
 * Validator failures only log a warning: the API validates every request itself,
 * the validators are defence in depth.
 */
export async function ensureSchema(db, log = console) {
  for (const [collection, keys, options] of INDEXES) {
    await db.collection(collection).createIndex(keys, options);
  }
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  for (const [name, validator] of Object.entries(VALIDATORS)) {
    try {
      if (existing.has(name)) {
        await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
      } else {
        await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
      }
    } catch (error) {
      log.warn(`Could not apply the schema validator to "${name}": ${error.message}`);
    }
  }
}
