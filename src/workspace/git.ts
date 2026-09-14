import { spawn } from 'node:child_process';
import { bounded, type Trace } from '../harness/trace.ts';
import { terminateProcessTree } from '../platform/process.ts';

export interface CommandResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean }
export function command(cwd: string, executable: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 300_000, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let termination: Promise<void> | undefined;
    const abort = () => { if (child.pid) termination ??= terminateProcessTree(child.pid); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { signal?.removeEventListener('abort', abort); clearTimeout(timer); reject(error); });
    child.on('close', code => { signal?.removeEventListener('abort', abort); clearTimeout(timer); if (signal?.aborted) { reject(signal.reason); return; } resolve({ exitCode: code ?? -1, stdout, stderr, timedOut }); });
  });
}
export async function git(cwd: string, args: string[], trace?: Trace, env?: NodeJS.ProcessEnv, allowFailure = false) {
  const result = await command(cwd, 'git', args, env);
  if (trace) {
    // Bounded: paginated tool reads (git_diff) re-run the same large command per page; the
    // trace keeps facts plus an excerpt, never the full repeated payload.
    const stdout = bounded(result.stdout), stderr = bounded(result.stderr);
    trace.emit('git', { args, exitCode: result.exitCode, timedOut: result.timedOut,
      truncated: stdout.truncated || stderr.truncated,
      stdout_chars: stdout.chars, stdout: stdout.excerpt, stdout_sha256: stdout.truncated ? stdout.sha256 : undefined,
      stderr_chars: stderr.chars, stderr: stderr.excerpt });
  }
  if (result.exitCode !== 0 && !allowFailure) throw new Error(`Git command failed: ${args[0]} (exit ${result.exitCode})`);
  return result;
}
export function gitAuth(token: string): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
}
