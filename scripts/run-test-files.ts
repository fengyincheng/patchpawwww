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

interface TestRunResult {
  code: number;
  signal: NodeJS.Signals | null;
  resourceFailure: boolean;
}

// Node's test coordinator may report a killed test worker in TAP while itself exiting 1.
const RESOURCE_FAILURE = /\b(?:out of memory|oom|killed|SIGKILL)\b|\bexitCode:\s*137\b/i;

function run(file: string): Promise<TestRunResult> {
  return new Promise(resolve => {
    let output = '';
    let resourceDiagnostic = false;
    let spawnError: Error | undefined;
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', '--import', 'tsx', file], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
    });
    const capture = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-32_768);
      resourceDiagnostic ||= RESOURCE_FAILURE.test(output);
    };
    child.stdout?.on('data', chunk => { capture(chunk); process.stdout.write(chunk); });
    child.stderr?.on('data', chunk => { capture(chunk); process.stderr.write(chunk); });
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      const diagnostic = spawnError ? `${output}\n${spawnError.message}` : output;
      if (spawnError) console.error(spawnError.message);
      resolve({ code: code ?? 1, signal, resourceFailure: code === 137 || signal === 'SIGKILL' || resourceDiagnostic || RESOURCE_FAILURE.test(diagnostic) });
    });
  });
}

const options = parseOptions(process.argv.slice(2));
const allFiles = options.requested.length ? [...options.requested].sort() : (await readdir('test'))
  .filter(file => file.endsWith('.test.ts'))
  .sort()
  .map(file => join('test', file));
const fromIndex = options.from === undefined ? 0 : allFiles.findIndex(file => file === options.from || basename(file) === options.from || relative(process.cwd(), file) === options.from);
if (options.from !== undefined && fromIndex < 0) throw new Error(`--from file was not found: ${options.from}`);
// Keep shard ownership tied to the complete ordered collection. `--from` only advances the
// cursor; it must never renumber the files that were assigned to each shard.
const selected = allFiles
  .map((file, index) => ({ file, index }))
  .filter(({ index }) => index >= (fromIndex < 0 ? 0 : fromIndex)
    && (!options.shard || index % options.shard.total === options.shard.index - 1))
  .map(({ file }) => file);
if (!selected.length) throw new Error('No test files selected');

console.error(`Serial test run: ${selected.length} file(s)${options.shard ? `, shard ${options.shard.index}/${options.shard.total}` : ''}`);
let passed = 0;
let failed = 0;
const failures: string[] = [];
let resourceFailure = false;
let exitCode = 0;

for (const [index, file] of selected.entries()) {
  console.error(`\n[${index + 1}/${selected.length}] TEST ${file}`);
  const result = await run(file);
  if (result.code === 0) {
    passed += 1;
    console.error(`[${index + 1}/${selected.length}] PASS ${file}`);
  } else {
    failed += 1;
    failures.push(file);
    const termination = result.signal ? `signal ${result.signal}` : `exit ${result.code}`;
    console.error(`[${index + 1}/${selected.length}] FAIL ${file} (${termination})`);
    if (result.resourceFailure) {
      resourceFailure = true;
      exitCode = 137;
      console.error(`Resource failure detected; stopping immediately after ${file}.`);
      break;
    }
    if (!options.continueOnFailure) {
      exitCode = result.code || 1;
      break;
    }
  }
}

console.error(`\nSerial test summary: ${passed} passed, ${failed} failed, ${selected.length} total`);
console.error(`Failed files: ${failures.length ? failures.join(', ') : 'none'}`);
if (resourceFailure || failed) process.exit(exitCode || 1);
