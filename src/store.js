// MongoDB data-access layer. Every query that used to be SQL against Cloudflare D1 lives here.
//
// Conventions
//  - Integer identifiers are stored in _id; documents are mapped back to the public API shape
//    (id, ...) by the mapper functions below, so JSON output is identical to the D1 version.
//  - Installations carry denormalised district_id and province_id (substations, districts and
//    provinces never change through the API), which replaces the SQL joins used for jurisdiction scoping.
//  - Reading timestamps are stored as BSON dates and returned as ISO 8601 strings.
//  - Readings are only ever inserted by this module (append-only; see README for hardening options).

// Transactions give the same atomicity as the single SQL INSERT ... WHERE NOT EXISTS statement.
const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

// ---- Mappers: stored document -> API representation (key order matches the old SQL columns) ----

const mapProvince = d => d && { id: d._id, name: d.name };
const mapDistrict = d => d && { id: d._id, province_id: d.province_id, name: d.name };
const mapSubstation = d => d && { id: d._id, district_id: d.district_id, name: d.name };
const mapUser = d => d && {
  id: d._id,
  username: d.username,
  role: d.role,
  province_id: d.province_id ?? null,
  district_id: d.district_id ?? null,
};
const mapAsset = d => ({
  id: d._id,
  substation_id: d.substation_id,
  name: d.name,
  meter_id: d.meter_id,
  capacity_kw: d.capacity_kw,
  version: d.version,
});
const mapInstallation = d => d && { ...mapAsset(d), district_id: d.district_id, province_id: d.province_id };
const mapReading = d => d && {
  id: d._id,
  installation_id: d.installation_id,
  timestamp: d.timestamp.toISOString(),
  power_kw: d.power_kw,
  cumulative_energy_kwh: d.cumulative_energy_kwh,
  voltage: d.voltage,
};

const all = conditions => (conditions.length === 0 ? {} : conditions.length === 1 ? conditions[0] : { $and: conditions });

/** Jurisdiction predicate for a user, as Mongo conditions on an installation document. */
function installationScope(user) {
  if (user.role === 'district') return [{ district_id: user.district_id }];
  if (user.role === 'province') return [{ province_id: user.province_id }];
  return [];
}

