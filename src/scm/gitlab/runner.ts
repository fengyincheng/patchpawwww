import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { GitLabClient } from './client.ts';
import { GitLabAdapter } from './adapter.ts';
import { saveScmSnapshot } from './snapshot.ts';
import type { ScmConnection } from '../types.ts';
import { statePath, readState, writeState, workerStatus, claimRun, type RunState } from '../../runner/state.ts';
import { hasHumanReplies, humanFeedback } from '../../runner/human-feedback.ts';
import { parsePRIntent, type PRTask } from '../../runner/command.ts';
import { patchpawPaths } from '../../config/paths.ts';
import { bootstrapControlPlane, getRepository, getScmConnection, loadCommandSnapshot, openControlPlaneDb, resolveExecution, SecretStore, writeCommandSnapshot } from '../../control-plane/index.ts';
import type { ControlPlaneDb } from '../../control-plane/db.ts';
import { runtimeExecutionFromSnapshot } from '../../harness/runtime.ts';
import { Trace } from '../../harness/trace.ts';
import { seedContext } from '../../harness/context/seed.ts';
import { runConversation } from '../../tasks/conversation/agent.ts';
import { runReview } from '../../tasks/review/agent.ts';
import { runCustom } from '../../tasks/custom/agent.ts';
import { ensureRepo, fetchPRState, createWorktree, disposeWorkspacePath, isManagedWorktree, runWorkspacePath } from '../../workspace/repo-store.ts';
import { commitRepair, prepareWorkspace } from '../../workspace/manager.ts';
import { gitAuth } from '../../workspace/git.ts';
import { excerpt } from '../../harness/context/policy.ts';
import { enqueueCommentDelivery, enqueueReviewDelivery, deliverImmediately, finalizeDelivery } from '../../runner/outbound.ts';
import { prThreadId } from '../../harness/pr-memory.ts';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { git } from '../../workspace/git.ts';
import { runCIRepair } from '../../tasks/ci-repair/agent.ts';
import { runRepair } from '../../tasks/repair.ts';
import { watchStop, TaskStopped } from '../../runner/stop.ts';
import { readPaused, resumeWorkspace, retainWorkspace, savePaused } from '../../runner/resume.ts';
import { runConflict } from '../../tasks/conflict/agent.ts';
import { captureConflictWorkspaceEvidence, compareConflictWorkspaceEvidence, workspaceEvidenceSha256, type ConflictWorkspaceEvidence } from '../../runner/workspace-evidence.ts';
import { readArtifact } from '../../runner/review-lifecycle.ts';
import { readHumanReplies } from '../../runner/human-feedback.ts';
import { newConflictApproval, readConflictApproval, readUnfinishedConflictApproval, saveConflictApproval, updateConflictApproval, type ConflictApprovalRecord } from '../../runner/conflict-approval.ts';
import { createConflictProposal, markConflictProposalStatus, proposalDeliverySemanticKey, proposalPointerForState, readCurrentConflictProposal, renderConflictProposal, saveConflictProposal, saveProposalState } from '../../runner/conflict-proposals.ts';

export interface GitLabWorkerConfig {
  root: string;
  snapshotRoot: string;
  operatorLogin?: string;
  gitlabConnections?: Array<{ id: string; instanceUrl: string; projectIds: string[]; token?: string; botUserId?: string; botLogin?: string }>;
  controlPlaneDb?: ControlPlaneDb;
}

async function connectionFor(config: GitLabWorkerConfig, repo: string) {
  const match = repo.match(/^gitlab:(.+):project:(.+)$/);
  if (!match) return undefined;
  let configured = config.gitlabConnections?.find(value => value.id === match[1]);
  if (!configured && config.controlPlaneDb) {
    const stored = await getScmConnection(config.controlPlaneDb, match[1]);
    if (stored?.kind === 'gitlab' && stored.enabled && stored.credentialRef) {
      const secrets = new SecretStore(config.root);
      configured = { id: stored.id, instanceUrl: stored.instanceUrl, projectIds: stored.projectIds, token: await secrets.read(stored.credentialRef),
        botUserId: stored.botUserId ?? undefined, botLogin: stored.botLogin ?? undefined };
    }
  }
  if (!configured?.token) throw new Error('GitLab connection token is unavailable');
  const client = new GitLabClient({ baseUrl: configured.instanceUrl, token: configured.token });
  const { data: user } = await client.user();
  const botUserId = user.id === undefined ? '' : String(user.id);
  const botLogin = typeof user.username === 'string' ? user.username : '';
  if (!botUserId || !botLogin) throw new Error('GitLab Bot identity is unavailable');
  if (configured.botUserId && configured.botUserId !== botUserId || configured.botLogin && configured.botLogin.toLowerCase() !== botLogin.toLowerCase()) {
    throw new Error('GitLab Bot identity configuration is stale');
  }
  const connection: ScmConnection = { id: configured.id, kind: 'gitlab', instanceUrl: configured.instanceUrl, credentialRef: null, webhookMode: 'secret', webhookSecretRef: null,
    botUserId, botLogin, projectIds: configured.projectIds, enabled: true, createdAt: '', updatedAt: '' };
  const adapter = new GitLabAdapter(connection, client, { id: botUserId, username: botLogin });
  return { connection, adapter, projectId: match[2] };
}

function fakePullRequest(snapshot: Awaited<ReturnType<GitLabAdapter['readChangeRequest']>>) {
  const base = { ref: snapshot.target.ref, sha: snapshot.diffBaseSha ?? snapshot.target.sha, repo: { id: Number(snapshot.target.projectId) } };
  const head = { ref: snapshot.source.ref, sha: snapshot.source.sha, repo: { full_name: snapshot.source.pathWithNamespace } };
  return { repository: { id: Number(snapshot.repository.remoteProjectId), full_name: snapshot.repository.pathWithNamespace, private: true, clone_url: snapshot.repository.cloneUrl },
    pr: { number: snapshot.changeRequest.number, title: snapshot.title, body: snapshot.body, state: snapshot.state === 'opened' ? 'open' : snapshot.state, base, head, user: { login: snapshot.author.login } },
    snapshot: { base, head }, owner: '', repo: snapshot.repository.pathWithNamespace, installationId: 0, client: undefined } as any;
}

