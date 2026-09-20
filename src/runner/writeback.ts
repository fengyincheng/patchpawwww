import type { Permission } from '../control-plane/types.ts';
import type { Trace } from '../harness/trace.ts';
import { commitRepair, pushRepair, type WorkspaceState } from '../workspace/manager.ts';
import type { ScmAdapter } from '../scm/types.ts';

/**
 * Harness-owned writeback: the only path from a workspace to a changed remote branch.
 *
 * The Agent may edit and may commit, but it never pushes — a prompt asking it not to is not a
 * boundary, so the capability simply does not exist for it. Everything that turns a candidate
 * workspace into a confirmed remote head happens here: eligibility, the fork refusal, freshness,
 * the commit (reusing the Agent's own commit when there is one), the push, and the confirmation
 * that the remote head is now the commit we think it is. Callers get a typed outcome; they never
 * touch Git themselves.
 */

export type WritebackDecision =
  | { kind: 'disabled' }
  | { kind: 'allowed'; permit: WritebackPermit }
  | { kind: 'refused'; reason: string; code: 'fork_writeback_unsupported' };

const WRITEBACK_PERMIT = Symbol('patchpaw-writeback-permit');

/**
 * A capability issued by `decideWriteback`. Keeping the brand private means a caller cannot
 * accidentally reach the commit/push boundary by constructing an object that merely looks
 * allowed. The runner still performs the eligibility decision once, then passes this permit down.
 */
export interface WritebackPermit {
  readonly [WRITEBACK_PERMIT]: true;
}

const allowedWritebackPermit: WritebackPermit = { [WRITEBACK_PERMIT]: true };

/**
 * Whether this execution may write back at all.
 *
 * Capability comes from the permission alone: `read_write` may write, `read_write_approval` may
 * write only once approved, and `read_only` never may — regardless of which task is running. A
 * fork head is refused before the Agent is given write tools, because the workspace's `origin` is
 * the base repository and pushing through it would publish to the wrong place. The approved-write
 * path is judged against its Plan's own Git facts earlier, so it is not refused here.
 */
export function decideWriteback(facts: { permission?: Permission; approvedWrite: boolean; sameRepo: boolean }): WritebackDecision {
  const enabled = facts.permission === 'read_write' || facts.approvedWrite;
  if (!enabled) return { kind: 'disabled' };
  if (!facts.approvedWrite && !facts.sameRepo) {
    return { kind: 'refused', code: 'fork_writeback_unsupported',
      reason: '此 PR 来自 fork，PatchPaw 不支持向来源 fork 写回；已在 Agent 写阶段之前停止，没有修改或推送。' };
  }
  return { kind: 'allowed', permit: allowedWritebackPermit };
}

export interface WritebackRequest {
  workspace: WorkspaceState;
  trace: Trace;
  scm: ScmAdapter;
  projectId: string;
  changeRequestNumber: number;
  expectedBaseSha: string;
  sameRepo: boolean;
  /** The capability returned by `decideWriteback`; without it this boundary cannot mutate Git. */
  permit: WritebackPermit;
  /** Recorded on the commit and the push events: which task produced this candidate. */
  kind: string;
  previousHead: string;
  baseRef: string;
  headRef: string;
  headRepo: string;
  remoteUrl: string;
  credentialScopeUrl?: string;
  /** Fetched fresh per attempt; the Harness owns the credential, the Agent never sees it. */
  token: () => Promise<string>;
  /** Honour a pending human stop at each step that is about to change something. */
  guard: () => Promise<void>;
  /** Record the run's transition before the remote mutation, so a crash is recoverable. */
  beforePush: (candidateSha: string) => Promise<void>;
}

async function assertCurrentChangeRequest(request: WritebackRequest, expectedHead: string) {
  const current = await request.scm.readChangeRequest(request.projectId, request.changeRequestNumber, { allowClosed: true });
  const stateOpen = current.state === 'open' || current.state === 'opened';
  const sameTarget = current.target.sha === request.expectedBaseSha && current.target.ref === request.baseRef;
  const sameSource = current.source.sha === expectedHead && current.source.ref === request.headRef
    && current.source.pathWithNamespace.toLowerCase() === request.headRepo.toLowerCase();
  if (!stateOpen || !sameTarget || !sameSource) {
    throw new Error(`Change request head, target, source, or state changed during writeback: ${JSON.stringify({
      expected: { head: expectedHead, base: request.expectedBaseSha, base_ref: request.baseRef, head_ref: request.headRef, head_repo: request.headRepo },
      actual: { head: current.source.sha, base: current.target.sha, base_ref: current.target.ref, head_ref: current.source.ref,
        head_repo: current.source.pathWithNamespace, state: current.state },
    })}`);
  }
}

export interface WritebackOutcome {
  previousHead: string;
  /** The candidate commit produced or reused by the Harness, now confirmed on the remote head. */
  commitSha: string;
  /** Explicitly named fact for callers: this value was confirmed after the remote read-back. */
  confirmedRemoteHead: string;
}

export async function performWriteback(request: WritebackRequest): Promise<WritebackOutcome> {
  if (request.permit !== allowedWritebackPermit) throw new Error('Writeback requires a permit issued by decideWriteback');
  const { workspace, trace, previousHead } = request;
  await request.guard();
  // Freshness before anything is committed: the candidate is only meaningful against the PR facts
  // the workspace was built from.
  await assertCurrentChangeRequest(request, previousHead);
  await request.guard();
  // Last mechanical defense before the real Git mutation: the workspace `origin` is the base
  // repository, so a fork head must never be pushed through it even if an earlier guard was
  // bypassed by a future call path.
  if (!request.sameRepo) throw new Error('Refusing to push a fork change request through the base repository origin');

  const commitSha = await commitRepair(workspace, request.kind, trace, previousHead);
  // Persist the candidate before push; passive synchronize never starts another task. The second
  // freshness check below deliberately remains after this durable claim: a crash in this window
  // can recover the candidate identity without replaying the Agent or manufacturing another
  // commit, while a drift still fails closed before remote mutation.
  await request.beforePush(commitSha);
  await request.guard();
  await assertCurrentChangeRequest(request, previousHead);
  await pushRepair(workspace, request.headRef, await request.token(), trace, request.remoteUrl, request.credentialScopeUrl);
  trace.emit('repair_push', { kind: request.kind, sha: commitSha, branch: request.headRef });
  // Confirmation reads the remote back: a push whose acknowledgement was lost is not a push we
  // can claim, and the next reader of `state.current_head_sha` must be able to trust it.
  await assertCurrentChangeRequest(request, commitSha);
  trace.emit('repair_push_confirmed', { sha: commitSha, previous_head: previousHead });
  workspace.mergePending = false; workspace.unmerged = [];
  return { previousHead, commitSha, confirmedRemoteHead: commitSha };
}