export function createStore({ client, db }) {
  const provinces = db.collection('provinces');
  const districts = db.collection('districts');
  const substations = db.collection('grid_substations');
  const installations = db.collection('installations');
  const users = db.collection('users');
  const readings = db.collection('readings');
  const counters = db.collection('counters');

  /** Atomic auto-increment, equivalent to INTEGER PRIMARY KEY AUTOINCREMENT. */
  async function nextId(name) {
    const doc = await counters.findOneAndUpdate(
      { _id: name },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after', includeResultMetadata: false },
    );
    return doc.seq;
  }

  /**
   * Runs `work(session)` in a transaction that first bumps a counter on the installation document.
   * Because every writer of an installation (reading ingestion, replace, delete) touches that same
   * document, MongoDB serialises them and the cumulative-counter and history-protection checks
   * cannot race. `work` returns the outcome; null means the installation does not exist.
   */
  async function withInstallation(installationId, work) {
    const session = client.startSession();
    let outcome;
    try {
      await session.withTransaction(async () => {
        outcome = null;
        const locked = await installations.updateOne({ _id: installationId }, { $inc: { lock_seq: 1 } }, { session });
        if (!locked.matchedCount) return;
        outcome = await work(session);
      }, TRANSACTION_OPTIONS);
    } finally {
      await session.endSession();
    }
    return outcome;
  }

  const hasReadings = (installationId, session) =>
    readings.findOne({ installation_id: installationId }, { projection: { _id: 1 }, session }).then(Boolean);

  return {
    // ---- Service ----
    /** Fast approximate count from collection metadata; also proves the database connection works. */
    async readingCount() {
      return readings.estimatedDocumentCount();
    },

    // ---- Users ----
    async getUserById(id) {
      return mapUser(await users.findOne({ _id: id }));
    },
    async getUserByUsername(username) {
      return mapUser(await users.findOne({ username }));
    },

    // ---- Geography ----
    async getProvince(id) {
      return mapProvince(await provinces.findOne({ _id: id }));
    },
    async getDistrict(id) {
      return mapDistrict(await districts.findOne({ _id: id }));
    },
    /** Substation including the province_id of its district (used for authorisation). */
    async getSubstation(id) {
      const s = await substations.findOne({ _id: id });
      if (!s) return null;
      const d = await districts.findOne({ _id: s.district_id });
      return { ...mapSubstation(s), province_id: d.province_id };
    },
    async listProvinces(user) {
      let filter = {};
      if (user.role === 'province') filter = { _id: user.province_id };
      if (user.role === 'district') {
        const d = await districts.findOne({ _id: user.district_id });
        filter = { _id: d ? d.province_id : -1 };
      }
      return (await provinces.find(filter).sort({ _id: 1 }).toArray()).map(mapProvince);
    },
    async listDistricts(user, provinceId) {
      const conditions = [{ province_id: provinceId }];
      if (user.role === 'district') conditions.push({ _id: user.district_id });
      if (user.role === 'province') conditions.push({ province_id: user.province_id });
      return (await districts.find(all(conditions)).sort({ _id: 1 }).toArray()).map(mapDistrict);
    },
    async listSubstations(districtId) {
      return (await substations.find({ district_id: districtId }).sort({ _id: 1 }).toArray()).map(mapSubstation);
    },

    // ---- Installations ----
    /** Installation plus its district_id and province_id, or null. */
    async getInstallation(id) {
      return mapInstallation(await installations.findOne({ _id: id }));
    },
    /** filters: { province_id?, district_id?, substation_id? } (already validated integers). */
    async listInstallations(user, { substationId, filters = {} } = {}) {
      const conditions = installationScope(user);
      if (substationId) conditions.push({ substation_id: substationId });
      for (const [field, value] of Object.entries(filters)) conditions.push({ [field]: value });
      const docs = await installations.find(all(conditions)).sort({ _id: 1 }).toArray();
      return docs.map(mapAsset);
    },
    /** `substation` comes from getSubstation(). Throws a duplicate-key error (code 11000) for a repeated meter_id. */
    async createInstallation(substation, { name, meter_id, capacity_kw }) {
      const doc = {
        _id: await nextId('installations'),
        substation_id: substation.id,
        district_id: substation.district_id,
        province_id: substation.province_id,
        name,
        meter_id,
        capacity_kw,
        version: 1,
        lock_seq: 0,
      };
      await installations.insertOne(doc);
      return mapAsset(doc);
    },
    /**
     * Optimistic replace: succeeds only if the stored version still equals `version`.
     * Returns { status: 'ok', installation } | { status: 'history' } | { status: 'stale' }.
     */
    async replaceInstallation(id, version, { name, meter_id, capacity_kw }, substation, moving) {
      const outcome = await withInstallation(id, async session => {
        if (moving && await hasReadings(id, session)) return { status: 'history' };
        const updated = await installations.findOneAndUpdate(
          { _id: id, version },
          {
            $set: {
              substation_id: substation.id,
              district_id: substation.district_id,
              province_id: substation.province_id,
              name,
              meter_id,
              capacity_kw,
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after', includeResultMetadata: false, session },
        );
        return updated ? { status: 'ok', installation: mapAsset(updated) } : { status: 'stale' };
      });
      return outcome ?? { status: 'stale' };
    },
    /** Returns 'ok' | 'history' | 'stale'. A missing installation counts as already deleted ('ok'). */
    async deleteInstallation(id, version) {
      const outcome = await withInstallation(id, async session => {
        if (await hasReadings(id, session)) return 'history';
        const deleted = await installations.findOneAndDelete({ _id: id, version }, { session, includeResultMetadata: false });
        return deleted ? 'ok' : 'stale';
      });
      return outcome ?? 'ok';
    },
    async installationHasReadings(id) {
      return hasReadings(id);
    },

    // ---- Readings ----
    async getReading(installationId, id) {
      return mapReading(await readings.findOne({ _id: id, installation_id: installationId }));
    },
    async findReading(installationId, timestampIso) {
      return mapReading(await readings.findOne({ installation_id: installationId, timestamp: new Date(timestampIso) }));
    },
    async lastReading(installationId) {
      return mapReading(await readings.findOne({ installation_id: installationId }, { sort: { timestamp: -1 } }));
    },
    async countReadings(installationId) {
      return readings.countDocuments({ installation_id: installationId });
    },
    /**
     * Paged, jurisdiction-scoped history. `dir` is 1 (ascending) or -1 (descending); from/to are ISO strings
     * forming the half-open interval [from, to).
     */
    async readingHistory({ user, installationId, filters = {}, from, to, dir, offset, limit }) {
      const conditions = installationScope(user);
      if (installationId) conditions.push({ _id: installationId });
      for (const [field, value] of Object.entries(filters)) conditions.push({ [field]: value });
      const ids = (await installations.find(all(conditions), { projection: { _id: 1 } }).toArray()).map(d => d._id);
      if (!ids.length) return { total: 0, items: [] };

      const query = { installation_id: ids.length === 1 ? ids[0] : { $in: ids } };
      if (from || to) {
        query.timestamp = {};
        if (from) query.timestamp.$gte = new Date(from);
        if (to) query.timestamp.$lt = new Date(to);
      }
      // Timestamps are unique per installation, so _id is only needed as a tie-breaker across installations.
      const sort = ids.length === 1 ? { timestamp: dir } : { timestamp: dir, _id: dir };
      const [total, docs] = await Promise.all([
        readings.countDocuments(query),
        readings.find(query).sort(sort).skip(offset).limit(limit).toArray(),
      ]);
      return { total, items: docs.map(mapReading) };
    },
    /**
     * Appends a reading, enforcing the monotonic cumulative energy counter atomically.
     * Returns { status: 'created', reading } | { status: 'conflict' } | { status: 'missing' }.
     */
    async insertReading(installationId, timestampIso, { power_kw, cumulative_energy_kwh, voltage }) {
      const id = await nextId('readings'); // allocated outside the transaction so concurrent inserts do not conflict on it
      const timestamp = new Date(timestampIso);
      try {
        const outcome = await withInstallation(installationId, async session => {
          // Existing data is monotonic, so comparing with the nearest neighbours on each side is sufficient.
          const before = await readings.findOne(
            { installation_id: installationId, timestamp: { $lt: timestamp } },
            { sort: { timestamp: -1 }, projection: { cumulative_energy_kwh: 1 }, session },
          );
          const after = await readings.findOne(
            { installation_id: installationId, timestamp: { $gt: timestamp } },
            { sort: { timestamp: 1 }, projection: { cumulative_energy_kwh: 1 }, session },
          );
          if ((before && before.cumulative_energy_kwh > cumulative_energy_kwh)
            || (after && after.cumulative_energy_kwh < cumulative_energy_kwh)) {
            return { status: 'conflict' };
          }
          const doc = { _id: id, installation_id: installationId, timestamp, power_kw, cumulative_energy_kwh, voltage };
          await readings.insertOne(doc, { session });
          return { status: 'created', reading: mapReading(doc) };
        });
        return outcome ?? { status: 'missing' };
      } catch (error) {
        if (error?.code === 11000) return { status: 'conflict' }; // same installation and instant inserted concurrently
        throw error;
      }
    },

    // ---- Operational summary ----
    /**
     * One row per installation in the district with its latest reading and the cumulative energy
     * counters needed for the daily delta: finish = last counter before `endIso`, start = last counter at or before `startIso`.
     */
    async districtSnapshot(districtId, startIso, endIso) {
      const start = new Date(startIso);
      const end = new Date(endIso);
      const ids = (await installations.find({ district_id: districtId }, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray()).map(d => d._id);
      const energyOnly = { cumulative_energy_kwh: 1 };
      return Promise.all(ids.map(async id => {
        const [latest, finish, begin] = await Promise.all([
          readings.findOne({ installation_id: id }, { sort: { timestamp: -1 } }),
          readings.findOne({ installation_id: id, timestamp: { $lt: end } }, { sort: { timestamp: -1 }, projection: energyOnly }),
          readings.findOne({ installation_id: id, timestamp: { $lte: start } }, { sort: { timestamp: -1 }, projection: energyOnly }),
        ]);
        return {
          id,
          timestamp: latest ? latest.timestamp.toISOString() : null,
          power_kw: latest ? latest.power_kw : null,
          finish_energy: finish ? finish.cumulative_energy_kwh : null,
          start_energy: begin ? begin.cumulative_energy_kwh : null,
        };
      }));
    },
  };
}
