import { readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { spawn } from 'node:child_process';

interface Options {
  continueOnFailure: boolean;
  shard?: { index: number; total: number };
  from?: string;
  requested: string[];
}

function parseOptions(args: string[]): Options {
  const requested: string[] = [];
  let continueOnFailure = false;
  let shard: Options['shard'];
  let from: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--continue') { continueOnFailure = true; continue; }
    if (arg === '--shard') {
      const value = args[++index];
      const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
      if (!match) throw new Error('--shard expects N/M, for example 1/2');
      const shardIndex = Number(match[1]), shardTotal = Number(match[2]);
      if (!Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shardTotal) || shardTotal < 1 || shardIndex < 1 || shardIndex > shardTotal) {
        throw new Error('--shard must use 1 <= N <= M');
      }
      shard = { index: shardIndex, total: shardTotal };
      continue;
    }
    if (arg === '--from') {
      from = args[++index];
      if (!from) throw new Error('--from expects a test file');
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    requested.push(arg);
  }
  return { continueOnFailure, shard, from, requested };
}

function run(file: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--import', 'tsx', file], {
      cwd: process.cwd(), stdio: 'inherit', windowsHide: false,
    });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}

const options = parseOptions(process.argv.slice(2));
const allFiles = options.requested.length ? options.requested : (await readdir('test'))
  .filter(file => file.endsWith('.test.ts'))
  .sort()
  .map(file => join('test', file));
const fromIndex = options.from === undefined ? 0 : allFiles.findIndex(file => file === options.from || basename(file) === options.from || relative(process.cwd(), file) === options.from);
if (options.from !== undefined && fromIndex < 0) throw new Error(`--from file was not found: ${options.from}`);
const selected = allFiles.slice(fromIndex < 0 ? 0 : fromIndex).filter((_, index) => !options.shard || index % options.shard.total === options.shard.index - 1);
if (!selected.length) throw new Error('No test files selected');

console.error(`Serial test run: ${selected.length} file(s)${options.shard ? `, shard ${options.shard.index}/${options.shard.total}` : ''}`);
let passed = 0;
let failed = 0;

for (const [index, file] of selected.entries()) {
  console.error(`\n[${index + 1}/${selected.length}] TEST ${file}`);
  const code = await run(file);
  if (code === 0) {
    passed += 1;
    console.error(`[${index + 1}/${selected.length}] PASS ${file}`);
  } else {
    failed += 1;
    console.error(`[${index + 1}/${selected.length}] FAIL ${file} (exit ${code})`);
    if (!options.continueOnFailure) process.exit(code);
  }
}

console.error(`\nSerial test summary: ${passed} passed, ${failed} failed, ${selected.length} total`);
if (failed) process.exit(1);
