import { join } from 'node:path';
import { createGitHub } from '../github/client.ts';
import { Trace } from '../harness/trace.ts';
import { claimRun, readState, statePath, workerStatus, writeState, type RunState } from './state.ts';
import { completeReview, readArtifact, reviewCheckpoint, type ReviewLifecycle } from './review-lifecycle.ts';
import { publishSavedCloseout } from './closeout-publication.ts';
import { patchpawPaths } from '../config/paths.ts';
import { withRuntimeLock } from '../migration/runtime-lock.ts';

type Config = { root: string; appId: number; privateKey: string; operatorLogin?: string };
export function reviewConnection(config: Config, repo: string, number: number): ReviewLifecycle['connection'] {
  return async () => {
    const github = createGitHub(config), [owner, name] = repo.split('/');
    const [{ data: installation }, { data: app }] = await Promise.all([
      github.app.rest.apps.getRepoInstallation({ owner, repo: name }), github.app.rest.apps.getAuthenticated(),
    ]);
    if (!app?.slug) throw new Error('GitHub App has no bot identity');
    const client = github.installation(installation.id);
    const { data: pr } = await client.rest.pulls.get({ owner, repo: name, pull_number: number });
    return { client, botLogin: `${app.slug}[bot]`,
      mentions: [pr.user?.login, config.operatorLogin ?? owner].filter((v): v is string => !!v) };
  };
}

// Also used by normal entry under its existing lock, before any workspace/model initialization.
export async function recoverLockedRun(config: Config, repo: string, number: number, runId: string,
  connection = reviewConnection(config, repo, number)) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1
    || !/^[\w-]+$/.test(runId)) throw new Error('Invalid recovery target');
  const path = statePath(patchpawPaths(config.root).state, repo, number);
  const trace = new Trace(join(patchpawPaths(config.root).runs, runId));
  trace.secret(config.privateKey);
  const manifest = await readArtifact(trace.dir, 'manifest.json');
  if (manifest?.run_id !== runId || manifest?.repo !== repo || manifest?.pr_number !== number) {
    throw new Error('Run manifest does not match recovery target');
  }
  trace.executionId = manifest.execution_id ?? 1;
  if (await readArtifact(trace.dir, 'run-notice.json')) {
    const publication = await publishSavedCloseout(trace, (await connection()).client, repo, number);
    const result = { status: 'closeout_published', run_id: runId, publication, model_requests: 0 };
    trace.save('notice-recovery.json', result);
    return result;
  }
  const previous = await readState(path);
  if (previous && previous.run_id !== runId) throw new Error('A newer run owns this PR state; refusing to overwrite it');
  const status = workerStatus(previous);
  if (status === 'running' && previous?.pid !== process.pid) return { status: 'already_running' };
  const point = await reviewCheckpoint(trace.dir);
  const state: RunState = previous ?? { repo, pr_number: number, run_id: runId, current_head_sha: '',
    phase: point, active: false, pid: process.pid, waiting_for_ci: false, repair_attempts: 0, last_patchpaw_commit: null };
  trace.emit('recovery_started', { worker_status: status, previous_pid: state.pid, checkpoint: point, model_requests: 0 });
  if (point === 'review_running') {
    state.active = false; state.waiting_for_ci = false; state.phase = 'review_interrupted';
    await writeState(path, state);
    const result = { status: 'review_output_missing', run_id: runId, model_requests: 0 };
    trace.save('recovery.json', result);
    return result; // Explicit recovery never reruns an unfinished model task.
  }
  state.pid = process.pid; state.active = true; state.phase = point; state.waiting_for_ci = false;
  await writeState(path, state);
  try {
    const result = await completeReview({ trace, state, path, runtimeHome: config.root, recovered: true, connection: async () => {
      const current = await connection();
      return { ...current, mentions: [...current.mentions, ...(typeof manifest.request_author === 'string' ? [manifest.request_author] : [])] };
    } });
    trace.save('recovery.json', { ...result, model_requests: 0 });
    return result;
  } finally {
    // Ordinary exceptions must not leave this executor as active either.
    state.active = false;
    await writeState(path, state);
  }
}

export async function recoverRun(config: Config, repo: string, number: number, runId: string,
  connection = reviewConnection(config, repo, number)) {
  return withRuntimeLock(config.root, 'shared', false, async () => {
    const path = statePath(patchpawPaths(config.root).state, repo, number);
    if (workerStatus(await readState(path)) === 'running') return { status: 'already_running' };
    const release = await claimRun(path);
    if (!release) return { status: 'already_running' };
    try { return await recoverLockedRun(config, repo, number, runId, connection); }
    finally { await release(); }
  });
}
