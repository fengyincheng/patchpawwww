import { randomBytes } from 'node:crypto';

// Deliberately write one line only. The operator is responsible for storing it
// in a server-side environment file; PatchPaw never persists or reads it back.
process.stdout.write(`PATCHPAW_ADMIN_TOKEN=${randomBytes(32).toString('hex')}\n`);
