// A small in-memory stand-in for the part of the MongoDB Node.js driver that src/ uses, so the HTTP-level
// test suite can run with no database. It implements only what the app needs (equality, $in/$gt/$gte/$lt/$lte/$ne/$and
// filters; $set/$inc/$max/$setOnInsert updates; unique indexes; sort/skip/limit/projection).
//
// It is NOT MongoDB: it has no real transactions or schema validation. Use `npm run test:atlas` to run the
// same suite against a real MongoDB Atlas cluster.

const clone = value => structuredClone(value);
const norm = v => (v instanceof Date ? v.getTime() : v);
const isOperatorObject = c => c !== null && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c)
  && Object.keys(c).length > 0 && Object.keys(c).every(k => k.startsWith('$'));

const same = (a, b) => {
  a = norm(a); b = norm(b);
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return a === b;
};
const compare = (a, b) => {
  a = norm(a); b = norm(b);
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
};

function operator(op, value, arg) {
  switch (op) {
    case '$in': return arg.some(x => same(value, x));
    case '$ne': return !same(value, arg);
    case '$gt': return value != null && compare(value, arg) > 0;
    case '$gte': return value != null && compare(value, arg) >= 0;
    case '$lt': return value != null && compare(value, arg) < 0;
    case '$lte': return value != null && compare(value, arg) <= 0;
    default: throw new Error(`fake-mongo: unsupported operator ${op}`);
  }
}

function matches(doc, filter = {}) {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$and') {
      if (!condition.every(f => matches(doc, f))) return false;
    } else if (isOperatorObject(condition)) {
      if (!Object.entries(condition).every(([op, arg]) => operator(op, doc[key], arg))) return false;
    } else if (!same(doc[key], condition)) {
      return false;
    }
  }
  return true;
}

function project(doc, projection) {
  if (!projection) return doc;
  const keys = Object.keys(projection).filter(k => k !== '_id' && projection[k]);
  if (!keys.length) return doc;
  const out = projection._id === 0 ? {} : { _id: doc._id };
  for (const k of keys) if (k in doc) out[k] = doc[k];
  return out;
}

const sorter = spec => (a, b) => {
  for (const [field, direction] of Object.entries(spec)) {
    const c = compare(a[field], b[field]);
    if (c) return c * direction;
  }
  return 0;
};

function applyUpdate(doc, update, inserting) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [key, value] of Object.entries(fields)) {
      if (op === '$set') doc[key] = clone(value);
      else if (op === '$inc') doc[key] = (doc[key] ?? 0) + value;
      else if (op === '$max') { if (doc[key] === undefined || compare(value, doc[key]) > 0) doc[key] = clone(value); }
      else if (op === '$setOnInsert') { if (inserting) doc[key] = clone(value); }
      else throw new Error(`fake-mongo: unsupported update operator ${op}`);
    }
  }
  return doc;
}

const duplicateKey = what => Object.assign(new Error(`E11000 duplicate key error (${what})`), { code: 11000, codeName: 'DuplicateKey' });
const indexKey = (doc, fields) => JSON.stringify(fields.map(f => norm(doc[f]) ?? null));

class FakeCursor {
  constructor(docs, projection) { this.docs = docs; this.projection = projection; }
  sort(spec) { this.sortSpec = spec; return this; }
  skip(n) { this.skipN = n; return this; }
  limit(n) { this.limitN = n; return this; }
  async toArray() {
    let out = this.docs;
    if (this.sortSpec) out = [...out].sort(sorter(this.sortSpec));
    if (this.skipN) out = out.slice(this.skipN);
    if (this.limitN) out = out.slice(0, this.limitN);
    return out.map(d => clone(project(d, this.projection)));
  }
}

class FakeCollection {
  constructor(name) {
    this.name = name;
    this.docs = new Map();
    this.uniqueIndexes = [];
  }

  async createIndex(spec, options = {}) {
    const fields = Object.keys(spec);
    if (options.unique && !this.uniqueIndexes.some(i => i.fields.join() === fields.join())) {
      const index = { fields, owners: new Map() };
      for (const doc of this.docs.values()) {
        const key = indexKey(doc, fields);
        if (index.owners.has(key)) throw duplicateKey(`${this.name}.${fields}`);
        index.owners.set(key, doc._id);
      }
      this.uniqueIndexes.push(index);
    }
    return fields.join('_');
  }

