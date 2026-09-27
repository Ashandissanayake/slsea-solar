// Environment configuration. Values come from real environment variables or from a .env file
// (loaded by `node --env-file-if-exists=.env`, see the npm scripts in package.json).

/** MongoDB settings only (used by the seed script). */
export function loadMongoConfig(env = process.env) {
  if (!env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to .env and paste your MongoDB Atlas connection string.');
  }
  return { MONGODB_URI: env.MONGODB_URI, MONGODB_DB: env.MONGODB_DB || 'slsea_solar' };
}

/** Full server configuration: MongoDB settings plus the three application secrets. */
export function loadConfig(env = process.env) {
  const mongo = loadMongoConfig(env);
  const missing = ['JWT_SECRET', 'DEVICE_MASTER', 'USER_PASSWORD'].filter(name => !env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}. See .env.example.`);
  }
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
  return {
    ...mongo,
    PORT: port,
    JWT_SECRET: env.JWT_SECRET,
    DEVICE_MASTER: env.DEVICE_MASTER,
    USER_PASSWORD: env.USER_PASSWORD,
    // Optional. Set to the public URL (for example https://slsea.example.com) when running behind a proxy
    // so that pagination Link headers and Location headers point at the public address.
    PUBLIC_BASE_URL: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  };
}
