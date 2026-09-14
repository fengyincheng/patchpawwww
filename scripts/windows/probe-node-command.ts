import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'patchpaw-node-acl-probe-'));
try {
  const sid = (await execFileAsync('whoami', ['/user'], { encoding: 'utf8', windowsHide: true })).stdout
    .match(/\bS-\d-\d+(?:-\d+)+\b/i)?.[0];
  if (!sid) throw new Error('No SID');
  const script = join(process.cwd(), 'scripts', 'windows', 'protect-acl.ps1');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, root, sid, 'set', 'directory'];
  try {
    const result = await execFileAsync('powershell.exe', args, { encoding: 'utf8', windowsHide: true });
    console.log('NODE_POWERSHELL_OK', result.stdout, result.stderr);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    console.error('NODE_POWERSHELL_FAILURE', failure.message, failure.stdout, failure.stderr, process.env.PSModulePath);
    process.exitCode = 1;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
