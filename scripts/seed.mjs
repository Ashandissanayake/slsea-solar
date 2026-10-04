// Loads the synthetic SLSEA dataset into MongoDB. Safe to re-run: existing documents are kept and
// interrupted runs resume where they stopped.
//
//   npm run seed             load / complete the dataset
//   npm run seed -- --reset  drop the application's collections first (destroys all data in them)
import { loadMongoConfig } from '../src/config.js';
import { connectMongo } from '../src/mongo.js';
import { COLLECTION_NAMES, ensureSchema } from '../src/schema.js';
import { seedDatabase, READING_COUNT } from '../src/seed.js';

const config = loadMongoConfig();
const { client, db } = await connectMongo(config);
try {
  if (process.argv.includes('--reset')) {
    console.log(`Dropping collections in database "${config.MONGODB_DB}"...`);
    for (const name of COLLECTION_NAMES) {
      try { await db.collection(name).drop(); } catch (error) { if (error.codeName !== 'NamespaceNotFound') throw error; }
    }
  }
  await ensureSchema(db);
  const started = Date.now();
  const result = await seedDatabase(db, { log: console.log });
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s:`, result);
  if (result.readings < READING_COUNT) console.warn(`Expected ${READING_COUNT} readings but found ${result.readings}; run the seed again.`);
} finally {
  await client.close();
}