function runDir(config: GitLabWorkerConfig, runId: string) { return join(patchpawPaths(config.root).runs, runId); }

/** GitLab-only worker entry. It reuses the existing Harness/workspace lifecycle for read-only tasks. */
export async function runGitLabMergeRequest(config: GitLabWorkerConfig, repo: string, number: number) {
  const resolved = await connectionFor(config, repo);
  if (!resolved) throw new Error('Invalid GitLab storage key');
  const path = statePath(patchpawPaths(config.root).state, repo, number);
  if (workerStatus(await readState(path)) === 'running') return { status: 'already_running' };
  const approvalRecovery = await readUnfinishedConflictApproval(path) ?? undefined;
  if (!await hasHumanReplies(path) && !approvalRecovery) return { status: 'mention_required' };
  const release = await claimRun(path); if (!release) return { status: 'already_running' };
  let controlPlane = config.controlPlaneDb; let ownsControlPlane = false;
  let workspace: Awaited<ReturnType<typeof prepareWorkspace>> | undefined; let workspacePath: string | undefined;
  let preserveWorkspace = false;
  let stopWatcher: ReturnType<typeof watchStop> | undefined;
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const trace = new Trace(runDir(config, runId));
  const previous = await readState(path);
  const state: RunState = { repo, pr_number: number, run_id: runId, current_head_sha: '', phase: 'inspect', repair_attempts: 0, last_patchpaw_commit: null,
    waiting_for_ci: false, active: true, pid: process.pid, handled_comment_ids: previous?.handled_comment_ids ?? [] };
  let snapshot!: Awaited<ReturnType<GitLabAdapter['readChangeRequest']>>;
  let currentBaseForResume: { ref: string; sha: string } | undefined;
  let currentConflictProposal: Awaited<ReturnType<typeof readCurrentConflictProposal>> = null;
  let approvalRecord: ConflictApprovalRecord | undefined = approvalRecovery;
  let approvalSnapshot: Awaited<ReturnType<typeof loadCommandSnapshot>>['snapshot'] | undefined;
  let approvedConflictRepair = false;
  const finish = async (status: string, extra: Record<string, unknown> = {}) => {
    const task = state.phase as 'ci' | 'repair' | 'review' | 'conflict';
    if (workspace && ['needs_human', 'stopped', 'budget_exhausted'].includes(status) && ['ci', 'repair', 'review', 'conflict'].includes(task)) {
      try {
        const pauseStatus = status === 'stopped' ? 'stopped' : status === 'budget_exhausted' ? 'budget_exhausted' : 'needs_human';
        await retainWorkspace(path, trace, { run_id: runId, execution_id: 1, task, workspace,
          base_sha: currentBaseForResume?.sha ?? snapshot.diffBaseSha ?? snapshot.target.sha,
          base_ref: currentBaseForResume?.ref ?? snapshot.target.ref, remote_head: state.current_head_sha,
          pause_phase: state.phase, pause_reason: status === 'stopped' ? 'human_stop' : status === 'budget_exhausted' ? 'budget' : 'human_decision', status: pauseStatus });
        preserveWorkspace = true;
      } catch (error) { trace.emit('workspace_retain_failed', { message: (error as Error).message }); }
    }
    state.active = false; state.phase = status; await writeState(path, state);
    if (workspace && ['conversation_completed', 'review_completed', 'custom_completed', 'ci_completed', 'repair_completed'].includes(status)) {
      const paused = await readPaused(path);
      if (paused?.workspace.path === workspace.path) await savePaused(path, { ...paused, status: 'completed' });
    }
    const result = { status, run_id: runId, repo, pr_number: number, final_head_sha: state.current_head_sha, ...extra };
    trace.save('result.json', result); return result;
  };
  try {
    const feedbackResult = await humanFeedback(path, patchpawPaths(config.root).runs, true);
    const feedback = feedbackResult.context ?? (approvalRecovery ? {
      previous_run_id: approvalRecovery.repair_run_id, previous_result: undefined,
      comments: await readHumanReplies(path), new_comment_ids: [],
      instruction: 'Resume the durable GitLab Conflict approval lifecycle without creating a new model turn.'
    } : undefined);
    if (!feedback) return await finish('mention_required');
    const triggering = feedback.comments.find(comment => feedback.new_comment_ids.includes(comment.comment_id));
    const approvalComment = feedback.comments.find(comment => comment.comment_id === approvalRecovery?.source_comment_id);
    const eventComment = triggering ?? approvalComment;
    const botLogin = resolved.adapter.botLogin;
    snapshot = await resolved.adapter.readChangeRequest(resolved.projectId, number, { allowClosed: true });
    await saveScmSnapshot(config.snapshotRoot, snapshot, triggering ? String(triggering.comment_id) : `api-${runId}`);
    state.current_head_sha = snapshot.source.sha; state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), ...(feedback.new_comment_ids.slice(0, 1))])]; await writeState(path, state);
    controlPlane = config.controlPlaneDb ?? await openControlPlaneDb(config.root); ownsControlPlane = !config.controlPlaneDb;
    await bootstrapControlPlane({ root: config.root, repositories: [{ fullName: snapshot.repository.pathWithNamespace, displayName: snapshot.repository.pathWithNamespace,
      scmKind: 'gitlab', connectionId: resolved.connection.id, remoteProjectId: snapshot.repository.remoteProjectId, pathWithNamespace: snapshot.repository.pathWithNamespace,
      webUrl: snapshot.repository.webUrl, cloneUrl: snapshot.repository.cloneUrl, storageKey: repo }], controlPlaneDb: controlPlane });
    const repositoryRow = await controlPlane.execute('SELECT id FROM repositories WHERE storage_key = :storage_key', { storage_key: repo });
    const repository = repositoryRow.rows[0] ? await getRepository(controlPlane, String(repositoryRow.rows[0].id)) : undefined;
    if (!repository) throw new Error('GitLab control-plane repository is unavailable');
    const intent = eventComment ? await parsePRIntent(controlPlane, repository.id, eventComment.body, botLogin)
      : approvalRecovery ? { kind: 'control', control: 'approval' } as const : { kind: 'conversation', repositoryId: repository.id } as const;
    const task: PRTask = intent.kind === 'command' ? intent.executionType : intent.kind === 'control' ? intent.control === 'stop' ? 'stop' : intent.control === 'close' ? 'close' : 'conflict' : 'conversation';
    if (task === 'stop') return await finish('stopped', { reason: 'GitLab /stop 只停止本地 generation。' });
    if (task === 'close') return await finish('closed', { reason: 'GitLab /close 只清理本地会话。' });
    const approvalRequested = task === 'conflict' && intent.kind === 'control' && intent.control === 'approval';
    await ensureRepo(config.root, repo, snapshot.repository.cloneUrl, trace);
    const token = await resolved.adapter.installationGitToken!();
    trace.secret(token); trace.secret(Buffer.from(`x-access-token:${token}`).toString('base64'));
    resolved.adapter.client.assertRemoteUrl(snapshot.repository.cloneUrl);
    if (snapshot.source.cloneUrl) resolved.adapter.client.assertRemoteUrl(snapshot.source.cloneUrl);
    const fetched = await fetchPRState(config.root, repo, { headSha: snapshot.source.sha, baseRef: snapshot.target.ref, sourceRemoteUrl: snapshot.source.cloneUrl }, trace, gitAuth(token, snapshot.repository.cloneUrl));
    const currentBase = { ref: fetched.baseRef, sha: fetched.currentBaseTipSha };
    currentBaseForResume = currentBase;
    const retained = await readPaused(path);
    if (approvalRequested) {
      currentConflictProposal = await readCurrentConflictProposal(path);
      const proposal = currentConflictProposal?.proposal;
      const reply = eventComment ?? approvalComment;
      const authorId = reply?.author_id ?? approvalRecord?.author_id;
      const recoveredCommit = approvalRecord && ['remote_confirmed', 'publication_pending'].includes(approvalRecord.phase)
        ? approvalRecord.commit_sha : undefined;
      if (!proposal || proposal.status !== 'published' || !proposal.publication?.delivery_id) return await finish('needs_human', { reason: 'GitLab Conflict Proposal 尚未确认发布；请先发送 /conflict。' });
      if (!reply && !approvalRecord) return await finish('needs_human', { reason: 'GitLab /approval 缺少可验证的来源评论。' });
      if (snapshot.source.sha !== (recoveredCommit ?? proposal.basis.pr_head_sha) || proposal.basis.pr_head_ref !== snapshot.source.ref
          || proposal.basis.pr_head_repo?.toLowerCase() !== snapshot.source.pathWithNamespace.toLowerCase()
          || proposal.basis.current_base_tip_sha !== currentBase.sha || proposal.basis.base_ref !== currentBase.ref) {
        return await finish('needs_human', { reason: 'GitLab MR head、source ref、source project 或 target tip 已变化；旧 Proposal 已失效，请重新发送 /conflict。' });
      }
      if (!retained || !['awaiting_approval', 'claimed', 'repairing', 'publication_pending'].includes(retained.status)
          || retained.task !== 'conflict' || retained.workspace.path !== currentConflictProposal!.pointer.workspace_path
          || retained.workspace.initialHead !== proposal.basis.pr_head_sha || retained.workspace.mainSha !== proposal.basis.current_base_tip_sha
          || retained.base_ref !== proposal.basis.base_ref || !await isManagedWorktree(config.root, repo, retained.workspace.path, undefined, trace)) {
        return await finish('needs_human', { reason: 'GitLab Conflict retained workspace 缺失、被修改或与当前 Proposal 不匹配；请重新发送 /conflict。' });
      }
      const storedEvidence = await readArtifact(join(patchpawPaths(config.root).runs, proposal.repair_run_id), 'workspace-evidence.json') as (ConflictWorkspaceEvidence & { evidence_sha256?: string }) | null;
      if (!storedEvidence?.evidence_sha256) return await finish('needs_human', { reason: 'GitLab Conflict Proposal 的 WorkspaceEvidence 缺失；不会在未知工作区上修复。' });
      const { evidence_sha256: storedHash, ...evidence } = storedEvidence;
      if (storedHash !== proposal.basis.workspace_evidence_sha256 || storedHash !== workspaceEvidenceSha256(evidence)
          || evidence.repository !== repo || evidence.pr_number !== number || evidence.pr_head_sha !== proposal.basis.pr_head_sha
          || evidence.current_base_tip_sha !== currentBase.sha || evidence.base_ref !== currentBase.ref) {
        return await finish('needs_human', { reason: 'GitLab Conflict Proposal 的 WorkspaceEvidence 已变化；请重新发送 /conflict。' });
      }
      const snapshotInfo = await loadCommandSnapshot(config.root, proposal.repair_run_id, { allowLegacy: true });
      if (snapshotInfo.snapshot.snapshot_id !== proposal.basis.command_snapshot_id || snapshotInfo.snapshotSha256 !== proposal.basis.command_snapshot_sha256
          || snapshotInfo.snapshot.execution_id !== proposal.repair_execution_id || snapshotInfo.snapshot.template_type !== 'conflict'
          || snapshotInfo.snapshot.target !== 'command' || snapshotInfo.snapshot.command?.permission !== 'read_write'
          || snapshotInfo.snapshot.command?.enabled !== true) {
        return await finish('needs_human', { reason: 'GitLab Conflict Proposal 绑定的 Command Snapshot 不再满足 read_write 或完整性要求。' });
      }
      if (reply) {
        if (!reply.source_event_id || !authorId) return await finish('needs_human', { reason: 'GitLab /approval 缺少 source event 或 actor numeric id。' });
        const authorization = await resolved.adapter.verifyInboundComment({ platform: 'gitlab', connectionId: resolved.connection.id,
          projectId: resolved.projectId, storageKey: repo, repositoryPath: snapshot.repository.pathWithNamespace,
          changeRequestNumber: number, remoteId: reply.comment_id, authorId, authorLogin: reply.author, body: reply.body, url: reply.url,
          createdAt: reply.created_at, sourceEventId: reply.source_event_id });
        if (!authorization.canApprove) return await finish('needs_human', { reason: 'GitLab /approval 评论者当前没有 Developer 或更高的有效项目权限。' });
        if (reply.comment_id <= (proposal.publication.remote_id ?? 0) || proposal.publication.published_at && reply.created_at
            && Date.parse(reply.created_at) <= Date.parse(proposal.publication.published_at)) {
          return await finish('needs_human', { reason: '该 GitLab /approval 评论早于当前 Proposal 发布时间；请对当前版本重新发送 /approval。' });
        }
        if (!approvalRecord) {
          const association = (authorization.accessLevel ?? 0) >= 40 ? 'MAINTAINER' : 'DEVELOPER';
          approvalRecord = newConflictApproval({ source_event_id: reply.source_event_id, source_comment_id: reply.comment_id,
            source_comment_url: reply.url, source_comment_created_at: reply.created_at, author: reply.author, author_id: authorId,
            platform: 'gitlab', author_association: association, received_at: new Date().toISOString(), verified_at: authorization.checkedAt,
            repair_execution_id: proposal.repair_execution_id, proposal_id: proposal.proposal_id, proposal_revision: proposal.proposal_revision,
            proposal_hash: proposal.proposal_hash, proposal_publication_delivery_id: proposal.publication.delivery_id,
            proposal_publication_remote_id: proposal.publication.remote_id, pr_head_sha: proposal.basis.pr_head_sha,
            pr_head_ref: proposal.basis.pr_head_ref!, pr_head_repo: proposal.basis.pr_head_repo!, current_base_tip_sha: proposal.basis.current_base_tip_sha,
            base_ref: proposal.basis.base_ref, command_snapshot_id: proposal.basis.command_snapshot_id,
            command_snapshot_sha256: proposal.basis.command_snapshot_sha256, status: 'accepted', phase: 'accepted' });
          await saveConflictApproval(path, approvalRecord);
        }
      }
      if (approvalRecord && (approvalRecord.proposal_id !== proposal.proposal_id || approvalRecord.proposal_revision !== proposal.proposal_revision
          || approvalRecord.proposal_hash !== proposal.proposal_hash || approvalRecord.pr_head_sha !== snapshot.source.sha
          || approvalRecord.current_base_tip_sha !== currentBase.sha || approvalRecord.base_ref !== currentBase.ref)) {
        return await finish('needs_human', { reason: 'GitLab durable approval 与当前 Proposal 或 Git facts 不匹配。' });
      }
      if (approvalRecord && approvalRecord.phase === 'completed') return await finish('repair_completed', { reason: 'GitLab Conflict approval 已完成。' });
      approvalSnapshot = snapshotInfo.snapshot;
      approvedConflictRepair = true;
      preserveWorkspace = true;
      if (eventComment) state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), eventComment.comment_id])];
    }
    const resumable = retained && ['budget_exhausted', 'needs_human', 'stopped'].includes(retained.status) && retained.task === task
      && ['conflict', 'ci', 'repair', 'review'].includes(task);
    const resumed = approvedConflictRepair ? null : resumable ? await resumeWorkspace(path, { head: snapshot.source.sha, base: currentBase.sha, main: currentBase.sha,
      baseRef: currentBase.ref, ownerRunId: runId, task: task as 'conflict' | 'ci' | 'repair' | 'review' }, trace,
      retainedWorkspace => disposeWorkspacePath(config.root, repo, retainedWorkspace, trace)) : null;
    if (approvedConflictRepair) {
      workspace = retained!.workspace;
      workspacePath = retained!.workspace.path;
      trace.emit('conflict_approval_workspace_claimed', { proposal_id: currentConflictProposal!.proposal.proposal_id, approval_id: approvalRecord?.approval_id });
    } else if (resumed) {
      workspace = resumed.workspace;
      workspacePath = resumed.workspace.path;
      trace.emit('workspace_resumed', { previous_run_id: resumed.run_id, execution_id: resumed.execution_id, workspace: workspacePath });
    } else {
      workspacePath = runWorkspacePath(config.root, runId); await createWorktree(config.root, repo, workspacePath, snapshot.source.sha, trace);
      workspace = await prepareWorkspace({ path: workspacePath, headSha: snapshot.source.sha, baseRef: snapshot.target.ref, mergeBase: task === 'conflict' }, trace);
    }
    const execution = approvalSnapshot ? { snapshot: approvalSnapshot }
      : await resolveExecution(controlPlane, task === 'conversation' ? { kind: 'conversation', repositoryId: repository.id, executionId: `${runId}:1` } : intent.kind === 'command' ? { kind: 'command', repositoryId: repository.id, commandId: intent.commandId, executionId: `${runId}:1` } : { kind: 'conversation', repositoryId: repository.id, executionId: `${runId}:1` });
    const runtime = runtimeExecutionFromSnapshot(execution.snapshot, config.root); const snapshotRef = await writeCommandSnapshot(config.root, runId, execution.snapshot);
    trace.save('manifest.json', { run_id: runId, repo, pr_number: number, scm: 'gitlab', scm_connection_id: resolved.connection.id, project_id: resolved.projectId,
      initial_head_sha: snapshot.source.sha, base_sha: snapshot.diffBaseSha, current_base_ref: currentBase.ref, current_base_tip_sha: currentBase.sha, pr_thread_id: prThreadId(repo, number), workspace_path: workspacePath,
      snapshot_path: snapshotRef.snapshot_path, snapshot_id: snapshotRef.snapshot_id, snapshot_sha256: snapshotRef.snapshot_sha256, request_author: triggering?.author });
    const fake = fakePullRequest(snapshot);
    const seed = async () => ({ ...await seedContext(fake, workspace!, trace, currentBase), repository: snapshot.repository.pathWithNamespace, scm: 'gitlab', scm_connection_id: resolved.connection.id, project_id: resolved.projectId, human_feedback: feedback, execution_id: runtime.snapshot.execution_id });
    state.phase = task; await writeState(path, state);
    const mentions = [snapshot.author.login, config.operatorLogin].filter((value): value is string => !!value);
    const publishComment = async (purpose: string, semanticKey: string, body: string) => {
      const stored = await enqueueCommentDelivery({ root: config.root, repo, prNumber: number, purpose, semanticKey, body, mentions, botLogin,
        source: { run_id: runId, connection_id: resolved.connection.id, project_id: resolved.projectId, head_sha: snapshot.source.sha } });
      return deliverImmediately(config.root, stored, { adapter: resolved.adapter, botLogin });
    };
    const finishPublication = async (attempt: Awaited<ReturnType<typeof deliverImmediately>>, completedStatus: string, extra: Record<string, unknown> = {}) => {
      if (attempt.item.status === 'delivered') return await finish(completedStatus, { ...extra, publication: attempt.publication });
      const status = attempt.item.status === 'blocked' ? 'needs_human' : 'publication_pending';
      return await finish(status, { ...extra, publication: attempt.publication, reason: attempt.item.last_error?.code ?? 'GitLab Note publication is not confirmed.' });
    };
    const publishConflictProposal = async (proposal: Awaited<ReturnType<typeof createConflictProposal>>) => {
      const current = await resolved.adapter.readChangeRequest(resolved.projectId, number);
      const branch = await resolved.adapter.client.branch(resolved.projectId, current.target.ref);
      const currentBaseSha = String(branch.data.commit?.id ?? branch.data.commit?.sha ?? '');
      if (current.source.sha !== proposal.basis.pr_head_sha || currentBaseSha !== proposal.basis.current_base_tip_sha) {
        throw new Error('GitLab MR head or target branch changed before Conflict Proposal publication');
      }
      await saveConflictProposal(path, proposal, workspace!.path);
      await saveProposalState(path, proposal, workspace!.path, { ...state, phase: 'draft', active: true, waiting_for_ci: false });
      trace.save('conflict-proposal.json', proposal);
      const stored = await enqueueCommentDelivery({ root: config.root, repo, prNumber: number, purpose: 'conflict_proposal',
        semanticKey: proposalDeliverySemanticKey(proposal), body: renderConflictProposal(proposal), mentions, botLogin,
        source: { run_id: runId, execution_id: proposal.execution_id, proposal_id: proposal.proposal_id, proposal_revision: proposal.proposal_revision,
          proposal_hash: proposal.proposal_hash, pr_head_sha: proposal.basis.pr_head_sha, current_base_tip_sha: proposal.basis.current_base_tip_sha,
          base_ref: proposal.basis.base_ref, workspace_evidence_sha256: proposal.basis.workspace_evidence_sha256,
          command_snapshot_id: proposal.basis.command_snapshot_id, command_snapshot_sha256: proposal.basis.command_snapshot_sha256 } });
      await markConflictProposalStatus(path, proposal.proposal_revision, 'publication_pending', workspace!.path);
      await saveProposalState(path, { ...proposal, status: 'publication_pending' }, workspace!.path,
        { ...state, phase: 'publication_pending', active: false, waiting_for_ci: false });
      state.conflict_proposal = proposalPointerForState({ ...proposal, status: 'publication_pending' }, workspace!.path);
      await retainWorkspace(path, trace, { run_id: runId, execution_id: 1, task: 'conflict', workspace: workspace!,
        base_sha: currentBase.sha, base_ref: currentBase.ref, remote_head: state.current_head_sha,
        pause_phase: 'publication_pending', pause_reason: 'human_decision', status: 'publication_pending' });
      preserveWorkspace = true;
      const publication = await deliverImmediately(config.root, stored, { adapter: resolved.adapter, botLogin });
      trace.save('conflict-proposal-publication-attempt.json', publication.publication);
      if (publication.item.status !== 'delivered' || !publication.item.receipt) {
        return await finish('publication_pending', { proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash,
          publication: publication.publication, reason: 'GitLab Conflict Proposal 已保存到 durable outbox，但远端 Note 尚未确认。' });
      }
      const receipt = { delivery_id: publication.item.delivery_id, remote_id: publication.item.receipt.id,
        remote_url: publication.item.receipt.html_url, published_at: publication.item.receipt.published_at ?? new Date().toISOString() };
      const published = await markConflictProposalStatus(path, proposal.proposal_revision, 'published', workspace!.path, receipt);
      await saveProposalState(path, published?.proposal ?? { ...proposal, status: 'published' }, workspace!.path,
        { ...state, phase: 'awaiting_approval', active: false, waiting_for_ci: false });
      state.conflict_proposal = { ...proposalPointerForState(published?.proposal ?? { ...proposal, status: 'published' }, workspace!.path),
        publication_delivery_id: receipt.delivery_id, publication_remote_id: receipt.remote_id, publication_remote_url: receipt.remote_url, published_at: receipt.published_at };
      const paused = await readPaused(path);
      if (!paused) throw new Error('GitLab Conflict Proposal workspace retention was lost before publication completed');
      await savePaused(path, { ...paused, status: 'awaiting_approval' });
      await finalizeDelivery(config.root, stored);
      return await finish('awaiting_approval', { proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash,
        publication: publication.publication, answer: renderConflictProposal(published?.proposal ?? { ...proposal, status: 'published' }) });
    };
    const watcher = watchStop(path, botLogin, () => state.handled_comment_ids ?? [], async comment => {
      state.handled_comment_ids = [...new Set([...(state.handled_comment_ids ?? []), comment.comment_id])];
      await writeState(path, state);
      await publishComment('close_refusal', `close-refusal:${comment.comment_id}`, 'GitLab /close 只清理本地会话；当前任务仍在运行，未关闭远端 MR。');
    });
    stopWatcher = watcher;
    const taskOptions = { task, prompt: '', ws: workspace, trace, runId, currentBase, execution: runtime,
      stopSignal: watcher.signal, stopRequest: watcher.request, prMemory: { root: patchpawPaths(config.root).memory, repo, number } } as any;
    await watcher.guard();
    const pushSameProjectCandidate = async (kind: string, startHead: string) => {
      if (snapshot.source.projectId !== snapshot.target.projectId || snapshot.source.projectId !== snapshot.repository.remoteProjectId) {
        throw new Error('GitLab fork MR repair is read-only; PatchPaw will not push to a different source project');
      }
      const before = await resolved.adapter.readChangeRequest(resolved.projectId, number);
      const beforeBranch = await resolved.adapter.client.branch(resolved.projectId, before.target.ref);
      if (before.source.sha !== startHead || String(beforeBranch.data.commit?.id ?? beforeBranch.data.commit?.sha ?? '') !== currentBase.sha) throw new Error('GitLab MR head or target branch changed before push');
      const sha = await commitRepair(workspace!, kind, trace, startHead);
      state.current_head_sha = sha; state.last_patchpaw_commit = sha; await writeState(path, state); state.phase = 'publishing'; await writeState(path, state);
      await git(workspace!.path, ['push', 'origin', `HEAD:refs/heads/${snapshot.source.ref}`], trace, gitAuth(token, snapshot.repository.cloneUrl));
      const deadline = Date.now() + 30_000;
      for (;;) {
        const current = await resolved.adapter.readChangeRequest(resolved.projectId, number);
        if (current.source.sha === sha) {
          const branch = await resolved.adapter.client.branch(resolved.projectId, current.target.ref);
          if (String(branch.data.commit?.id ?? branch.data.commit?.sha ?? '') !== currentBase.sha) throw new Error('GitLab target branch changed after push');
          trace.emit('repair_push_confirmed', { kind, sha, previous_head: startHead });
          return sha;
        }
        if (current.source.sha !== startHead || Date.now() >= deadline) throw new Error('GitLab MR head changed or push confirmation timed out');
        await delay(500);
      }
    };
    const observeCIAfterPush = async (sha: string) => {
      const deadline = Date.now() + 60_000;
      let observed = await resolved.adapter.readCI(resolved.projectId, number, sha);
      while (['pending', 'unknown'].includes(observed.state) && Date.now() < deadline) {
        await watcher.guard();
        trace.emit('ci_observation_wait', { sha, state: observed.state });
        await delay(1_000);
        observed = await resolved.adapter.readCI(resolved.projectId, number, sha);
      }
      trace.emit('ci_observation_complete', { sha, state: observed.state, timed_out: Date.now() >= deadline });
      return observed;
    };
    if (task === 'conversation') {
      const answer = await runConversation({ ...taskOptions, tools: { read_pr_comments: createTool({ id: 'read_pr_comments', description: 'Read prior GitLab MR Notes.', inputSchema: z.object({ page: z.number().int().positive().default(1) }), execute: async ({ page }) => excerpt(JSON.stringify((await resolved.adapter.listComments(resolved.projectId, number)).slice((page - 1) * 20, page * 20))) }) } }, await seed());
      if (answer.kind !== 'reply') return await finish('needs_human', { reason: 'GitLab conversation proposal handoff requires a fresh explicit Conflict workflow.' });
      const publication = await publishComment('conversation_reply', `run:${runId}:conversation`, answer.body);
      return await finishPublication(publication, 'conversation_completed', { answer: answer.body });
    }
    if (task === 'review') {
      const review = await runReview(taskOptions, await seed()); trace.save('review.json', { head_sha: snapshot.source.sha, ...review });
      const stored = await enqueueReviewDelivery({ root: config.root, repo, prNumber: number, semanticKey: `review:${runId}:${snapshot.source.sha}`, headSha: snapshot.source.sha, review, mentions, botLogin, runId,
        source: { run_id: runId, connection_id: resolved.connection.id, project_id: resolved.projectId, head_sha: snapshot.source.sha } });
      const publication = await deliverImmediately(config.root, stored, { adapter: resolved.adapter, botLogin });
      return await finishPublication(publication, 'review_completed', { review });
    }
    if (task === 'custom') {
      if (intent.kind === 'command' && intent.permission !== 'read_only') return await finish('needs_human', { reason: 'GitLab custom commands with read_write permission require the controlled repair path.' });
      const answer = await runCustom(taskOptions, await seed()); const publication = await publishComment('custom_completed', `run:${runId}:custom`, answer);
      return await finishPublication(publication, 'custom_completed', { answer });
    }
    if (task === 'ci') {
      let ci = await resolved.adapter.readCI(resolved.projectId, number, state.current_head_sha);
      let repairAttempts = 0;
      for (;;) {
        trace.save(`ci-${state.current_head_sha}.json`, ci);
        if (ci.state === 'green') break;
        if (ci.state !== 'red' || snapshot.source.projectId !== snapshot.target.projectId || repairAttempts >= 3) {
          return await finish('needs_human', { reason: ci.state === 'pending' ? 'GitLab CI is still pending or requires a manual action.' : ci.state === 'unknown' ? 'GitLab CI evidence is incomplete or unavailable; no green result is assumed.' : 'GitLab CI remains red after the repair budget.', ci });
        }
        const evidence = await resolved.adapter.failureEvidence(resolved.projectId, ci); trace.save(`ci-failure-${state.current_head_sha}.json`, evidence);
        const repair = await runCIRepair({ ...taskOptions, evidence }, { ...await seed(), ci, failure_evidence: evidence });
        trace.save(`ci-repair-${repairAttempts + 1}.json`, repair);
        if (repair.status !== 'repaired') return await finish(repair.status, { reason: repair.summary });
        const startHead = (await git(workspace!.path, ['rev-parse', 'HEAD'], trace)).stdout.trim();
        await pushSameProjectCandidate('ci', startHead);
        repairAttempts += 1; state.repair_attempts = repairAttempts; await writeState(path, state);
        ci = await observeCIAfterPush(state.current_head_sha);
      }
      const body = `## GitLab CI\n\nHead: \`${state.current_head_sha}\`\n\n状态：\`${ci.state}\`\n\n${ci.items.map(item => `- ${item.name}: ${item.conclusion ?? item.status} ${item.url ?? ''}`).join('\n')}`;
      const publication = await publishComment('ci_completed', `run:${runId}:ci:${state.current_head_sha}`, body);
      return await finishPublication(publication, 'ci_completed', { ci });
    }
    if (task === 'repair') {
      if (snapshot.source.projectId !== snapshot.target.projectId || snapshot.source.projectId !== snapshot.repository.remoteProjectId) return await finish('needs_human', { reason: 'GitLab fork MR repair is read-only; no cross-project push is attempted.' });
      const repair = await runRepair(taskOptions, await seed()); trace.save('repair-result.json', repair);
      if (repair.status !== 'repaired') return await finish(repair.status, { reason: repair.summary });
      await pushSameProjectCandidate('repair', snapshot.source.sha);
      const body = `## GitLab repair\n\n${repair.summary}\n\nCommit: \`${state.current_head_sha}\`\nLocal verification: ${repair.tests.join('; ') || repair.validation_not_applicable}`;
      const publication = await publishComment('repair_completed', `run:${runId}:repair:${state.current_head_sha}`, body);
      return await finishPublication(publication, 'repair_completed', { repair });
    }
    if (task === 'conflict') {
      if (approvedConflictRepair) {
        if (!approvalRecord || !currentConflictProposal) throw new Error('GitLab approved Conflict repair is missing its durable approval or proposal.');
        const proposal = currentConflictProposal.proposal;
        const previousPhase = approvalRecord.phase;
        let repair: Awaited<ReturnType<typeof runRepair>> | null = null;
        const priorRepairRun = approvalRecord.repair_run_id;
        if (priorRepairRun) repair = await readArtifact(runDir(config, priorRepairRun), 'repair-result.json') as Awaited<ReturnType<typeof runRepair>> | null;
        if (previousPhase === 'repairing' && !repair) {
          await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'interrupted', rejection_code: 'repair_interrupted' });
          return await finish('needs_human', { reason: 'GitLab Conflict repair 在结果落盘前中断；为避免重复调用模型，保留现有 workspace，请人工检查后重新发送 /conflict。' });
        }
        if (!repair && !['remote_confirmed', 'publication_pending'].includes(previousPhase)) {
          approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, {
            phase: 'repairing', repair_started_at: approvalRecord.repair_started_at ?? new Date().toISOString(), repair_run_id: runId,
          }) ?? approvalRecord;
          repair = await runRepair(taskOptions, await seed());
          trace.save('repair-result.json', repair);
        }
        if (repair && repair.status !== 'repaired') {
          await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'interrupted' });
          return await finish(repair.status, { reason: repair.summary });
        }
        const current = await resolved.adapter.readChangeRequest(resolved.projectId, number);
        const branch = await resolved.adapter.client.branch(resolved.projectId, current.target.ref);
        const targetTip = String(branch.data.commit?.id ?? branch.data.commit?.sha ?? '');
        const workspaceHead = (await git(workspace!.path, ['rev-parse', 'HEAD'], trace)).stdout.trim();
        const workspaceStatus = (await git(workspace!.path, ['status', '--porcelain'], trace)).stdout.trim();
        const mergeHead = await git(workspace!.path, ['rev-parse', '--verify', 'MERGE_HEAD'], trace, undefined, true);
        const locallyCommitted = ['verification_passed', 'committing', 'committed', 'pushing'].includes(previousPhase)
          && workspaceHead !== proposal.basis.pr_head_sha && !workspaceStatus && mergeHead.exitCode !== 0;
        const expectedCurrentHead = ['remote_confirmed', 'publication_pending'].includes(previousPhase) ? approvalRecord.commit_sha : proposal.basis.pr_head_sha;
        if ((current.source.sha !== expectedCurrentHead && !(locallyCommitted && current.source.sha === workspaceHead)) || current.source.ref !== proposal.basis.pr_head_ref
            || current.source.pathWithNamespace.toLowerCase() !== proposal.basis.pr_head_repo?.toLowerCase()
            || targetTip !== proposal.basis.current_base_tip_sha || current.target.ref !== proposal.basis.base_ref) {
          await updateConflictApproval(path, approvalRecord.approval_id, { status: 'stale', phase: 'interrupted', rejection_code: 'git_facts_changed' });
          await markConflictProposalStatus(path, proposal.proposal_revision, 'stale', workspace!.path);
          return await finish('stale', { reason: 'GitLab Conflict approval 执行前 Git facts 已变化；不会提交或推送，请重新发送 /conflict。' });
        }
        if (!['remote_confirmed', 'publication_pending'].includes(previousPhase)) {
          const verification = await captureConflictWorkspaceEvidence(workspace!.path, {
            repository: repo, prNumber: number, prHeadSha: proposal.basis.pr_head_sha, historicalBaseSha: snapshot.diffBaseSha ?? snapshot.target.sha,
            currentBaseTipSha: proposal.basis.current_base_tip_sha, baseRef: proposal.basis.base_ref, runId,
            executionId: proposal.repair_execution_id, commandSnapshotId: proposal.basis.command_snapshot_id,
            commandSnapshotSha256: proposal.basis.command_snapshot_sha256,
          }, trace, 'conflict-repair-verification-evidence.json');
          if ((!locallyCommitted && !verification.evidence.merge_pending) || verification.evidence.unresolved_paths.length) {
            await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'interrupted', rejection_code: 'workspace_changed' });
            return await finish('needs_human', { reason: 'GitLab Conflict repair 未留下已解决且可验证的 workspace；不会提交或推送。' });
          }
          approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'verification_passed', verification_at: new Date().toISOString() }) ?? approvalRecord;
          const startHead = proposal.basis.pr_head_sha;
          const commitEvidenceInput = {
            repository: repo, prNumber: number, prHeadSha: proposal.basis.pr_head_sha, historicalBaseSha: snapshot.diffBaseSha ?? snapshot.target.sha,
            currentBaseTipSha: proposal.basis.current_base_tip_sha, baseRef: proposal.basis.base_ref, runId,
            executionId: proposal.repair_execution_id, commandSnapshotId: proposal.basis.command_snapshot_id,
            commandSnapshotSha256: proposal.basis.command_snapshot_sha256,
          };
          let commitEvidence: Awaited<ReturnType<typeof captureConflictWorkspaceEvidence>>;
          if (locallyCommitted) {
            state.current_head_sha = workspaceHead;
            commitEvidence = await captureConflictWorkspaceEvidence(workspace!.path, commitEvidenceInput, trace, 'conflict-repair-commit-evidence.json');
          } else {
            approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'committing' }) ?? approvalRecord;
            await pushSameProjectCandidate('conflict', startHead);
            commitEvidence = await captureConflictWorkspaceEvidence(workspace!.path, commitEvidenceInput, trace, 'conflict-repair-commit-evidence.json');
          }
          approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, {
            phase: 'remote_confirmed', commit_sha: state.current_head_sha, remote_head_sha: state.current_head_sha, pushed_at: new Date().toISOString(),
          }) ?? approvalRecord;
          trace.emit('gitlab_conflict_repair_push_confirmed', { approval_id: approvalRecord.approval_id, sha: state.current_head_sha, evidence_sha256: commitEvidence.evidenceSha256 });
        } else {
          if (!approvalRecord.commit_sha || current.source.sha !== approvalRecord.commit_sha) {
            await updateConflictApproval(path, approvalRecord.approval_id, { status: 'stale', phase: 'interrupted', rejection_code: 'git_facts_changed' });
            return await finish('stale', { reason: 'GitLab 已确认的 Conflict commit 未出现在当前 MR head；不会重复推送。' });
          }
          state.current_head_sha = approvalRecord.commit_sha;
        }
        const answer = `## GitLab Conflict 修复完成\n\n${repair?.summary ?? '已恢复已确认的修复结果。'}\n\nCommit: \`${state.current_head_sha}\`\n验证：${repair?.tests?.join('; ') ?? '已确认 durable repair evidence'}`;
        trace.save('delivery.json', { status: 'repair_completed', head_sha: state.current_head_sha, body: answer, approval_id: approvalRecord.approval_id, proposal_hash: proposal.proposal_hash });
        const stored = await enqueueCommentDelivery({ root: config.root, repo, prNumber: number, purpose: 'conflict_repair',
          semanticKey: proposalDeliverySemanticKey({ ...proposal, status: 'published' }), body: answer, mentions, botLogin,
          source: { run_id: approvalRecord.repair_run_id ?? runId, approval_id: approvalRecord.approval_id, proposal_id: approvalRecord.proposal_id,
            proposal_revision: approvalRecord.proposal_revision, proposal_hash: approvalRecord.proposal_hash, commit_sha: state.current_head_sha,
            repair_execution_id: approvalRecord.repair_execution_id } });
        approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'publication_pending', claim_run_id: runId }) ?? approvalRecord;
        await savePaused(path, { ...(await readPaused(path) ?? retained!), status: 'publication_pending', run_id: approvalRecord.repair_run_id ?? runId, pause_phase: 'publication_pending' });
        const publication = await deliverImmediately(config.root, stored, { adapter: resolved.adapter, botLogin });
        trace.save('conflict-repair-publication.json', publication.publication);
        if (publication.item.status !== 'delivered' || !publication.item.receipt) return await finish('publication_pending', {
          reason: 'GitLab Conflict 修复已验证并确认推送，但最终 Note 仍在 durable outbox 中；不会重复调用模型或推送。', publication: publication.publication,
        });
        await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'completed', final_publication_delivery_id: publication.item.delivery_id,
          final_publication_remote_id: publication.item.receipt.id, final_published_at: publication.item.receipt.published_at ?? new Date().toISOString() });
        const paused = await readPaused(path);
        if (paused?.workspace.path === workspace!.path) await savePaused(path, { ...paused, status: 'completed' });
        preserveWorkspace = false;
        await finalizeDelivery(config.root, stored);
        return await finish('repair_completed', { answer, publication: publication.publication });
      }
      const evidence = await captureConflictWorkspaceEvidence(workspace!.path, {
        repository: repo, prNumber: number, prHeadSha: snapshot.source.sha,
        historicalBaseSha: snapshot.diffBaseSha ?? snapshot.target.sha, currentBaseTipSha: currentBase.sha, baseRef: currentBase.ref,
        runId, executionId: runtime.snapshot.execution_id, commandSnapshotId: snapshotRef.snapshot_id,
        commandSnapshotSha256: snapshotRef.snapshot_sha256,
      }, trace);
      const analysis = await runConflict({ ...taskOptions, tools: {
        read_pr_comments: createTool({ id: 'read_pr_comments', description: 'Read prior GitLab MR Notes for conflict context.',
          inputSchema: z.object({ page: z.number().int().positive().default(1) }),
          execute: async ({ page }) => excerpt(JSON.stringify((await resolved.adapter.listComments(resolved.projectId, number)).slice((page - 1) * 20, page * 20))) }),
      } }, { ...await seed(), conflict_evidence_sha256: evidence.evidenceSha256 });
      trace.save('conflict-result.json', analysis);
      if (analysis.status !== 'proposal_submitted') return await finish(analysis.status, { reason: 'summary' in analysis ? analysis.summary : 'GitLab Conflict Agent 未提交结构化 Proposal。' });
      const proposal = createConflictProposal({ draft: analysis.draft, proposalRevision: 1, executionId: runtime.snapshot.execution_id, runId,
        basis: { pr_head_sha: snapshot.source.sha, pr_head_ref: snapshot.source.ref, pr_head_repo: snapshot.source.pathWithNamespace,
          current_base_tip_sha: currentBase.sha, base_ref: currentBase.ref, workspace_evidence_sha256: evidence.evidenceSha256,
          command_snapshot_id: snapshotRef.snapshot_id, command_snapshot_sha256: snapshotRef.snapshot_sha256 } });
      return await publishConflictProposal(proposal);
    }
    return await finish('needs_human', { reason: 'GitLab conflict approval requires a fresh proposal workflow; no MR approval or merge API is called.' });
  } catch (error) {
    if (error instanceof TaskStopped) return await finish('stopped', { reason: error.message });
    trace.emit('run_error', { error_name: (error as Error).name, message: (error as Error).message });
    return await finish('needs_human', { reason: 'GitLab worker failed before a safe completion.', error_name: (error as Error).name });
  } finally {
    try { await stopWatcher?.close(); }
    finally {
      try { if (workspacePath && !preserveWorkspace) await disposeWorkspacePath(config.root, repo, workspacePath, trace).catch(() => undefined); }
      finally { if (ownsControlPlane) controlPlane?.close(); await release(); }
    }
  }
}
