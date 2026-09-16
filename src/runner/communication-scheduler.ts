import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createGitHub, type GitHubReader } from '../github/client.ts';
import { runNoticeBody } from './run-notice.ts';
import { loadCommandSnapshot } from '../control-plane/index.ts';
import { Trace } from '../harness/trace.ts';
import { disposeWorkspacePath, isManagedWorktree } from '../workspace/repo-store.ts';
import { claimRun, readState, statePath, workerStatus, writeState } from './state.ts';
import { closeCompleteBodyFor, closeStartBodyFor, resumePendingClose } from './close.ts';
import { closeoutMarker } from './closeout-publication.ts';
import { retryAfterMs } from '../harness/retry.ts';
import { drainDueDeliveries, enqueueCommentDelivery, enqueueReviewDelivery, OUTBOUND_LOCK_BUSY_RETRY_MS, safeError, type OutboundConnection, type OutboundItem, type StoredItem } from './outbound.ts';
import { verifyInboundNow } from './inbound-verification.ts';
import { communicationWakePath, createCommunicationWakeServer, registerCommunicationWake, type CommunicationWakeServer } from './communication-wake.ts';
import { closeCommunicationStore, openCommunicationStore, type CommunicationStore } from './communication-store.ts';
import type { InboundRecord } from './communication-types.ts';
import { patchpawPaths } from '../config/paths.ts';
import { readConflictProposal, readCurrentConflictProposal, reconcileConflictProposalPublication } from './conflict-proposals.ts';
import { readConflictApproval, updateConflictApproval } from './conflict-approval.ts';
import { readPaused, savePaused } from './resume.ts';
import { workspaceEvidenceSha256, type ConflictWorkspaceEvidence } from './workspace-evidence.ts';
import { withRuntimeLock } from '../migration/runtime-lock.ts';
import type { ScmInboundReader } from '../scm/types.ts';

export interface SchedulerConfig {
  root: string;
  legacyHome?: string;
  appId: number;
  privateKey: string;
  operatorLogin?: string;
  snapshotRoot: string;
  appSlug?: string;
  botLogin?: string;
  wakeTransport?: 'unix' | 'pipe' | 'memory';
  wakeSocketPath?: string;
  /** Test/embedding seam; production leaves runtime wake failures fatal. */
  onWakeFailure?: (error: Error) => void;
  schedulerHooks?: {
    afterDeadlineRead?: (deadline: string | undefined) => Promise<void> | void;
  };
  /** Platform-specific inbound verification, used by GitLab records while GitHub keeps its legacy reader. */
  inboundScmReader?: ScmInboundReader | ((connectionId: string) => ScmInboundReader | undefined);
  /** Platform-aware outbox connection resolver. GitHub remains the default resolver. */
  connectionFor?: (item: OutboundItem) => Promise<OutboundConnection>;
}

export interface CommunicationSchedulerService {
  ready: Promise<void>;
  stop(): void;
}

export type OutboundSchedulerService = CommunicationSchedulerService;

const json = async (path: string) => {
  try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};

function runDir(root: string, runId: string) { return join(patchpawPaths(root).runs, runId); }