  #assertUnique(doc) {
    for (const index of this.uniqueIndexes) {
      const owner = index.owners.get(indexKey(doc, index.fields));
      if (owner !== undefined && owner !== doc._id) throw duplicateKey(`${this.name}.${index.fields}`);
    }
  }
  #index(doc) { for (const i of this.uniqueIndexes) i.owners.set(indexKey(doc, i.fields), doc._id); }
  #unindex(doc) { for (const i of this.uniqueIndexes) i.owners.delete(indexKey(doc, i.fields)); }
  #find(filter) { return [...this.docs.values()].filter(d => matches(d, filter)); }

  async insertOne(doc) {
    if (doc._id === undefined) throw new Error('fake-mongo: documents must carry an _id');
    if (this.docs.has(doc._id)) throw duplicateKey(`${this.name}._id`);
    this.#assertUnique(doc);
    const stored = clone(doc);
    this.docs.set(stored._id, stored);
    this.#index(stored);
    return { acknowledged: true, insertedId: stored._id };
  }

  async insertMany(docs) {
    const writeErrors = [];
    for (const doc of docs) {
      try { await this.insertOne(doc); } catch (error) { writeErrors.push({ code: error.code ?? 0, errmsg: error.message }); }
    }
    if (writeErrors.length) throw Object.assign(new Error('fake-mongo bulk write error'), { code: writeErrors[0].code, writeErrors });
    return { acknowledged: true, insertedCount: docs.length };
  }

  async findOne(filter, options = {}) {
    let docs = this.#find(filter);
    if (options.sort) docs = [...docs].sort(sorter(options.sort));
    return docs.length ? clone(project(docs[0], options.projection)) : null;
  }

  find(filter, options = {}) { return new FakeCursor(this.#find(filter), options.projection); }
  async countDocuments(filter = {}) { return this.#find(filter).length; }
  async estimatedDocumentCount() { return this.docs.size; }
  async distinct(field, filter = {}) { return [...new Set(this.#find(filter).map(d => norm(d[field])))]; }
  async drop() { this.docs.clear(); this.uniqueIndexes = []; return true; }

  async #update(filter, update, { upsert = false } = {}) {
    const [found] = this.#find(filter);
    if (!found) {
      if (!upsert) return { matched: false, doc: null };
      const base = {};
      for (const [k, v] of Object.entries(filter)) if (!k.startsWith('$') && !isOperatorObject(v)) base[k] = clone(v);
      const doc = applyUpdate(base, update, true);
      await this.insertOne(doc);
      return { matched: false, upserted: true, doc: clone(doc), before: null };
    }
    const before = clone(found);
    const next = applyUpdate(clone(found), update, false);
    this.#unindex(found);
    try { this.#assertUnique(next); } catch (error) { this.#index(found); throw error; }
    this.docs.set(next._id, next);
    this.#index(next);
    return { matched: true, doc: clone(next), before };
  }

  async updateOne(filter, update, options) {
    const r = await this.#update(filter, update, options);
    return { matchedCount: r.matched ? 1 : 0, modifiedCount: r.matched ? 1 : 0, upsertedCount: r.upserted ? 1 : 0 };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    const r = await this.#update(filter, update, options);
    if (!r.matched && !r.upserted) return null;
    return options.returnDocument === 'after' ? r.doc : r.before;
  }

  async findOneAndDelete(filter) {
    const [found] = this.#find(filter);
    if (!found) return null;
    this.#unindex(found);
    this.docs.delete(found._id);
    return clone(found);
  }

  async bulkWrite(operations) {
    let upsertedCount = 0;
    for (const op of operations) {
      if (!op.updateOne) throw new Error('fake-mongo: bulkWrite supports updateOne only');
      const r = await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert });
      upsertedCount += r.upsertedCount;
    }
    return { upsertedCount };
  }
}

class FakeDb {
  constructor() { this.collections = new Map(); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new FakeCollection(name));
    return this.collections.get(name);
  }
  async command() { return { ok: 1 }; }
  async createCollection(name) { this.collection(name); }
  listCollections() { return { toArray: async () => [...this.collections.keys()].map(name => ({ name })) }; }
  async dropDatabase() { this.collections.clear(); }
}

export function createFakeClient() {
  const dbs = new Map();
  return {
    db(name) {
      if (!dbs.has(name)) dbs.set(name, new FakeDb());
      return dbs.get(name);
    },
    // Transactions are not emulated: the callback simply runs once.
    startSession() {
      return {
        async withTransaction(work) { await work(); },
        async endSession() {},
      };
    },
    async close() {},
  };
}
