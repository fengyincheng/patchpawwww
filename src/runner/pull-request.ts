import { watchStop, TaskStopped } from './stop.ts';
import type { WorkspaceState } from '../workspace/manager.ts';
import type { PRTask, ParsedIntent } from './command.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createGitHub } from '../github/client.ts';
import { capturePullRequest, type InspectedPR } from '../github/pull-request.ts';
import { resolveTaskDriver, type TaskProgress } from './tasks/driver.ts';
import { decideWriteback, performWriteback } from './writeback.ts';
import { applyRunPhase, assertRunPhase, createRunState } from './phases.ts';
import { workspaceChangesSince } from '../workspace/manager.ts';
import { ensureRepo, fetchPRState, disposeWorkspacePath } from '../workspace/repo-store.ts';
import { git, gitAuth } from '../workspace/git.ts';
import { Trace } from '../harness/trace.ts';
import { providerError } from '../harness/retry.ts';
import { seedContext } from '../harness/context/seed.ts';
import { budget } from '../harness/budget.ts';
import { claimRun, statePath, writeState, readState, workerStatus, type RunState } from './state.ts';
import { readArtifact, reviewCheckpoint } from './review-lifecycle.ts';
import { patchpawPaths } from '../config/paths.ts';
import { recoverLockedRun, reviewConnection } from './recovery.ts';
import { humanFeedback, hasHumanReplies } from './human-feedback.ts';
import { parsePRIntent } from './command.ts';
import { runClose } from './close.ts';
import { HumanHelpRequested } from '../tasks/human-help.ts';
import { type HumanReply } from './human-reply.ts';
import { type ConflictWorkspaceEvidence } from './workspace-evidence.ts';
import { retainWorkspace, readPaused, savePaused } from './resume.ts';
import { enqueueAndDeliverComment, OutboundPending } from './outbound.ts';
import { hasRunnableWork } from './runnable.ts';
import { bootstrapControlPlane, getRepositoryByName, getRepositoryByStorageKey, openControlPlaneDb } from '../control-plane/index.ts';
import type { ControlPlaneDb } from '../control-plane/db.ts';
import type { RuntimeExecution } from '../harness/runtime.ts';
import { classifyRunFailure, terminalStatusForFailure } from './failures.ts';
import {
  CONFLICT_APPROVAL_ENABLED, markCurrentConflictProposalStale,
  proposalPointerForState, readCurrentConflictProposal,
} from './conflict-proposals.ts';
import {
  isUnfinishedConflictApproval, readUnfinishedConflictApproval, updateConflictApproval, type ConflictApprovalRecord,
} from './conflict-approval.ts';
import { isSameRepoWriteback } from './command-approval.ts';
import { readCurrentApprovalPlan, readUnfinishedApprovalPlanClaim, type ApprovalPlan, type ApprovalPlanClaim } from './approval-plans.ts';
import { runLegacyConflictRepair } from './legacy-conflict-repair.ts';
import { recoverLegacyConflictApproval } from './legacy-conflict-recovery.ts';
import { prepareExecution, type ExecutionManifest } from './execution-preparation.ts';
import { runTaskDriver } from './task-execution.ts';
import { publishApprovalPlan as publishApprovalPlanDomain } from './approval-plan-publication.ts';
import { runConversationReply } from './conversation-runner.ts';
import { runReviewTask } from './review-runner.ts';
import { runConflictTask } from './conflict-runner.ts';
import { approvalPlanBinding, claimApprovalPlan } from './approval-plan-execution.ts';
import { prepareEntryLifecycle } from './entry-lifecycle.ts';
import { disposeTerminalWorkspace as disposeTerminalWorkspaceDomain, finishRun } from './run-finalizer.ts';
import { refuseCloseOnActiveTask } from './close-refusal.ts';
import { publishTaskWithLifecycle } from './task-publication.ts';
import { settleApprovalPlanClaim } from './approval-plan-settlement.ts';
import { runApprovalPlanTask } from './approval-plan-task.ts';
import { GitHubAdapter } from '../scm/github/adapter.ts';
import type { ChangeRequestSnapshot, ScmAdapter } from '../scm/types.ts';
import type { OutboundConnection } from './outbound.ts';

function isApprovalComment(body: string) {
  return /^\s*@[^\s]+\s+\/(?:approval|approve)(?=$|\s)/i.test(body);
}

export type ScmRunContext = {
  adapter: ScmAdapter;
  projectId: string;
  snapshot: ChangeRequestSnapshot;
  snapshotPath?: string;
  connection?: () => Promise<OutboundConnection>;
};