async function validateConflictRepairFinalization(config: SchedulerConfig, path: string, repo: string, number: number,
  item: OutboundItem, approval: Awaited<ReturnType<typeof readConflictApproval>>, sourceRun: string, requireWorkspace: boolean, expectedWorkspacePath?: string) {
  if (!approval) throw new Error('Conflict repair approval is missing');
  const proposal = await readConflictProposal(path, approval.proposal_revision);
  if (!proposal || proposal.proposal_id !== approval.proposal_id || proposal.proposal_hash !== approval.proposal_hash
      || proposal.basis.pr_head_sha !== approval.pr_head_sha || proposal.basis.pr_head_ref !== approval.pr_head_ref
      || proposal.basis.pr_head_repo !== approval.pr_head_repo || proposal.basis.base_ref !== approval.base_ref
      || proposal.basis.current_base_tip_sha !== approval.current_base_tip_sha
      || proposal.basis.command_snapshot_id !== approval.command_snapshot_id
      || proposal.basis.command_snapshot_sha256 !== approval.command_snapshot_sha256) {
    throw new Error('Conflict repair proposal binding is invalid');
  }
  const snapshotRun = proposal.repair_run_id;
  const snapshot = await loadCommandSnapshot(config.root, snapshotRun, { allowLegacy: true });
  if (snapshot.snapshot.snapshot_id !== approval.command_snapshot_id || snapshot.snapshotSha256 !== approval.command_snapshot_sha256
      || snapshot.snapshot.execution_id !== approval.repair_execution_id || snapshot.snapshot.template_type !== 'conflict'
      || snapshot.snapshot.target !== 'command' || snapshot.snapshot.command?.permission !== 'read_write'
      || snapshot.snapshot.command?.enabled !== true) {
    throw new Error('Conflict repair command snapshot is invalid');
  }
  const original = await json(join(patchpawPaths(config.root).runs, snapshotRun, 'workspace-evidence.json')) as (ConflictWorkspaceEvidence & { evidence_sha256?: string }) | null;
  const originalHash = original?.evidence_sha256;
  if (!original || !originalHash) throw new Error('Conflict repair original workspace evidence is invalid');
  const { evidence_sha256: _originalHash, ...originalEvidence } = original;
  if (originalHash !== workspaceEvidenceSha256(originalEvidence)
      || originalHash !== proposal.basis.workspace_evidence_sha256
      || originalEvidence.repository !== repo || originalEvidence.pr_number !== number
      || originalEvidence.pr_head_sha !== approval.pr_head_sha || originalEvidence.initial_head !== approval.pr_head_sha
      || originalEvidence.current_base_tip_sha !== approval.current_base_tip_sha || originalEvidence.base_ref !== approval.base_ref
      || originalEvidence.command_snapshot_id !== approval.command_snapshot_id
      || originalEvidence.command_snapshot_sha256 !== approval.command_snapshot_sha256) {
    throw new Error('Conflict repair original workspace evidence is invalid');
  }
  const commitRun = approval.repair_run_id ?? sourceRun;
  const commit = await json(join(patchpawPaths(config.root).runs, commitRun, 'conflict-repair-commit-evidence.json')) as (ConflictWorkspaceEvidence & { evidence_sha256?: string }) | null;
  const finalHead = approval.commit_sha ?? String(item.source.commit_sha ?? '');
  const commitHash = commit?.evidence_sha256;
  const commitEvidence = commit ? (({ evidence_sha256: _commitHash, ...rest }) => rest as ConflictWorkspaceEvidence)(commit) : null;
  if (!finalHead || approval.remote_head_sha !== finalHead || item.source.commit_sha !== undefined && String(item.source.commit_sha) !== finalHead
      || !commit || !commitHash || !commitEvidence || commitHash !== workspaceEvidenceSha256(commitEvidence)
      || commitEvidence.workspace_head !== finalHead || commitEvidence.repository !== repo || commitEvidence.pr_number !== number
      || commitEvidence.pr_head_sha !== approval.pr_head_sha || commitEvidence.initial_head !== approval.pr_head_sha
      || commitEvidence.historical_base_sha !== originalEvidence.historical_base_sha
      || commitEvidence.current_base_tip_sha !== approval.current_base_tip_sha || commitEvidence.base_ref !== approval.base_ref
      || commitEvidence.command_snapshot_id !== approval.command_snapshot_id || commitEvidence.command_snapshot_sha256 !== approval.command_snapshot_sha256) {
    throw new Error('Conflict repair commit evidence is invalid');
  }
  const paused = await readPaused(path);
  if (requireWorkspace) {
    const workspaceOwnerMatches = paused?.run_id === sourceRun || paused?.run_id === proposal.repair_run_id;
    // A recovery may have a newer claim worker while the durable outbox still belongs to the
    // original repair run. Either binding is valid only alongside the exact proposal workspace
    // path and evidence facts checked below.
    const approvalOwnerMatches = approval.claim_run_id === sourceRun || approval.repair_run_id === sourceRun;
    if (!paused?.workspace.path || expectedWorkspacePath && paused.workspace.path !== expectedWorkspacePath
        || !approvalOwnerMatches || !workspaceOwnerMatches || paused.task !== 'conflict'
        || paused.base_ref !== approval.base_ref || paused.workspace.initialHead !== approval.pr_head_sha
        || paused.workspace.mainSha !== approval.current_base_tip_sha || basename(paused.workspace.path) !== proposal.repair_run_id) {
      throw new Error('Conflict repair retained workspace is missing or misbound');
    }
  }
  if (paused?.workspace.path) {
    const exists = await stat(paused.workspace.path).then(() => true, () => false);
    if (exists && !await isManagedWorktree(config.root, repo, paused.workspace.path, undefined, new Trace(runDir(config.root, sourceRun)))) {
      throw new Error('Conflict repair retained workspace is not managed by PatchPaw');
    }
  }
  return { proposal, paused, finalHead };
}

