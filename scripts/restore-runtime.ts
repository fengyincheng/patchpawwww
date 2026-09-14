import { loadConfig } from '../src/config/env.ts';
import { restoreRuntime } from '../src/migration/restore.ts';

const [backupPath, runtimeArg] = process.argv.slice(2);
const runtimeHome = runtimeArg ?? loadConfig().runtimeHome;
if (!backupPath) throw new Error('Usage: npm run restore-runtime -- /path/to/.patchpaw/backups/runtime-... [/path/to/.patchpaw]');
console.log(JSON.stringify(await restoreRuntime({ runtimeHome, backupPath }), null, 2));
