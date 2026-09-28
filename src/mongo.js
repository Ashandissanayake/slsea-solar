// MongoDB Atlas connection.
import dns from 'node:dns';
dns.setServers(['8.8.8.8', '1.1.1.1']);
import { MongoClient } from 'mongodb';

export async function connectMongo({ MONGODB_URI, MONGODB_DB }) {
  const client = new MongoClient(MONGODB_URI, {
    appName: 'slsea-solar-api',
    serverSelectionTimeoutMS: 10000, // fail fast with a clear error if Atlas is unreachable or the IP is not allowed
  });
  await client.connect();
  const db = client.db(MONGODB_DB);
  await db.command({ ping: 1 });
  return { client, db };
}