async function legacyStatePaths(root: string) {
  const stateRoot = patchpawPaths(root).state;
  let repoKeys: string[];
  try { repoKeys = await readdir(stateRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const paths: string[] = [];
  for (const repoKey of repoKeys) {
    let names: string[];
    try { names = await readdir(join(stateRoot, repoKey)); } catch { continue; }
    for (const name of names.filter(value => /^pr-\d+\.json$/.test(value))) paths.push(join(stateRoot, repoKey, name));
  }
  return paths;
}

/** One migration pass for pre-outbox state artifacts. State JSON is authoritative for repo/PR. */
export async function reconcileLegacyOutbox(config: SchedulerConfig, botLogin?: string) {
  const runsRoot = patchpawPaths(config.root).runs;
  let runs: string[];
  try { runs = await readdir(runsRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') runs = []; else throw error; }
  for (const runId of runs) {
    const dir = runDir(config.root, runId);
    const manifest = await json(join(dir, 'manifest.json'));
    if (!manifest?.repo || !Number.isSafeInteger(manifest.pr_number)) continue;
    const state = await readState(statePath(patchpawPaths(config.root).state, manifest.repo, manifest.pr_number));
    const review = await json(join(dir, 'review.json'));
    const publication = await json(join(dir, 'review-publication.json'));
    if (review && !publication && ['review_ready', 'review_publishing'].includes(state?.phase ?? 'review_ready')) {
      const { head_sha, ...reviewResult } = review;
      const mentions = [manifest.request_author, config.operatorLogin ?? String(manifest.repo).split('/')[0]].filter((value): value is string => !!value);
      await enqueueReviewDelivery({ root: config.root, repo: manifest.repo, prNumber: manifest.pr_number,
        semanticKey: `review:${runId}:${head_sha}`, headSha: head_sha, review: reviewResult as any, mentions, botLogin,
        runId, allowLegacy: true, source: { run_id: runId, head_sha, recovered: 1 } });
    }
    const notice = await json(join(dir, 'run-notice.json'));
    const notification = await json(join(dir, 'notification.json'));
    if (notice && notification?.status !== 'published') {
      await enqueueCommentDelivery({ root: config.root, repo: manifest.repo, prNumber: manifest.pr_number, purpose: 'run_notice',
        semanticKey: `run-notice:${notice.run_id}`, body: runNoticeBody(notice as any), mentions: notice.mentions ?? [],
        botLogin: notice.bot_login ?? botLogin,
        legacyMarkers: ['budget_exhausted', 'stopped'].includes(notice.status) ? [closeoutMarker(notice.run_id)] : undefined,
        source: { run_id: notice.run_id, status: notice.status } });
    }
  }

  for (const path of await legacyStatePaths(config.root)) {
    const state = await readState(path);
    if (!state?.repo || !state.pr_number) continue;
    const mentions = state.close_mentions ?? [state.repo.split('/')[0]];
    if (state.completion_notice_status === 'pending' && state.closed_through_comment_id) {
      await enqueueCommentDelivery({ root: config.root, repo: state.repo, prNumber: state.pr_number, purpose: 'close_completion',
        semanticKey: `close-completion:${state.close_comment_id ?? state.closed_through_comment_id}`, body: closeCompleteBodyFor(state.repo), mentions,
        botLogin, source: { close_comment_id: state.close_comment_id ?? state.closed_through_comment_id } });
    }
    if (state.pending_close_refusal) {
      await enqueueCommentDelivery({ root: config.root, repo: state.repo, prNumber: state.pr_number, purpose: 'close_refusal',
        semanticKey: `close-refusal:${state.pending_close_refusal.comment_id}`,
        body: '当前任务仍在运行，请先 /stop，再执行 /close。',
        mentions: [state.pending_close_refusal.author ?? state.repo.split('/')[0]], botLogin,
        source: { comment_id: state.pending_close_refusal.comment_id } });
    }
    const journal = await json(`${path}.close.json`);
    if (journal?.status === 'closing' && !journal.start_notice_id) {
      await enqueueCommentDelivery({ root: config.root, repo: state.repo, prNumber: state.pr_number, purpose: 'close_start',
        semanticKey: `close-start:${journal.close_comment_id}`, body: closeStartBodyFor(state.repo), mentions: journal.mentions ?? [], botLogin,
        source: { close_comment_id: journal.close_comment_id } });
    }
  }
}

class FinalizationBusy extends Error {
  retryAfter = OUTBOUND_LOCK_BUSY_RETRY_MS / 1000;
  constructor() { super('PR lifecycle is owned by an active worker'); this.name = 'FinalizationBusy'; }
}

type FinalizationConnection = OutboundConnection | (() => Promise<OutboundConnection>);

async function finalizeDelayedDeliveryOwned(config: SchedulerConfig, stored: StoredItem, store: CommunicationStore,
  connection?: OutboundConnection | (() => Promise<OutboundConnection>)) {
  const item = stored.item;
  const done = async () => (await store.markFinalized(item.delivery_id))?.item;
  const resolveConnection = async () => typeof connection === 'function' ? connection() : connection;
  if (item.kind === 'review' && item.status === 'cancelled_stale') {
    const sourceRun = typeof item.source.run_id === 'string' ? item.source.run_id : undefined;
    if (!sourceRun) return done();
    const dir = runDir(config.root, sourceRun);
    const review = await json(join(dir, 'review.json'));
    if (!review || await json(join(dir, 'review-stale.json'))) return done();
    let actualHead = '';
    let prState = 'unknown';
    try {
      const resolved = await resolveConnection();
      if (!resolved) throw new Error('SCM connection required for stale Review finalization');
      if (resolved.adapter) {
        const projectId = typeof item.source.project_id === 'string' || typeof item.source.project_id === 'number'
          ? String(item.source.project_id) : item.repo.match(/^gitlab:(.+):project:(.+)$/)?.[2];
        if (!projectId) throw new Error('GitLab stale Review is missing its project id');
        const changeRequest = await resolved.adapter.readChangeRequest(projectId, item.pr_number, { allowClosed: true });
        actualHead = changeRequest.source.sha; prState = changeRequest.state;
      } else {
        if (!resolved.client) throw new Error('GitHub client required for stale Review finalization');
        const [owner, repo] = item.repo.split('/');
        const { data } = await resolved.client.rest.pulls.get({ owner, repo, pull_number: item.pr_number });
        actualHead = data.head.sha; prState = data.state;
      }
    } catch { /* cancellation remains durable if the read is unavailable */ }
    const trace = new Trace(dir);
    trace.save('review-stale.json', { expected_head: String(item.source.head_sha ?? ''), actual_head: actualHead, pr_state: prState });
    const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
    const state = await readState(path);
    if (state?.run_id === sourceRun) {
      trace.save('result.json', { status: 'review_stale', run_id: sourceRun, repo: item.repo, pr_number: item.pr_number,
        final_head_sha: String(item.source.head_sha ?? ''), recovered: true, expected_head: String(item.source.head_sha ?? ''), actual_head: actualHead, pr_state: prState });
      await writeState(path, { ...state, active: false, waiting_for_ci: false, phase: 'review_stale' });
    }
    return done();
  }
  if (item.status !== 'delivered') return done();
  const sourceRun = typeof item.source.run_id === 'string' ? item.source.run_id : undefined;
  if (item.kind === 'review' && sourceRun) {
    const dir = runDir(config.root, sourceRun);
    const review = await json(join(dir, 'review.json'));
    if (!review || await json(join(dir, 'review-publication.json'))) return done();
    const publication = { ...(item.receipt ?? {}), run_id: sourceRun, kind: 'review', recovered: item.source.recovered === 1, reused: item.receipt?.reused ?? false };
    const trace = new Trace(dir); trace.save('review-publication.json', publication);
    const manifest = await json(join(dir, 'manifest.json'));
    const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
    const state = await readState(path);
    if (state?.run_id === sourceRun) {
      const existing = await json(join(dir, 'result.json'));
      if (!existing || existing.status !== 'review_completed') trace.save('result.json', { status: 'review_completed', run_id: sourceRun, repo: item.repo,
        pr_number: item.pr_number, final_head_sha: review.head_sha, recovered: item.source.recovered === 1, review, publication });
      await writeState(path, { ...state, active: false, waiting_for_ci: false, phase: 'review_completed', current_head_sha: review.head_sha });
      if (typeof manifest?.workspace_path === 'string') {
        try { await disposeWorkspacePath(config.root, item.repo, manifest.workspace_path, trace); } catch { /* next lifecycle can retry cleanup */ }
      }
      trace.emit('review_delayed_delivery_finalized', { delivery_id: item.delivery_id, run_id: sourceRun });
    } else if (manifest) trace.emit('review_delayed_delivery_preserved', { delivery_id: item.delivery_id, run_id: sourceRun, current_run_id: state?.run_id });
    return done();
  }
  if (sourceRun && item.purpose === 'run_notice') {
    const dir = runDir(config.root, sourceRun);
    if (!await json(join(dir, 'manifest.json')) && !await json(join(dir, 'run-notice.json'))) return done();
    const trace = new Trace(dir); trace.save('notification.json', { status: 'published', ...(item.receipt ?? {}), delivery_id: item.delivery_id });
    trace.emit('run_notice_delayed_delivery_finalized', { delivery_id: item.delivery_id });
    return done();
  }
  if (item.purpose === 'conflict_proposal') {
    const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
    // The scheduler already owns the communication-store connection; the reconciler updates
    // the PR projection here and lets `done()` finalize the same delivery on that connection.
    await reconcileConflictProposalPublication(config.root, path, item.repo, item.pr_number, false);
    return done();
  }
  if (item.purpose === 'conflict_repair') {
    const sourceRun = typeof item.source.run_id === 'string' ? item.source.run_id : undefined;
    const approvalId = typeof item.source.approval_id === 'string' ? item.source.approval_id : undefined;
    if (!sourceRun || !approvalId) return done();
    const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
    const approval = await readConflictApproval(path, approvalId);
    const state = await readState(path);
    if (!approval || approval.status !== 'accepted') return done();
    if (approval.phase === 'completed') {
      const validated = await validateConflictRepairFinalization(config, path, item.repo, item.pr_number, item, approval, sourceRun, false);
      if (validated.paused?.run_id === sourceRun && validated.paused.task === 'conflict'
          && basename(validated.paused.workspace.path) === validated.proposal.repair_run_id && validated.paused.workspace.path) {
        await disposeWorkspacePath(config.root, item.repo, validated.paused.workspace.path, new Trace(runDir(config.root, sourceRun)));
      }
      return done();
    }
    if (!['remote_confirmed', 'publication_pending'].includes(approval.phase)) return done();
    if (!state || state.run_id !== sourceRun) {
      // A newer PR generation may have replaced the state projection after the old report
      // was already delivered. The immutable approval record and receipt are sufficient to
      // retire that old lifecycle; never block the PR's ordered outbox on a stale run id.
      const validated = await validateConflictRepairFinalization(config, path, item.repo, item.pr_number, item, approval, sourceRun, false);
      if (validated.paused?.run_id === sourceRun && validated.paused.task === 'conflict'
          && basename(validated.paused.workspace.path) === validated.proposal.repair_run_id && validated.paused.workspace.path) {
        await disposeWorkspacePath(config.root, item.repo, validated.paused.workspace.path, new Trace(runDir(config.root, sourceRun)));
      }
      // A recovery worker owns a newer state run while the durable delivery remains bound to
      // the original repair run. If that worker dies after the report is delivered but before
      // its local finish() writes state, converge that exact claim owner as well. A genuinely
      // newer generation has a different run_id and is left untouched.
      if (state && state.run_id !== sourceRun && state.run_id === approval.claim_run_id && state.phase !== 'closed' && !state.closed_at) {
        const recoveryDir = runDir(config.root, state.run_id);
        const recoveryDelivery = await json(join(recoveryDir, 'delivery.json'));
        const recoveryResult = await json(join(recoveryDir, 'result.json'));
        const answer = typeof recoveryDelivery?.body === 'string' ? recoveryDelivery.body : (item.payload as { body?: string }).body;
        const publication = { ...(item.receipt ?? {}), delivery_id: item.delivery_id, recovered: true };
        const result = { ...(recoveryResult ?? {}), status: 'repair_completed', run_id: state.run_id,
          repo: item.repo, pr_number: item.pr_number, final_head_sha: validated.finalHead, recovered: true,
          ...(answer ? { answer } : {}), publication };
        const trace = new Trace(recoveryDir);
        trace.save('result.json', result);
        trace.emit('conflict_repair_recovery_state_finalized', { delivery_id: item.delivery_id, run_id: state.run_id, approval_id: approvalId });
        await writeState(path, { ...state, active: false, waiting_for_ci: false, current_head_sha: validated.finalHead, phase: 'repair_completed' });
      }
      await updateConflictApproval(path, approvalId, { phase: 'completed', final_publication_delivery_id: item.delivery_id,
        final_publication_remote_id: item.receipt?.id, final_published_at: item.receipt?.published_at ?? new Date().toISOString() });
      return done();
    }
    const dir = runDir(config.root, sourceRun);
    const current = await readCurrentConflictProposal(path);
    if (!current || current.proposal.status !== 'published' || current.proposal.proposal_id !== approval.proposal_id
        || current.proposal.proposal_revision !== approval.proposal_revision || current.proposal.proposal_hash !== approval.proposal_hash) {
      throw new Error('Conflict repair current proposal is missing or stale');
    }
    const validated = await validateConflictRepairFinalization(config, path, item.repo, item.pr_number, item, approval, sourceRun, true, current.pointer.workspace_path);
    const delivery = await json(join(dir, 'delivery.json'));
    const publication = await json(join(dir, 'conflict-repair-publication.json')) ?? { ...item.receipt, delivery_id: item.delivery_id };
    const finalHead = validated.finalHead || state.current_head_sha;
    if (!finalHead) throw new Error('Conflict repair final head is missing');
    const existing = await json(join(dir, 'result.json'));
    const answer = typeof delivery?.body === 'string' ? delivery.body : (item.payload as { body?: string }).body;
    const result = { ...(existing ?? {}), status: 'repair_completed', run_id: sourceRun, repo: item.repo,
      pr_number: item.pr_number, final_head_sha: finalHead, recovered: true, ...(answer ? { answer } : {}), publication };
    // Finalize the local lifecycle before marking the communication row finalized. If this
    // process dies after the state write, the still-pending lifecycle row retries this same
    // mechanical transition; if it dies before it, the row remains due for recovery.
    await writeState(path, { ...state, active: false, waiting_for_ci: false, current_head_sha: finalHead, phase: 'repair_completed' });
    const paused = validated.paused;
    if (paused?.workspace.path) await savePaused(path, { ...paused, status: 'completed' });
    const trace = new Trace(dir);
    trace.save('result.json', result);
    trace.emit('conflict_repair_delayed_delivery_finalized', { delivery_id: item.delivery_id, run_id: sourceRun, approval_id: approvalId });
    if (paused?.workspace.path) {
      await disposeWorkspacePath(config.root, item.repo, paused.workspace.path, trace);
    }
    await updateConflictApproval(path, approvalId, { phase: 'completed', final_publication_delivery_id: item.delivery_id,
      final_publication_remote_id: item.receipt?.id, final_published_at: item.receipt?.published_at ?? new Date().toISOString() });
    return done();
  }
  if (item.purpose === 'close_refusal' && item.source.comment_id !== undefined) {
    const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
    const state = await readState(path);
    if (state?.pending_close_refusal?.comment_id === Number(item.source.comment_id)) await writeState(path, { ...state, pending_close_refusal: undefined });
    return done();
  }
  if (item.purpose === 'close_completion') {
    const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
    const state = await readState(path);
    const closeCommentId = Number(item.source.close_comment_id);
    const ownsClose = state?.close_comment_id !== undefined ? state.close_comment_id === closeCommentId : state?.closed_through_comment_id === closeCommentId;
    if (state?.completion_notice_status === 'pending' && ownsClose) await writeState(path, { ...state, completion_notice_status: 'published', completion_notice_id: item.receipt?.id });
    return done();
  }
  if (item.purpose === 'close_start') {
    const path = statePath(patchpawPaths(config.root).state, item.repo, item.pr_number);
    const journal = await json(`${path}.close.json`);
    if (journal?.status === 'closing') {
      const resolved = await resolveConnection();
      if (!resolved) throw new Error('SCM connection required for close finalization');
      await resumePendingClose(config, item.repo, item.pr_number, path, resolved, resolved.botLogin);
    }
  }
  return done();
}

export async function finalizeDelayedDelivery(config: SchedulerConfig, stored: StoredItem, connection?: FinalizationConnection) {
  const store = await openCommunicationStore(config.root, config.legacyHome);
  const path = statePath(patchpawPaths(config.root).state, stored.item.repo, stored.item.pr_number);
  if (workerStatus(await readState(path)) === 'running') { await closeCommunicationStore(store); throw new FinalizationBusy(); }
  const release = await claimRun(path);
  if (!release) { await closeCommunicationStore(store); throw new FinalizationBusy(); }
  try {
    const result = await finalizeDelayedDeliveryOwned(config, stored, store, connection);
    if (!result) throw new FinalizationBusy();
    return result;
  } finally { await release(); await closeCommunicationStore(store); }
}

function configuredBotLogin(config: SchedulerConfig) { return config.botLogin ?? (config.appSlug ? `${config.appSlug}[bot]` : undefined); }
type GitHubRuntime = ReturnType<typeof createGitHub> & GitHubReader;

export function startCommunicationScheduler(config: SchedulerConfig, githubOverride?: GitHubRuntime | GitHubReader,
  onVerified: (reply: InboundRecord['reply']) => Promise<void> = async () => {}): CommunicationSchedulerService {
  const github = (githubOverride ?? (config.appId && config.privateKey ? createGitHub(config) : undefined)) as GitHubRuntime | undefined;
  let store: CommunicationStore | undefined;
  let stopped = false;
  let running = false;
  let dirty = false;
  let reconciled = false;
  let timer: NodeJS.Timeout | undefined;
  let wakeReady = config.wakeTransport === 'memory';
  let wakeListening = false;
  let wakeServer: CommunicationWakeServer | undefined;
  let unregisterWake: (() => void) | undefined;
  let activePump: Promise<void> | undefined;
  let botLogin = configuredBotLogin(config);
  let wakeFailure: Error | undefined;

  const appLogin = async () => {
    if (botLogin) return botLogin;
    if (!github) throw new Error('GitHub App bot identity is unavailable');
    const { data } = await github.app.rest.apps.getAuthenticated();
    if (!data?.slug) throw new Error('GitHub App has no bot identity');
    botLogin = `${data.slug}[bot]`;
    return botLogin;
  };
  const connectionFor = async (item: OutboundItem): Promise<OutboundConnection> => {
    if (config.connectionFor) return config.connectionFor(item);
    if (!github) throw new Error('No SCM connection is configured for this delivery');
    const [owner, repo] = item.repo.split('/');
    const { data: installation } = await github.app.rest.apps.getRepoInstallation({ owner, repo });
    return { client: github.installation(installation.id), botLogin: await appLogin() };
  };

  const processInbound = async () => {
    if (!store || (!github?.readPullRequest && !config.inboundScmReader)) return;
    for (const stored of await store.listDueInbound(new Date().toISOString(), 25)) await verifyInboundNow(config.root, stored, github, onVerified, config.inboundScmReader);
  };

  const processFinalizations = async () => {
    if (!store) return;
    for (const stored of await store.listDueFinalizations(new Date().toISOString(), 25)) {
      const needsConnection = (stored.item.kind === 'review' && stored.item.status === 'cancelled_stale') || stored.item.purpose === 'close_start';
      try {
        await finalizeDelayedDelivery(config, stored, needsConnection ? () => connectionFor(stored.item) : undefined);
      } catch (error) {
        const fallback = Math.min(60 * 60_000, 15_000 * 2 ** Math.min(stored.item.finalization_attempt_count, 7));
        const delay = error instanceof FinalizationBusy ? OUTBOUND_LOCK_BUSY_RETRY_MS : retryAfterMs(error) ?? fallback;
        await store.deferFinalization(stored.item.delivery_id, safeError(error), new Date(Date.now() + delay).toISOString());
      }
    }
  };

  const armDeadline = async () => {
    if (stopped || !store) return;
    const deadline = await store.nextCommunicationDeadline();
    await config.schedulerHooks?.afterDeadlineRead?.(deadline);
    // nextCommunicationDeadline() yielded to the event loop. A producer may
    // have enqueued and nudged during that await. Never arm a stale deadline;
    // the pump's finally block will immediately run the remembered dirty pass.
    if (dirty || stopped) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!deadline) return;
    timer = setTimeout(() => { timer = undefined; requestPump(); }, Math.max(0, Date.parse(deadline) - Date.now()));
    timer.unref();
  };

  const pump = async () => {
    if (stopped || running || !wakeReady || !store) return;
    running = true;
    try {
      await withRuntimeLock(config.root, 'shared', false, async () => {
        do {
          dirty = false;
          if (!reconciled) {
            if (!(await store!.getMeta('legacy_reconciliation_v1'))) {
              await reconcileLegacyOutbox(config, botLogin);
              await store!.setMeta('legacy_reconciliation_v1', new Date().toISOString());
            }
            reconciled = true;
          }
          await store!.recoverExpiredSending(new Date().toISOString());
          await processInbound();
          await drainDueDeliveries(config.root, item => connectionFor(item), 25);
          await processFinalizations();
        } while (dirty || await store!.hasDueCommunication(new Date().toISOString()));
        await armDeadline();
      });
    } catch (error) {
      console.error(JSON.stringify({ status: 'communication_pump_failed', error_name: (error as Error).name,
        error_code: (error as { code?: string }).code ?? null,
        http_status: (error as { status?: number }).status ?? null }));
      try { await armDeadline(); } catch { /* durable wake or restart can retry */ }
    } finally {
      running = false;
      if (dirty && !stopped) requestPump();
    }
  };

  function requestPump() {
    dirty = true;
    if (!running && wakeReady && !stopped) {
      const current = pump();
      activePump = current;
      void current.finally(() => { if (activePump === current) activePump = undefined; });
    }
  }

  const failWakeRuntime = (raw: unknown) => {
    if (stopped || wakeFailure) return;
    const error = raw instanceof Error ? raw : new Error(String(raw));
    wakeFailure = error;
    wakeReady = false;
    wakeListening = false;
    unregisterWake?.();
    unregisterWake = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    console.error(JSON.stringify({ status: 'communication_wake_runtime_failed', error_name: error.name,
      error_code: (error as NodeJS.ErrnoException).code ?? null }));
    if (config.onWakeFailure) {
      config.onWakeFailure(error);
      return;
    }
    // The HTTP process must not stay healthy while its only wake capability
    // is gone. PM2/systemd owns the restart after this uncaught failure.
    process.nextTick(() => { throw error; });
  };

  const initialize = (async () => {
    store = await openCommunicationStore(config.root, config.legacyHome);
    if (config.wakeTransport !== 'memory') {
      wakeServer = createCommunicationWakeServer(config.root, requestPump, config.wakeTransport, config.wakeSocketPath);
      wakeServer.server.on('error', error => {
        if (wakeListening) failWakeRuntime(error);
      });
      wakeServer.server.on('close', () => {
        if (wakeListening && !stopped) failWakeRuntime(new Error('Communication wake socket closed unexpectedly'));
      });
      await wakeServer.listen();
      wakeListening = true;
    }
    wakeReady = true;
    unregisterWake = registerCommunicationWake(config.root, requestPump);
    const initialPump = pump();
    activePump = initialPump;
    try { await initialPump; }
    finally { if (activePump === initialPump) activePump = undefined; }
  })();

  void initialize.catch(async error => {
    wakeReady = false;
    console.error(JSON.stringify({ status: 'communication_wake_startup_failed', error_name: (error as Error).name,
      code: (error as NodeJS.ErrnoException).code ?? null }));
    await wakeServer?.close().catch(() => {});
    if (store) await closeCommunicationStore(store).catch(() => {});
  });

  return {
    ready: initialize,
    stop() {
      stopped = true; wakeReady = false; unregisterWake?.(); unregisterWake = undefined;
      if (timer) clearTimeout(timer); timer = undefined;
      void wakeServer?.close().catch(() => {});
      void (async () => {
        try { await activePump; } catch { /* the pump already logged its safe failure facts */ }
        await store?.close();
      })();
    },
  };
}

export function startOutboundScheduler(config: SchedulerConfig, legacyIntervalOrGithub?: number | GitHubRuntime,
  githubOverride?: GitHubRuntime): OutboundSchedulerService {
  const github = typeof legacyIntervalOrGithub === 'number' ? githubOverride : legacyIntervalOrGithub;
  return startCommunicationScheduler(config, github);
}
