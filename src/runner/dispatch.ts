import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readState, statePath, workerStatus } from './state.ts';
import type { HumanReply } from '../github/comments.ts';
import { saveHumanReply } from './human-feedback.ts';
import { hasRunnableWork } from './runnable.ts';
import { patchpawPaths } from '../config/paths.ts';
import { withRuntimeLock } from '../migration/runtime-lock.ts';

export function workerEnvironment(runtimeHome: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, PATCHPAW_HOME: runtimeHome };
}

function startWorker(sourceRoot: string, runtimeHome: string, repo: string, number: number) {
  const child = spawn(process.execPath, ['--import', 'tsx', join(sourceRoot, 'scripts/run-pr.ts'), repo, String(number)],
    { cwd: sourceRoot, env: workerEnvironment(runtimeHome), detached: true, stdio: 'ignore' });
  child.unref();
}

export async function dispatchHumanReply(runtimeHome: string, reply: HumanReply, sourceRoot = process.cwd()) {
  await withRuntimeLock(runtimeHome, 'shared', false, async () => {
    const path = statePath(patchpawPaths(runtimeHome).state, reply.repo, reply.pr_number);
    await saveHumanReply(path, reply);
    const state = await readState(path);
    if (workerStatus(state) === 'running') return;
    if (await hasRunnableWork(runtimeHome, reply.repo, reply.pr_number)) startWorker(sourceRoot, runtimeHome, reply.repo, reply.pr_number);
  });
}
