import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

function run(file: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', file], {
      cwd: process.cwd(), stdio: 'inherit', windowsHide: false,
    });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}

const requested = process.argv.slice(2);
const files = requested.length ? requested : (await readdir('test'))
  .filter(file => file.endsWith('.test.ts'))
  .sort()
  .map(file => join('test', file));

for (const file of files) {
  console.error(`\n=== ${file} ===`);
  const code = await run(file);
  if (code !== 0) process.exit(code);
}
