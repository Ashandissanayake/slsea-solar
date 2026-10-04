// Prints random values for the three application secrets, ready to paste into .env.
import { randomBytes } from 'node:crypto';
const secret = bytes => randomBytes(bytes).toString('base64url');
console.log(`JWT_SECRET=${secret(32)}`);
console.log(`DEVICE_MASTER=${secret(32)}`);
console.log(`USER_PASSWORD=${secret(12)}`);
