import { configuredRuntimeHome, loadProjectEnvIfPresent } from '../src/config/env.ts';
import { backupRuntime } from '../src/migration/backup.ts';

loadProjectEnvIfPresent();
const [runtimeArgument, destination] = process.argv.slice(2);
const report = await backupRuntime({ runtimeHome: runtimeArgument ?? configuredRuntimeHome(), destination });
console.log(JSON.stringify(report, null, 2));