export async function runPullRequest(config: { appId?: number; privateKey?: string; snapshotRoot: string; root: string; operatorLogin?: string; appSlug?: string; botLogin?: string; controlPlaneDb?: ControlPlaneDb; gitlabConnections?: Array<{ id: string; instanceUrl: string; projectIds: string[]; token?: string; botUserId?: string; botLogin?: string }> }, repo: string, number: number, scmContext?: ScmRunContext) {
  if (repo.startsWith('gitlab:') && !scmContext) {
    const { runGitLabMergeRequest } = await import('../scm/gitlab/runner.ts');
    return runGitLabMergeRequest(config, repo, number);
  }
  const path = statePath(patchpawPaths(config.root).state, repo, number);
  if (workerStatus(await readState(path)) === 'running') return { status: 'already_running' };
  if (!await hasRunnableWork(config.root, repo, number)) return { status: 'mention_required' };
  const release = await claimRun(path);
  if (!release) return { status: 'already_running' };
  const github = scmContext ? undefined : (() => {
    if (config.appId === undefined || !config.privateKey) throw new Error('GitHub App configuration is unavailable');
    return createGitHub({ appId: config.appId, privateKey: config.privateKey });
  })();
  let controlPlane: ControlPlaneDb | undefined = config.controlPlaneDb;
  let ownsControlPlane = false;
  let botLogin = scmContext?.adapter.botLogin ?? config.botLogin ?? (config.appSlug ? `${config.appSlug}[bot]` : '');
  let appSlug = config.appSlug ?? config.botLogin?.replace(/\[bot\]$/, '');
  let recoveryTarget: string | undefined;
  let priorConflictProposal: RunState['conflict_proposal'];
  let approvalRecovery: ConflictApprovalRecord | undefined = await readUnfinishedConflictApproval(path) ?? undefined;
  // A durable generic ApprovalPlan claim is an ordered PR-local job just like a legacy Conflict
  // Approval. It must wake the runner without a new human comment and must never consume a later
  // comment while it is being recovered.
  let genericApprovalRecovery = await readUnfinishedApprovalPlanClaim(path);
  let priorClose: Pick<RunState, 'closed_at' | 'closed_through_comment_id' | 'close_start_notice_id' | 'close_comment_id' | 'close_mentions' | 'completion_notice_id' | 'completion_notice_status' | 'pending_close_refusal'> | undefined;
  let closeResult: Awaited<ReturnType<typeof runClose>> | undefined;
  try {
    const entryConnection = scmContext?.connection ?? (async (): Promise<OutboundConnection> => {
      if (!github) throw new Error('GitHub connection is unavailable');
      const [owner, name] = repo.split('/');
      const { data: installation } = await github.app.rest.apps.getRepoInstallation({ owner, repo: name });
      return { client: github.installation(installation.id), botLogin };
    });
    const entry = await prepareEntryLifecycle({ config, resolveConnection: entryConnection,
      repo, prNumber: number, path, appSlug, botLogin });
    appSlug = entry.appSlug;
    botLogin = entry.botLogin;
    closeResult = entry.closeResult;
    recoveryTarget = entry.recoveryTarget;
    priorClose = entry.priorClose;
    priorConflictProposal = entry.priorConflictProposal;

  } catch (error) {
    await release(); throw error;
  }
  if (closeResult) {
    try { return closeResult; }
    finally { await release(); }
  }
  if (recoveryTarget) {
    const recoveryConnection = scmContext
      ? reviewConnection(config, repo, number, { adapter: scmContext.adapter, projectId: scmContext.projectId })
      : undefined;
    try { return await recoverLockedRun(config, repo, number, recoveryTarget, recoveryConnection); }
    finally { await release(); }
  }
  if (!await hasHumanReplies(path) && !approvalRecovery && !genericApprovalRecovery) {
    // Pure outbound retries belong to the independent scheduler. A direct
    // worker invocation must not allocate a new Agent run for them.
    try { return { status: 'mention_required' }; }
    finally { await release(); }
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const trace = new Trace(join(patchpawPaths(config.root).runs, runId));
  if (config.privateKey) trace.secret(config.privateKey);
  const priorState = await readState(path);
  const priorHandledCommentIds = priorState?.handled_comment_ids ?? [];
  const priorLastPatchpawCommit = priorState?.last_patchpaw_commit ?? null;
  const state: RunState = createRunState({ repo, pr_number: number, run_id: runId, current_head_sha: '', repair_attempts: 0,
    last_patchpaw_commit: null, active: true, pid: process.pid,
    // Durable /close facts carry into the fresh generation: the retired-comment high-water mark
    // and a still-pending completion notice are never lost to a state overwrite.
    ...(priorClose ?? {}), ...(priorConflictProposal ? { conflict_proposal: priorConflictProposal } : {}) }, 'inspect');
  let inspected: InspectedPR | undefined;
  let snapshotPath: string | undefined = scmContext?.snapshotPath;
  let changeRequest: ChangeRequestSnapshot | undefined = scmContext?.snapshot;
  let scm: ScmAdapter | undefined = scmContext?.adapter;
  const projectId = scmContext?.projectId ?? repo;
  let confirmedRemoteHead: string | undefined;
  let executionId = 1;
  let workspaceNotice = '';
  let activeWorkspace: WorkspaceState | undefined;
  let conflictEvidence: { evidence: ConflictWorkspaceEvidence; evidenceSha256: string } | undefined;
  let approvalRequested = false;
  let approvedConflictRepair = false;
  let approvalRecord: ConflictApprovalRecord | undefined = approvalRecovery;
  let genericApprovalClaim: ApprovalPlanClaim | undefined;
  // Assigned inside the run body; the catch path needs it to settle a crashed approved write.
  let settleGenericApprovalClaim: (phase: 'completed' | 'interrupted') => Promise<void> = async () => undefined;
  let runtimeExecution: RuntimeExecution | undefined;
  let manifest: ExecutionManifest;
  // Cleanup ownership of a fresh worktree begins the moment its creation is attempted: a
  // half-created or prepare-failed worktree must never leak outside the run's lifecycle.
  let createdWorkspace: string | undefined;
  let activeTask: PRTask = 'conversation';
  let stop: ReturnType<typeof watchStop> | undefined;
  let feedback: Awaited<ReturnType<typeof humanFeedback>>['context'];
  const requireStop = () => {
    if (!stop) throw new Error('Run stop controller is unavailable');
    return stop;
  };
  const requireControlPlane = () => {
    if (!controlPlane) throw new Error('Control-plane database is unavailable');
    return controlPlane;
  };
  const requireConflictEvidence = () => {
    if (!conflictEvidence) throw new Error('Conflict workspace evidence is unavailable');
    return conflictEvidence;
  };
  const recipients = () => {
    const newCommentIds = new Set(feedback?.new_comment_ids ?? []);
    return [changeRequest?.author.login, config.operatorLogin ?? repo.split('/')[0],
      ...(feedback?.comments ?? []).filter(comment => newCommentIds.has(comment.comment_id)).map(comment => comment.author)]
      .filter((login): login is string => !!login);
  };
  const deliverComment = (purpose: string, semanticKey: string, body: string, mentions: string[], source: Record<string, string | number | null | undefined> = {}) => {
    if (!scm || !botLogin) throw new Error('SCM adapter and bot identity are required before publishing a task report');
    return enqueueAndDeliverComment({ root: config.root, repo, prNumber: number, purpose, semanticKey, body, mentions,
      botLogin, source: { project_id: projectId, ...source } }, { adapter: scm, botLogin });
  };
  const requireScm = () => {
    if (!scm) throw new Error('SCM adapter is unavailable');
    return scm;
  };
  const phase = async (raw: string) => { const value = assertRunPhase(raw); applyRunPhase(state, value);
    await writeState(path, state); trace.emit('phase', { phase: value }); console.log(JSON.stringify({ run_id: runId, phase: value })); };
  const finish = (status: string, extra: { reason?: string; message?: string; [key: string]: unknown } = {}, persistedPhase = status) => finishRun({
    root: config.root, repo, prNumber: number, projectId, runId, executionId, statePath: path, state, trace, scm: requireScm(), botLogin, activeTask, approvedConflictRepair,
    activeWorkspace, changeRequest, confirmedRemoteHead, stop, workspaceNotice, recipients,
    genericApprovalClaim: genericApprovalClaim ? approvalPlanBinding(genericApprovalClaim) : undefined, phase, settleGenericApprovalClaim,
  }, status, extra, persistedPhase);
  const disposeTerminalWorkspace = () => disposeTerminalWorkspaceDomain({
    root: config.root, repo, path, trace, activeWorkspace, createdWorkspace,
  });

  try {
    // A claimed Approval is an ordered PR-local job. Do not consume a later human comment while
    // recovering it; the later comment remains in the inbox for the next generation.
    const recoveryEntry = approvalRecovery || genericApprovalRecovery;
    const replies = recoveryEntry
      ? { handledIds: (await readState(path))?.handled_comment_ids ?? [], context: undefined }
      : await humanFeedback(path, patchpawPaths(config.root).runs, true);
    feedback = replies.context; state.handled_comment_ids = replies.handledIds;
    if (!feedback && !recoveryEntry) return { status: 'mention_required' };
    // Production configuration supplies the app slug. Keeping identity in local config lets
    // failure notices be prepared durably before any GitHub installation/app lookup; identity
    // discovery remains a delivery-time fallback for old callers without the configured slug.
    if (!appSlug) {
      const configured = config.botLogin?.replace(/\[bot\]$/, '');
      if (configured) appSlug = configured;
    }
    if (!appSlug && scm) appSlug = botLogin.replace(/\[bot\]$/i, '');
    if (!appSlug) throw new Error('SCM Bot identity is unavailable');
    botLogin = botLogin || `${appSlug}[bot]`;
    // Do not persist the approval comment's high-water mark during the initial inspect phase.
    // The approval record must win the crash race: once that record is durable, prepare below
    // retires the source comment atomically with the claimed state; before then it remains wakeable.
    const newCommentIds = new Set(feedback?.new_comment_ids ?? []);
    const pendingApprovalComment = feedback?.comments.find(comment => newCommentIds.has(comment.comment_id) && isApprovalComment(comment.body));
    if (pendingApprovalComment) state.handled_comment_ids = priorHandledCommentIds.filter((id: number) => id !== pendingApprovalComment.comment_id);
    const triggeringComment = feedback?.comments.find(comment => newCommentIds.has(comment.comment_id));
    let task: PRTask = 'conversation';
    let intent: ParsedIntent = { kind: 'conversation', repositoryId: '' };
    activeTask = task;
    // An /close arriving mid-task is refused mechanically by the owning worker (no model, no
    // queued destruction). Durable retirement comes FIRST: the comment must never become an
    // executable /close after this task ends, even when the refusal notice cannot be published.
    // A failed notice waits in the tiny state outbox (pending_close_refusal) and the next
    // PatchPaw entry retries it deterministically.
    const refuseClose = (comment: HumanReply) => refuseCloseOnActiveTask({
    root: config.root, repo, prNumber: number, runId, statePath: path, state, trace, botLogin, connection: async () => {
      if (scm) return { adapter: scm, botLogin };
      if (!github) throw new Error('GitHub connection is unavailable');
      const [owner, name] = repo.split('/');
      const { data: installation } = await github.app.rest.apps.getRepoInstallation({ owner, repo: name });
      return { client: github.installation(installation.id), botLogin };
    }, comment,
    });
    stop = watchStop(path, botLogin, () => state.handled_comment_ids ?? [], refuseClose);
    if (feedback) trace.save('human-feedback.json', feedback);
    await phase('inspect');
    // Approval needs to explain a closed change request without turning the inspection failure
    // into a generic harness error. GitHub keeps its capture artifact; GitLab enters with the
    // already-resolved normalized snapshot and adapter.
    const pr = github ? await capturePullRequest(github, repo, number, config.snapshotRoot, { allowClosed: true }) : undefined;
    if (pr) {
      inspected = pr;
      snapshotPath = pr.snapshotPath;
    }
    if (!scm) {
      if (!pr) throw new Error('SCM inspection did not produce a GitHub capture');
      scm = new GitHubAdapter(pr.client, botLogin);
    }
    changeRequest = await scm.readChangeRequest(projectId, number, { allowClosed: true });
    state.current_head_sha = changeRequest.source.sha;
    confirmedRemoteHead = changeRequest.source.sha;
    const adapter = scm;
    const currentChangeRequest = changeRequest;
    // Bootstrap only fills genuinely missing control-plane records. Existing repository
    // edits remain authoritative, so every new invocation resolves the current config.
    controlPlane = config.controlPlaneDb ?? await openControlPlaneDb(config.root);
    ownsControlPlane = !config.controlPlaneDb;
    await bootstrapControlPlane({ root: config.root, repositories: scmContext ? [{ fullName: changeRequest.repository.pathWithNamespace,
      displayName: changeRequest.repository.pathWithNamespace, scmKind: changeRequest.kind, connectionId: changeRequest.repository.connectionId,
      remoteProjectId: changeRequest.repository.remoteProjectId, pathWithNamespace: changeRequest.repository.pathWithNamespace,
      webUrl: changeRequest.repository.webUrl, cloneUrl: changeRequest.repository.cloneUrl, storageKey: repo }] : [{ fullName: repo }], controlPlaneDb: controlPlane });
    const repository = scmContext ? await getRepositoryByStorageKey(controlPlane, repo) : await getRepositoryByName(controlPlane, repo);
    if (!repository) throw new Error(`Control-plane repository is missing after bootstrap: ${repo}`);
    const preparedControlPlane = requireControlPlane();
    intent = triggeringComment
      ? await parsePRIntent(controlPlane, repository.id, triggeringComment.body, appSlug)
      : { kind: 'control', control: 'approval' };
    let currentApprovalPlan = await readCurrentApprovalPlan(path);
    const requireApprovalPlan = () => {
      if (!currentApprovalPlan) throw new Error('Approval Plan is unavailable');
      return currentApprovalPlan;
    };
    task = intent.kind === 'command' ? intent.executionType : intent.kind === 'control' && intent.control === 'approval' && currentApprovalPlan
      ? currentApprovalPlan.plan.execution_type : intent.kind === 'control' && intent.control === 'stop' ? 'stop'
      : intent.kind === 'control' && intent.control === 'close' ? 'close'
      : intent.kind === 'control' && intent.control === 'approval' ? 'conflict' : 'conversation';
    activeTask = task;
    approvalRequested = intent.kind === 'control' && intent.control === 'approval';
    if (approvalRequested && state.closed_at) {
      if (approvalRecovery && isUnfinishedConflictApproval(approvalRecovery)) {
        approvalRecord = await updateConflictApproval(path, approvalRecovery.approval_id, {
          status: 'stale', phase: 'interrupted', rejection_code: 'approval_after_close',
        }) ?? approvalRecovery;
      }
      return await finish('closed', { reason: '该 PR 的 PatchPaw 本地 generation 已 closed；迟到 /approval 评论已退休，不会复活旧的 Proposal、workspace 或 repair。' }, 'closed');
    }
    if (!['open', 'opened'].includes(changeRequest.state) && !approvalRequested) throw new Error('Change request is not open or has no source repository');
    if (approvalRequested && !currentApprovalPlan && !CONFLICT_APPROVAL_ENABLED) {
      return await finish('needs_human', { reason: 'Conflict approval gate is disabled.' });
    }
    if (intent.kind === 'control' && intent.control === 'close') {
      return await finish('needs_human', { reason: '/close 是机械生命周期命令，但本条评论未能在前置生命周期入口处理；没有启动模型或修复。请重发一次单独的 /close。' });
    }
    const token = async () => {
      const installationGitToken = scm?.installationGitToken;
      if (!installationGitToken) throw new Error('SCM installation Git token is unavailable');
      const value = await installationGitToken.call(scm);
      trace.secret(value); trace.secret(Buffer.from(`x-access-token:${value}`).toString('base64'));
      return value;
    };
    await requireStop().guard();
    const retained = await readPaused(path);
    const currentConflictProposal = await readCurrentConflictProposal(path);
    currentApprovalPlan = currentApprovalPlan ?? await readCurrentApprovalPlan(path);
    const retainedForDiscussion = retained && ['budget_exhausted', 'needs_human', 'stopped', 'publication_pending', 'awaiting_approval', 'claimed', 'repairing'].includes(retained.status);
    const discussingConflict = task === 'conversation' && !!retainedForDiscussion && !!currentConflictProposal
      && retained?.workspace.path === currentConflictProposal.pointer.workspace_path
      && ['draft', 'publication_pending', 'published'].includes(currentConflictProposal.proposal.status);
    const discussingPause = (task === 'conversation' && !!retainedForDiscussion && !currentConflictProposal)
      || discussingConflict;
    if (task === 'stop' && currentConflictProposal) {
      // /stop is mechanical even while a proposal is awaiting publication/approval. Preserve the
      // proposal pointer and retained checkout, but never turn a stop comment into a model turn.
      state.conflict_proposal = proposalPointerForState(currentConflictProposal.proposal, currentConflictProposal.pointer.workspace_path);
      return await finish('stopped', { reason: 'Conflict Proposal 已保留；/stop 只停止当前本地会话，不会调用模型或启动修复。' });
    }
    if (task === 'stop' && !discussingPause) return await finish('stopped', { reason: '当前没有正在执行的任务或可继续的暂停工作区。没有启动新任务。' });
    if (retained && ['budget_exhausted', 'needs_human', 'stopped'].includes(retained.status)
      && !discussingPause && task !== retained.task) {
      return await finish('needs_human', { reason: `当前有暂停的 /${retained.task} 工作区。请先沟通并用 /${retained.task} 继续该任务；此次没有另建工作区。` });
    }
    await phase('workspace');
    // Every run refreshes the one shared object store for this GitHub repo BEFORE the
    // resume/fresh decision; fetching never mutates an existing paused worktree's HEAD/index.
    await ensureRepo(config.root, repo, changeRequest.repository.cloneUrl, trace);
    const fetchedBase = await fetchPRState(config.root, repo, { headSha: changeRequest.source.sha, baseRef: changeRequest.target.ref,
      sourceRemoteUrl: changeRequest.source.cloneUrl }, trace, gitAuth(await token(), changeRequest.repository.cloneUrl, 'x-access-token', scm.connection.instanceUrl));
    const currentBase = { ref: fetchedBase.baseRef, sha: fetchedBase.currentBaseTipSha };
    const legacyRecovery = await recoverLegacyConflictApproval({
      root: config.root, statePath: path, repo, prNumber: number, runId, executionId, botLogin, trace, state, changeRequest, scm, projectId, currentBase,
      retained: retained ?? undefined, currentConflictProposal: currentConflictProposal ?? undefined, approvalRequested, approvalRecovery,
      controlPlane, recipients, finish, confirmedRemoteHead,
      setApprovalRecord: value => { approvalRecord = value; },
      setConfirmedRemoteHead: value => { confirmedRemoteHead = value; },
    });
    approvalRecord = legacyRecovery.approvalRecord;
    confirmedRemoteHead = legacyRecovery.confirmedRemoteHead;
    if (legacyRecovery.handled) return legacyRecovery.result;

    if (discussingConflict && currentConflictProposal) {
      const basis = currentConflictProposal.proposal.basis;
      const staleReason = basis.pr_head_sha !== changeRequest.source.sha ? 'pr_head_changed'
        : basis.current_base_tip_sha !== currentBase.sha ? 'current_base_tip_changed'
        : basis.base_ref !== currentBase.ref ? 'base_ref_changed' : undefined;
      if (staleReason) {
        if (!retained) throw new Error('Conflict discussion is missing its retained workspace');
        await markCurrentConflictProposalStale(path, retained.workspace.path, staleReason);
        await savePaused(path, { ...retained, status: 'stale', reason: staleReason });
        state.conflict_proposal = { ...proposalPointerForState(currentConflictProposal.proposal, retained.workspace.path), status: 'stale' };
        await writeState(path, applyRunPhase({ ...state, active: false }, 'stale'));
        try { await disposeWorkspacePath(config.root, repo, retained.workspace.path, trace); }
        catch (error) { trace.emit('stale_workspace_dispose_failed', { workspace: retained.workspace.path, reason: staleReason, message: (error as Error).message }); }
        return await finish('stale', { reason: `当前 Git 事实已变化（${staleReason}），旧 Conflict Proposal 已标记 stale；不会基于旧工作区继续讨论或发布修订。请重新发送 /conflict。` });
      }
    }
    const preparedExecution = await prepareExecution({
      root: config.root, repo, prNumber: number, runId, trace, state, changeRequest: currentChangeRequest, scm: adapter, projectId,
      snapshotPath, path, task, intent, repository, currentApprovalPlan,
      approvalRequested, approvedConflictRepair, approvalRecord, approvalRecovery, triggeringComment, feedback,
      currentBase, retained, currentConflictProposal, discussingPause, discussingConflict, botLogin, stop: requireStop(), workspaceNotice, executionId, phase, finish,
      controlPlane: preparedControlPlane,
      setCreatedWorkspace: value => { createdWorkspace = value; },
      setActiveWorkspace: value => { activeWorkspace = value; },
      setExecutionId: value => { executionId = value; },
    });
    if (preparedExecution.handled) return preparedExecution.result;
    approvedConflictRepair = preparedExecution.approvedConflictRepair;
    approvalRecord = preparedExecution.approvalRecord;
    executionId = preparedExecution.executionId;
    runtimeExecution = preparedExecution.runtimeExecution;
    const preparedRuntimeExecution = runtimeExecution;
    if (!preparedRuntimeExecution) throw new Error('Runtime execution is unavailable after preparation');
    manifest = preparedExecution.manifest;
    activeWorkspace = preparedExecution.ws;
    workspaceNotice = preparedExecution.workspaceNotice;
    const { genericApprovalWrite, resumed, ws, snapshot, snapshotReference, conflictEvidence: preparedConflictEvidence } = preparedExecution;
    conflictEvidence = preparedConflictEvidence;

    const permissionPhase = genericApprovalWrite ? 'approved_write' as const : snapshot.command?.permission === 'read_write_approval' ? 'planning' as const : 'normal' as const;
    const taskOptions = { task, prompt: '', ws, trace, runId, currentBase, execution: preparedRuntimeExecution, permissionPhase,
      approvalMessage: genericApprovalWrite ? '用户批准了你的计划' : undefined,
      preventGitPush: snapshot.command?.permission !== 'read_only',
      prMemory: { root: patchpawPaths(config.root).memory, repo, number },
      repairStartHead: resumed ? (resumed.remote_head ?? ws.initialHead) : undefined,
      stopSignal: stop.signal, stopRequest: stop.request,
      onCloseout: () => phase('repair_closeout') };
    // Harness-owned writeback applies to every execution type that has write capability.
    // read_write_approval only becomes writable in the approved_write phase.
    // Whether this execution may write back is the writeback domain's decision, not a boolean
    // assembled here. It runs before the Agent receives write tools, so a fork is refused before
    // any capability exists rather than after something has already been changed.
    const writeback = decideWriteback({ permission: snapshot.command?.permission, approvedWrite: genericApprovalWrite,
      sameRepo: isSameRepoWriteback(currentChangeRequest, repo) });
    if (writeback.kind === 'refused') {
      return await finish('needs_human', { reason: writeback.reason, approval_rejection_code: writeback.code });
    }
    const seed = async () => ({ ...await seedContext(currentChangeRequest, ws, trace, currentBase), human_feedback: feedback,
      execution_id: executionId, resumed: !!resumed, retained_for_discussion: !!discussingPause, workspace_notice: workspaceNotice, previous_stop_report: resumed ? await readArtifact(trace.dir, 'resume-stop-report.json') : null,
      previous_closeout: resumed ? await readArtifact(trace.dir, 'resume-closeout.json') : null,
      conflict_workspace_evidence: conflictEvidence?.evidence ?? null,
      pending_conflict_proposal: discussingConflict || approvedConflictRepair ? currentConflictProposal?.proposal ?? null : null,
      conflict_approval: approvedConflictRepair ? approvalRecord ?? null : null,
      approved_conflict_proposal: approvedConflictRepair ? currentConflictProposal?.proposal ?? null : null });
    const beginTask = async (task: string) => { manifest.task_chain.push(task); trace.save('manifest.json', manifest);
      await requireStop().guard();
      await phase(task === 'review' ? 'review_running' : task); };
    const assertCurrent = async () => {
      const current = await adapter.readChangeRequest(projectId, number, { allowClosed: true });
      if (!['open', 'opened'].includes(current.state) || current.source.sha !== state.current_head_sha
          || current.source.ref !== currentChangeRequest.source.ref
          || current.source.pathWithNamespace.toLowerCase() !== currentChangeRequest.source.pathWithNamespace.toLowerCase()
          || current.target.ref !== currentChangeRequest.target.ref || current.target.sha !== ws.mainSha) {
        throw new Error('Change request head, target, source, or state changed during the run');
      }
    };
    // The durable generic approval claim only exists while an approved write is in flight. It is
    // settled once the write has a durable outcome, so a crash-recovered worker never replays it.
    settleGenericApprovalClaim = phase => settleApprovalPlanClaim({ path, trace, claim: genericApprovalClaim, phase });
    const deliver = (status: 'custom_completed' | 'conflict_completed' | 'ci_completed' | 'repair_completed', body: string) => publishTaskWithLifecycle({
      root: config.root, repo, prNumber: number, runId, path, workspacePath: ws.path, status, body, workspaceNotice,
      headSha: state.current_head_sha, projectId, mentions: recipients(), botLogin, adapter, trace,
      approvalPlan: genericApprovalClaim ? approvalPlanBinding(genericApprovalClaim) : undefined, guard: () => requireStop().guard(), finish,
    });
    const publishApprovalPlan = async (body: string) => publishApprovalPlanDomain({
      root: config.root, repo, prNumber: number, runId, executionId, path, task: task as ApprovalPlan['execution_type'], body,
      snapshot, snapshotSha256: snapshotReference.snapshot_sha256, currentApprovalPlan,
      setCurrentApprovalPlan: value => { currentApprovalPlan = value; },
      conflictEvidence: requireConflictEvidence(), currentBase, source: currentChangeRequest, adapter, projectId, workspace: ws, state, trace,
      mentions: recipients(), botLogin, finish,
    });
    if (genericApprovalWrite) {
      const execution = await claimApprovalPlan({
        root: config.root, repo, prNumber: number, runId, executionId, path, trace, state, source: currentChangeRequest, adapter, projectId, currentBase, workspace: ws,
        snapshot, snapshotSha256: snapshotReference.snapshot_sha256, currentApprovalPlan: requireApprovalPlan(),
        recovery: genericApprovalRecovery, claim: genericApprovalClaim, setClaim: value => { genericApprovalClaim = value; },
        triggeringComment, botLogin, priorLastPatchpawCommit, finish,
      });
      genericApprovalClaim = execution.claim;
      if (execution.handled) return execution.result;
    }
    // A Conflict run whose merge is already satisfied is a mechanical no-op under every
    // Permission, including the read-only planning phase of read_write_approval.
    if (task === 'conflict' && !approvedConflictRepair && !ws.mergePending
        && (!resumed || (resumed.local_head === currentChangeRequest.source.sha && !(await git(ws.path, ['status', '--porcelain'])).stdout.trim()))) {
      return await deliver('conflict_completed', '当前 PR 已包含目标分支，无需修复合并冲突；没有修改或提交代码。');
    }
    const writebackPermit = writeback.kind === 'allowed' ? writeback.permit : undefined;
    const writebackEnabled = writebackPermit !== undefined;
    // Harness-owned writeback. The sequence lives in the writeback domain; this closure only
    // records its outcome in run state, which is the runner's business.
    const publish = async (kind: string) => {
      if (!writebackPermit) throw new Error('Writeback was requested without an enabled permission capability');
      const outcome = await performWriteback({ workspace: ws, trace, scm: adapter, projectId,
        changeRequestNumber: number, expectedBaseSha: currentBase.sha, sameRepo: isSameRepoWriteback(currentChangeRequest, repo), kind,
        permit: writebackPermit, previousHead: state.current_head_sha, baseRef: currentChangeRequest.target.ref, headRef: currentChangeRequest.source.ref,
        headRepo: currentChangeRequest.source.pathWithNamespace, remoteUrl: currentChangeRequest.repository.cloneUrl,
        credentialScopeUrl: adapter.connection.instanceUrl, token, guard: () => requireStop().guard(), beforePush: async (candidateSha) => {
          state.current_head_sha = candidateSha;
          state.last_patchpaw_commit = candidateSha;
          await phase('publishing');
        } });
      state.current_head_sha = outcome.confirmedRemoteHead; state.last_patchpaw_commit = outcome.commitSha;
      confirmedRemoteHead = outcome.confirmedRemoteHead;
    };
    const hasWorkspaceChanges = async () => (await workspaceChangesSince(ws, state.current_head_sha, trace)).has_changes;
    // A task whose execution this runner cannot express generically runs through its driver. The
    // driver decides what the task needs from freshly-read real state; this runner performs every
    // durable effect it asks for — the Agent turn, writeback, publication, the terminal result.
    // The runner therefore never branches on which task this is: the loop below is identical for
    // any driver, and the only task-shaped facts it handles are the ones the driver declares.
    const taskDriver = resolveTaskDriver(snapshot.template_type);
    if (taskDriver) {
      const progress: TaskProgress = { turns: [] };
      const execution = await runTaskDriver({
        driver: taskDriver, phase: permissionPhase, writable: writebackEnabled, repo, scm: adapter,
        projectId, changeRequestNumber: number, trace,
        signal: stop.signal, options: taskOptions, repairAttempts: () => state.repair_attempts,
        repairBudget: budget.repairAttempts, resumed: resumed ? { pausePhase: resumed.pause_phase } : null, progress,
        guardCycle: async (phaseLabel: string) => { await phase(phaseLabel); await assertCurrent(); await requireStop().guard(); },
        beginTask, seed, finish, deliver, hasWorkspaceChanges, publish,
        headSha: () => state.current_head_sha,
        saveRepairAttempts: async () => { state.repair_attempts++; await writeState(path, state); },
        publishApprovalPlan,
      });
      if (execution.handled) return execution.result;
    }
    if (!approvalRequested && snapshot.command?.permission === 'read_write_approval') {
      const planning = await runApprovalPlanTask({ task, taskOptions, seed, beginTask,
        publishApprovalPlan, finish });
      if (planning.handled) return planning.result;
      throw new Error(`No planning path for execution type ${snapshot.template_type}; it needs a task driver.`);
    }
    if (task === 'conversation' || task === 'stop') {
      return await runConversationReply({
        repo, prNumber: number, runId, trace, scm: adapter, projectId,
        taskOptions, seed, beginTask, deliverComment, recipients, finish,
      });
    }
    if (task === 'review') {
      return await runReviewTask({
        root: config.root, repo, prNumber: number, trace, state, path, resumed: resumed ? { run_id: resumed.run_id } : null,
        currentHead: () => state.current_head_sha, taskOptions, seed, workspaceNotice,
        writable: writebackEnabled, hasWorkspaceChanges, publish, stopGuard: () => requireStop().guard(),
        savePausedCompleted: async () => { const paused = await readPaused(path); if (paused?.workspace.path === ws.path) await savePaused(path, { ...paused, status: 'completed' }); },
        beginTask, connection: async () => ({ adapter, projectId, botLogin, mentions: recipients() }), mentions: recipients, finish, settleApproval: settleGenericApprovalClaim,
      });
    }
    if (task === 'conflict') {
      if (approvedConflictRepair) {
        if (!approvalRecord || !currentConflictProposal) throw new Error('Approved Conflict repair is missing its durable approval or proposal.');
        await beginTask('conflict-repair');
        const outcome = await runLegacyConflictRepair({
        root: config.root, repo, prNumber: number, runId, executionId, path, trace, changeRequest: currentChangeRequest, scm: adapter, projectId, currentBase,
          retained: retained ?? (() => { throw new Error('Approved Conflict repair is missing its retained workspace.'); })(), workspace: ws, state, approvalRecord, proposal: currentConflictProposal.proposal, confirmedRemoteHead,
          taskOptions, seed, phase, finish, token, guard: () => requireStop().guard(), botLogin, recipients,
          setApprovalRecord: value => { approvalRecord = value; },
          setConfirmedRemoteHead: sha => { confirmedRemoteHead = sha; },
        });
        approvalRecord = outcome.approvalRecord;
        confirmedRemoteHead = outcome.confirmedRemoteHead;
        return outcome.result;
      }
      if (!ws.mergePending && (!resumed || (resumed.local_head === currentChangeRequest.source.sha && !(await git(ws.path, ['status', '--porcelain'])).stdout.trim()))) return await deliver('conflict_completed', '当前 change request 已包含目标分支，无需修复合并冲突；没有修改或提交代码。');
      return await runConflictTask({
        repo, prNumber: number, scm: adapter, projectId,
        baseSha: currentChangeRequest.diffBaseSha ?? currentChangeRequest.target.sha, baseRef: currentChangeRequest.target.ref, taskOptions, seed, trace, workspace: ws, path, runId, beginTask,
        retainWorkspace: async input => retainWorkspace(path, trace, input),
        executionId, writebackEnabled, hasWorkspaceChanges, publish, deliver, finish,
        currentHead: () => state.current_head_sha,
      });
    }
  } catch (error) {
    if (error instanceof TaskStopped || stop?.signal.aborted) {
      if (approvalRecord?.status === 'accepted' && approvalRecord.phase !== 'completed') {
        approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'interrupted' }) ?? approvalRecord;
        trace.emit('conflict_approval_interrupted', { approval_id: approvalRecord.approval_id, reason: 'human_stop' });
      }
      await settleGenericApprovalClaim('interrupted');
      if (activeWorkspace && changeRequest && ['conflict', 'ci', 'repair', 'review'].includes(activeTask)) {
        await retainWorkspace(path, trace, { run_id: runId, execution_id: executionId, task: activeTask as 'conflict' | 'ci' | 'repair' | 'review',
          base_sha: changeRequest.diffBaseSha ?? changeRequest.target.sha, base_ref: changeRequest.target.ref, workspace: activeWorkspace, pause_reason: 'human_stop',
          remote_head: confirmedRemoteHead, pause_phase: state.phase });
      }
      return await finish('stopped', { reason: error instanceof TaskStopped ? error.message : new TaskStopped().message });
    }
    if (approvalRecord?.status === 'accepted' && approvalRecord.phase === 'repairing') {
      approvalRecord = await updateConflictApproval(path, approvalRecord.approval_id, { phase: 'interrupted' }) ?? approvalRecord;
      trace.emit('conflict_approval_interrupted', { approval_id: approvalRecord.approval_id, reason: 'harness_or_provider_failure' });
    }
    if (error instanceof HumanHelpRequested) {
      await settleGenericApprovalClaim('interrupted');
      return await finish('needs_human', { reason: error.message });
    }
    trace.emit('run_error', { phase: state.phase, ...providerError(error), message: (error as Error).message });
    if (await readArtifact(trace.dir, 'review.json')) {
      if (error instanceof OutboundPending) trace.save('result.json', { status: 'review_publication_pending', run_id: runId,
        repo, pr_number: number, final_head_sha: state.current_head_sha, delivery_id: error.delivery.delivery_id });
      state.active = false; await phase(await reviewCheckpoint(trace.dir));
      return { status: 'publication_interrupted', run_id: runId };
    }
    await settleGenericApprovalClaim('interrupted');
    const failure = classifyRunFailure(error);
    return await finish(terminalStatusForFailure(failure), { failed_phase: state.phase,
      error: providerError(error), message: failure.message, failure });
  } finally {
    try { await stop?.close(); }
    finally { try { await disposeTerminalWorkspace(); } finally { try { if (ownsControlPlane) controlPlane?.close(); } finally { await release(); } } }
  }
}
