// Entry point: connects to MongoDB Atlas, prepares indexes, and serves the API on PORT (default 8787).
import { loadConfig } from './config.js';
import { loadAssets } from './assets.js';
import { connectMongo } from './mongo.js';
import { ensureSchema } from './schema.js';
import { createStore } from './store.js';
import { createApp } from './app.js';
import { createHttpServer } from './http.js';

const config = loadConfig();
console.log('Connecting to MongoDB...');
const { client, db } = await connectMongo(config);
if (process.env.SKIP_SCHEMA_SETUP !== 'true') await ensureSchema(db);

const store = createStore({ client, db });
const app = createApp({
  store,
  secrets: { JWT_SECRET: config.JWT_SECRET, DEVICE_MASTER: config.DEVICE_MASTER, USER_PASSWORD: config.USER_PASSWORD },
  assets: loadAssets(),
});
const server = createHttpServer(app, { publicBaseUrl: config.PUBLIC_BASE_URL });

const readings = await store.readingCount();
if (readings === 0) console.warn('The database has no data yet. Run "npm run seed" to load the synthetic dataset.');

server.listen(config.PORT, '0.0.0.0', () => {
  console.log(`SLSEA API serving at http://localhost:${config.PORT}/docs (database "${config.MONGODB_DB}", ${readings} readings)`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down...`);
  server.close();
  await client.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
