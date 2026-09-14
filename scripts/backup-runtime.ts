import { loadEnvFile } from 'node:process';
import { configuredRuntimeHome, projectRoot } from '../src/config/env.ts';
import { backupRuntime } from '../src/migration/backup.ts';

loadEnvFile(`${projectRoot}/.env`);
const [runtimeArgument, destination] = process.argv.slice(2);
const report = await backupRuntime({ runtimeHome: runtimeArgument ?? configuredRuntimeHome(), destination });
console.log(JSON.stringify(report, null, 2));
