// Credentials for scripts/verify-live.mjs. Read from the environment (or .env) instead of a JSON file.
//   node --env-file=.env scripts/verify-live.mjs --origin=https://your-host
import { parseArgs } from 'node:util';

export async function readCredentials() {
  const { values } = parseArgs({ options: { origin: { type: 'string' } } });
  const origin = values.origin || process.env.VERIFY_ORIGIN || `http://localhost:${process.env.PORT || 8787}`;
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Provide an HTTP or HTTPS origin without embedded credentials.');
  }
  for (const name of ['USER_PASSWORD', 'DEVICE_MASTER']) {
    if (!process.env[name]) throw new Error(`${name} must be set in the environment or .env (same values as the running API).`);
  }
  return { origin: url.origin, USER_PASSWORD: process.env.USER_PASSWORD, DEVICE_MASTER: process.env.DEVICE_MASTER };
}
