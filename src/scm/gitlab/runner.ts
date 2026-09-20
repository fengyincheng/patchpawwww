import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { GitLabClient } from './client.ts';
import { GitLabAdapter } from './adapter.ts';
import { saveScmSnapshot } from './snapshot.ts';
import type { ScmConnection } from '../types.ts';
import { getScmConnection, SecretStore } from '../../control-plane/index.ts';
import type { ControlPlaneDb } from '../../control-plane/db.ts';
import { patchpawPaths } from '../../config/paths.ts';
import { statePath, readState, writeState, workerStatus, claimRun, type RunState } from '../../runner/state.ts';
import { Trace } from '../../harness/trace.ts';
import { providerError } from '../../harness/retry.ts';
import { classifyRunFailure, terminalStatusForFailure } from '../../runner/failures.ts';
import { runPullRequest, type ScmRunContext } from '../../runner/pull-request.ts';

export interface GitLabWorkerConfig {
  root: string;
  snapshotRoot: string;
  operatorLogin?: string;
  gitlabConnections?: Array<{
    id: string;
    instanceUrl: string;
    projectIds: string[];
    token?: string;
    botUserId?: string;
    botLogin?: string;
  }>;
  controlPlaneDb?: ControlPlaneDb;
}

type GitLabWorkerResult = Record<string, unknown>;

function gitlabConfigurationError(message: string) {
  return Object.assign(new Error(message), { code: 'GITLAB_CONFIGURATION_ERROR' });
}

async function connectionFor(config: GitLabWorkerConfig, repo: string) {
  const match = repo.match(/^gitlab:(.+):project:(.+)$/);
  if (!match) return undefined;
  let configured = config.gitlabConnections?.find(value => value.id === match[1]);
  if (!configured && config.controlPlaneDb) {
    const stored = await getScmConnection(config.controlPlaneDb, match[1]);
    if (stored?.kind === 'gitlab' && stored.enabled && stored.credentialRef) {
      const secrets = new SecretStore(config.root);
      configured = {
        id: stored.id,
        instanceUrl: stored.instanceUrl,
        projectIds: stored.projectIds,
        token: await secrets.read(stored.credentialRef),
        botUserId: stored.botUserId ?? undefined,
        botLogin: stored.botLogin ?? undefined,
      };
    }
  }
  if (!configured?.token) throw gitlabConfigurationError('GitLab connection token is unavailable');
  const client = new GitLabClient({ baseUrl: configured.instanceUrl, token: configured.token });
  const { data: user } = await client.user();
  const botUserId = user.id === undefined ? '' : String(user.id);
  const botLogin = typeof user.username === 'string' ? user.username : '';
  if (!botUserId || !botLogin) throw gitlabConfigurationError('GitLab Bot identity is unavailable');
  if ((configured.botUserId && configured.botUserId !== botUserId)
      || (configured.botLogin && configured.botLogin.toLowerCase() !== botLogin.toLowerCase())) {
    throw gitlabConfigurationError('GitLab Bot identity configuration is stale');
  }
  const connection: ScmConnection = {
    id: configured.id,
    kind: 'gitlab',
    instanceUrl: configured.instanceUrl,
    credentialRef: null,
    webhookMode: 'secret',
    webhookSecretRef: null,
    botUserId,
    botLogin,
    projectIds: configured.projectIds,
    enabled: true,
    createdAt: '',
    updatedAt: '',
  };
  return { connection, adapter: new GitLabAdapter(connection, client, { id: botUserId, username: botLogin }), projectId: match[2] };
}

function newRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

async function persistGitLabBootstrapFailure(config: GitLabWorkerConfig, repo: string, number: number, error: unknown) {
  const path = statePath(patchpawPaths(config.root).state, repo, number);
  if (workerStatus(await readState(path)) === 'running') return { status: 'already_running' };
  const release = await claimRun(path);
  if (!release) return { status: 'already_running' };
  const runId = newRunId();
  const trace = new Trace(join(patchpawPaths(config.root).runs, runId));
  const previous = await readState(path);
  const failure = classifyRunFailure(error);
  const status = terminalStatusForFailure(failure);
  const state: RunState = {
    repo,
    pr_number: number,
    run_id: runId,
    current_head_sha: '',
    phase: status,
    repair_attempts: 0,
    last_patchpaw_commit: null,
    waiting_for_ci: false,
    active: false,
    pid: process.pid,
    handled_comment_ids: previous?.handled_comment_ids ?? [],
  };
  const result = {
    status,
    run_id: runId,
    repo,
    pr_number: number,
    final_head_sha: '',
    failed_phase: 'bootstrap',
    error: providerError(error),
    message: failure.message,
    failure,
    notification: { status: 'not_attempted', reason: 'GitLab connection was unavailable; no MR Note was attempted.' },
  };
  try {
    trace.emit('run_error', {
      phase: 'bootstrap',
      ...providerError(error),
      message: failure.message,
      failure_code: failure.code,
      failure_category: failure.category,
    });
    await writeState(path, state);
    trace.save('notification.json', result.notification);
    trace.save('result.json', result);
    return result;
  } finally {
    await release();
  }
}

/**
 * GitLab compatibility entry only. All task, approval, workspace, writeback,
 * recovery, publication, and terminal lifecycle decisions belong to the
 * canonical runner; this wrapper supplies only GitLab facts and transport.
 */
export async function runGitLabMergeRequest(config: GitLabWorkerConfig, repo: string, number: number): Promise<GitLabWorkerResult> {
  const path = statePath(patchpawPaths(config.root).state, repo, number);
  if (workerStatus(await readState(path)) === 'running') return { status: 'already_running' };
  let resolved: Awaited<ReturnType<typeof connectionFor>>;
  try {
    const candidate = await connectionFor(config, repo);
    if (!candidate) throw gitlabConfigurationError('Invalid GitLab storage key');
    resolved = candidate;
  } catch (error) {
    return persistGitLabBootstrapFailure(config, repo, number, error);
  }
  let context: ScmRunContext;
  try {
    const snapshot = await resolved.adapter.readChangeRequest(resolved.projectId, number, { allowClosed: true });
    const saved = await saveScmSnapshot(config.snapshotRoot, snapshot, `api-${newRunId()}`);
    context = {
      adapter: resolved.adapter,
      projectId: resolved.projectId,
      snapshot,
      snapshotPath: saved.path,
      connection: async () => ({ adapter: resolved.adapter, botLogin: resolved.adapter.botLogin }),
    };
  } catch (error) {
    return persistGitLabBootstrapFailure(config, repo, number, error);
  }
  return runPullRequest(config, repo, number, context);
}
