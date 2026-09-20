import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { sha256Canonical } from '../control-plane/snapshots.ts';
import { validateRepoRelativePath } from '../workspace/repo-store.ts';
import type { RunState } from './state.ts';
import { readState, writeState } from './state.ts';
import { readPaused, savePaused } from './resume.ts';
import type { OutboundItem } from './communication-types.ts';
import { cancelOutboundDelivery, listOutbound, finalizeDelivery } from './outbound.ts';
import { Trace } from '../harness/trace.ts';
import { patchpawPaths } from '../config/paths.ts';
import { atomicJson, immutableJson, readJson } from './durable-json.ts';
import { applyRunPhase } from './phases.ts';

export const CONFLICT_PROPOSAL_SCHEMA_VERSION = 'patchpaw.conflict-proposal.v1';
export const CONFLICT_PROPOSAL_CURRENT_SCHEMA_VERSION = 'patchpaw.conflict-proposal-current.v1';
// Stage 07 enables the mechanical approval gate. The gate itself never decides whether a
// proposal is semantically correct; it only verifies the durable proposal, actor, Git facts,
// snapshot and configured permission before handing the retained workspace to the Repair task.
export const CONFLICT_APPROVAL_ENABLED = true;

const text = (max: number) => z.string().trim().min(1).max(max);

export const conflictProposalDraftSchema = z.object({
  summary: text(12_000),
  pr_intent: text(12_000),
  current_base_intent: text(12_000),
  conflicts: z.array(z.object({
    path: text(1_024),
    issue: text(12_000),
    pr_side: text(12_000),
    base_side: text(12_000),
    proposed_resolution: text(12_000),
    disagreement_or_tradeoff: text(12_000),
  })).min(1).max(200),
  affected_files: z.array(text(1_024)).min(1).max(500),
  verification_plan: z.array(text(4_000)).min(1).max(100),
  risks_or_open_questions: z.array(text(12_000)).max(100),
  human_markdown_summary: text(20_000),
});

export type ConflictProposalDraft = z.infer<typeof conflictProposalDraftSchema>;

export interface ConflictProposalBasis {
  pr_head_sha: string;
  /** Added by Stage 07; absent legacy v1 proposals remain readable but cannot be approved. */
  pr_head_ref?: string;
  pr_head_repo?: string;
  current_base_tip_sha: string;
  base_ref: string;
  workspace_evidence_sha256: string;
  command_snapshot_id: string;
  command_snapshot_sha256: string;
}

export interface ConflictProposal {
  schema_version: typeof CONFLICT_PROPOSAL_SCHEMA_VERSION;
  proposal_id: string;
  proposal_revision: number;
  execution_id: string;
  /** The approval/repair execution identity; discussion executions never replace it. */
  repair_execution_id: string;
  /** The run directory containing the original repair snapshot/evidence. */
  repair_run_id: string;
  run_id: string;
  summary: string;
  pr_intent: string;
  current_base_intent: string;
  conflicts: ConflictProposalDraft['conflicts'];
  affected_files: string[];
  verification_plan: string[];
  risks_or_open_questions: string[];
  human_markdown_summary: string;
  basis: ConflictProposalBasis;
  /** A read-only conversation execution/snapshot that produced a revision, when applicable. */
  discussion_execution_id?: string;
  discussion_snapshot_id?: string;
  discussion_snapshot_sha256?: string;
  proposal_hash: string;
  /** Status is kept in a sidecar/current pointer so the version payload remains immutable. */
  status: ConflictProposalStatus;
  created_at: string;
  publication?: ConflictProposalPublication;
}

export type ConflictProposalStatus = 'draft' | 'publication_pending' | 'published' | 'superseded' | 'stale';

export interface ConflictProposalPublication {
  delivery_id: string;
  remote_id?: number;
  remote_url?: string;
  published_at?: string;
}

export interface ConflictProposalPointer {
  schema_version: typeof CONFLICT_PROPOSAL_CURRENT_SCHEMA_VERSION;
  proposal_id: string;
  proposal_revision: number;
  proposal_hash: string;
  status: ConflictProposalStatus;
  proposal_path: string;
  run_id: string;
  execution_id: string;
  workspace_path: string;
  pr_head_sha: string;
  pr_head_ref?: string;
  pr_head_repo?: string;
  current_base_tip_sha: string;
  base_ref: string;
  workspace_evidence_sha256: string;
  command_snapshot_id: string;
  command_snapshot_sha256: string;
  publication_delivery_id?: string;
  publication_remote_id?: number;
  publication_remote_url?: string;
  published_at?: string;
  updated_at: string;
}

export interface ConflictProposalInput {
  draft: unknown;
  proposalId?: string;
  proposalRevision: number;
  executionId: string;
  runId: string;
  repairRunId?: string;
  basis: ConflictProposalBasis;
  discussion?: {
    discussion_execution_id: string;
    discussion_snapshot_id: string;
    discussion_snapshot_sha256: string;
  };
  createdAt?: string;
}

export interface ConflictProposalWorkspaceState {
  proposal: ConflictProposal;
  pointer: ConflictProposalPointer;
}

const statusValues = new Set<ConflictProposalStatus>(['draft', 'publication_pending', 'published', 'superseded', 'stale']);

function assertRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Conflict proposal revision must be a positive integer');
}

function assertSha(value: string, label: string) {
  if (!/^[a-f0-9]{7,64}$/i.test(value)) throw new Error(`Conflict proposal ${label} must be a Git object/hash`);
}

function normalizeDraft(input: unknown): ConflictProposalDraft {
  const parsed = conflictProposalDraftSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid conflict proposal: ${parsed.error.issues.map(issue => issue.path.join('.') + ' ' + issue.message).join('; ')}`);
  const draft = parsed.data;
  const affected = new Set<string>();
  for (const file of draft.affected_files) affected.add(validateRepoRelativePath(file));
  const conflicts = draft.conflicts.map(conflict => ({ ...conflict, path: validateRepoRelativePath(conflict.path) }));
  const conflictPaths = new Set(conflicts.map(conflict => conflict.path));
  for (const path of conflictPaths) {
    if (!affected.has(path)) throw new Error(`Conflict proposal affected_files must include conflict path: ${path}`);
  }
  return { ...draft, conflicts, affected_files: [...affected] };
}

function immutablePayload(proposal: Pick<ConflictProposal, keyof ConflictProposal>) {
  const {
    proposal_hash: _hash, status: _status, created_at: _createdAt, publication: _publication,
    ...payload
  } = proposal;
  return payload;
}

export function conflictProposalHash(proposal: Pick<ConflictProposal, keyof ConflictProposal>) {
  return sha256Canonical(immutablePayload(proposal));
}

export function createConflictProposal(input: ConflictProposalInput): ConflictProposal {
  assertRevision(input.proposalRevision);
  if (!input.executionId || !input.runId) throw new Error('Conflict proposal execution and run identity are required');
  if (!input.basis.pr_head_ref || !input.basis.pr_head_repo) throw new Error('Conflict proposal source ref and repository are required');
  assertSha(input.basis.pr_head_sha, 'pr_head_sha');
  assertSha(input.basis.current_base_tip_sha, 'current_base_tip_sha');
  assertSha(input.basis.workspace_evidence_sha256, 'workspace_evidence_sha256');
  assertSha(input.basis.command_snapshot_sha256, 'command_snapshot_sha256');
  const draft = normalizeDraft(input.draft);
  const proposal = {
    schema_version: CONFLICT_PROPOSAL_SCHEMA_VERSION,
    proposal_id: input.proposalId ?? `proposal-${randomUUID()}`,
    proposal_revision: input.proposalRevision,
    execution_id: input.executionId,
    repair_execution_id: input.executionId,
    repair_run_id: input.repairRunId ?? input.runId,
    run_id: input.runId,
    ...draft,
    basis: input.basis,
    ...(input.discussion ?? {}),
    proposal_hash: '',
    status: 'draft' as const,
    created_at: input.createdAt ?? new Date().toISOString(),
  } satisfies ConflictProposal;
  proposal.proposal_hash = conflictProposalHash(proposal);
  return proposal;
}

export function validateConflictProposal(input: unknown): ConflictProposal {
  if (!input || typeof input !== 'object') throw new Error('Conflict proposal is not an object');
  const value = input as Partial<ConflictProposal>;
  if (value.schema_version !== CONFLICT_PROPOSAL_SCHEMA_VERSION) throw new Error('Unsupported conflict proposal schema');
  assertRevision(value.proposal_revision as number);
  if (typeof value.proposal_id !== 'string' || !value.proposal_id || typeof value.execution_id !== 'string' || !value.execution_id ||
      typeof value.repair_execution_id !== 'string' || value.repair_execution_id !== value.execution_id ||
      typeof value.run_id !== 'string' || !value.run_id || typeof value.proposal_hash !== 'string') throw new Error('Conflict proposal identity is incomplete');
  const repairRunId = typeof value.repair_run_id === 'string' && value.repair_run_id ? value.repair_run_id : value.run_id;
  const draft = normalizeDraft(value);
  const basis = value.basis as ConflictProposalBasis | undefined;
  if (!basis?.pr_head_sha || !basis.current_base_tip_sha || !basis.base_ref || !basis.workspace_evidence_sha256 ||
      !basis.command_snapshot_id || !basis.command_snapshot_sha256) throw new Error('Conflict proposal evidence basis is incomplete');
  if ((basis.pr_head_ref === undefined) !== (basis.pr_head_repo === undefined)) throw new Error('Conflict proposal source binding is incomplete');
  assertSha(basis.pr_head_sha, 'pr_head_sha'); assertSha(basis.current_base_tip_sha, 'current_base_tip_sha');
  assertSha(basis.workspace_evidence_sha256, 'workspace_evidence_sha256'); assertSha(basis.command_snapshot_sha256, 'command_snapshot_sha256');
  const discussion = [value.discussion_execution_id, value.discussion_snapshot_id, value.discussion_snapshot_sha256];
  if (discussion.some(item => item !== undefined)) {
    if (discussion.some(item => typeof item !== 'string' || !item)) throw new Error('Conflict proposal discussion snapshot is incomplete');
    assertSha(value.discussion_snapshot_sha256 as string, 'discussion_snapshot_sha256');
  }
  if (!statusValues.has(value.status as ConflictProposalStatus)) throw new Error('Conflict proposal status is invalid');
  if (typeof value.created_at !== 'string' || !value.created_at) throw new Error('Conflict proposal creation time is missing');
  const proposal = { ...value, ...draft, basis, repair_run_id: repairRunId, status: value.status as ConflictProposalStatus } as ConflictProposal;
  const hashMatches = conflictProposalHash(proposal) === proposal.proposal_hash
    || (value.repair_run_id === undefined && conflictProposalHash({ ...proposal, repair_run_id: undefined } as unknown as ConflictProposal) === proposal.proposal_hash);
  if (!hashMatches) throw new Error('Conflict proposal hash does not match its immutable payload');
  return proposal;
}

export function renderConflictProposal(proposal: ConflictProposal) {
  const conflicts = proposal.conflicts.map((conflict, index) => [
    `### 冲突 ${index + 1}：\`${conflict.path}\``,
    `- 问题：${conflict.issue}`,
    `- PR 侧：${conflict.pr_side}`,
    `- 当前 base 侧：${conflict.base_side}`,
    `- 拟议解决：${conflict.proposed_resolution}`,
    `- 分歧/取舍：${conflict.disagreement_or_tradeoff}`,
  ].join('\n')).join('\n\n');
  const list = (values: string[]) => values.map(value => `- ${value}`).join('\n');
  return [
    `## PatchPaw Conflict Proposal v${proposal.proposal_revision}`,
    `提案 hash：\`${proposal.proposal_hash}\``,
    '',
    `### PR 意图\n${proposal.pr_intent}`,
    `### 当前 base 意图\n${proposal.current_base_intent}`,
    `### 总结\n${proposal.summary}`,
    `### 冲突与拟议方向\n${conflicts}`,
    `### 影响文件\n${list(proposal.affected_files)}`,
    `### 验证计划\n${list(proposal.verification_plan)}`,
    `### 风险与待决问题\n${proposal.risks_or_open_questions.length ? list(proposal.risks_or_open_questions) : '- 暂无已知风险或待决问题。'}`,
    `### Agent 面向人类的摘要\n${proposal.human_markdown_summary}`,
    '',
    `依据：PR head \`${proposal.basis.pr_head_sha}\`，current base \`${proposal.basis.current_base_tip_sha}\`，base ref \`${proposal.basis.base_ref}\`。`,
    '以上内容由 Harness 从已验证的结构化提案生成；当前只读阶段不会修改、commit 或 push。',
    '如确认该版本的方向，请在此 PR 新增一条单独评论：`/approval`。普通讨论不会授权修复。',
  ].join('\n\n');
}

export function conflictProposalDirectory(statePath: string) { return `${statePath}.conflict-proposals`; }
export function conflictProposalVersionPath(statePath: string, revision: number) {
  assertRevision(revision);
  return join(conflictProposalDirectory(statePath), `conflict-proposal-v${revision}.json`);
}
function conflictProposalStatusPath(statePath: string, revision: number) {
  return join(conflictProposalDirectory(statePath), `conflict-proposal-v${revision}.status.json`);
}
export function conflictProposalCurrentPath(statePath: string) {
  return join(conflictProposalDirectory(statePath), 'conflict-proposal-current.json');
}

function pointerFromProposal(statePath: string, proposal: ConflictProposal, workspacePath: string, updatedAt = new Date().toISOString()): ConflictProposalPointer {
  return {
    schema_version: CONFLICT_PROPOSAL_CURRENT_SCHEMA_VERSION,
    proposal_id: proposal.proposal_id, proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash,
    status: proposal.status, proposal_path: conflictProposalVersionPath(statePath, proposal.proposal_revision),
    run_id: proposal.run_id, execution_id: proposal.execution_id, workspace_path: workspacePath,
    pr_head_sha: proposal.basis.pr_head_sha, pr_head_ref: proposal.basis.pr_head_ref, pr_head_repo: proposal.basis.pr_head_repo,
    current_base_tip_sha: proposal.basis.current_base_tip_sha, base_ref: proposal.basis.base_ref,
    workspace_evidence_sha256: proposal.basis.workspace_evidence_sha256,
    command_snapshot_id: proposal.basis.command_snapshot_id, command_snapshot_sha256: proposal.basis.command_snapshot_sha256,
    ...(proposal.publication ? {
      publication_delivery_id: proposal.publication.delivery_id, publication_remote_id: proposal.publication.remote_id,
      publication_remote_url: proposal.publication.remote_url, published_at: proposal.publication.published_at,
    } : {}),
    updated_at: updatedAt,
  };
}

export async function readConflictProposal(statePath: string, revision: number): Promise<ConflictProposal | null> {
  const raw = await readJson<ConflictProposal>(conflictProposalVersionPath(statePath, revision));
  if (!raw) return null;
  const proposal = validateConflictProposal(raw);
  const status = await readJson<{ status: ConflictProposalStatus; publication?: ConflictProposalPublication }>(conflictProposalStatusPath(statePath, revision));
  return { ...proposal, ...(status ?? {}) };
}

export async function readCurrentConflictProposal(statePath: string): Promise<ConflictProposalWorkspaceState | null> {
  const pointer = await readJson<ConflictProposalPointer>(conflictProposalCurrentPath(statePath));
  if (!pointer) return null;
  if (pointer.schema_version !== CONFLICT_PROPOSAL_CURRENT_SCHEMA_VERSION) throw new Error('Conflict proposal current pointer schema is unsupported');
  const proposal = await readConflictProposal(statePath, pointer.proposal_revision);
  if (!proposal || proposal.proposal_id !== pointer.proposal_id || proposal.proposal_hash !== pointer.proposal_hash) {
    throw new Error('Conflict proposal current pointer does not resolve to an immutable version');
  }
  return { proposal, pointer };
}

export async function saveConflictProposal(statePath: string, proposal: ConflictProposal, workspacePath: string) {
  const normalized = validateConflictProposal(proposal);
  const versionPath = conflictProposalVersionPath(statePath, normalized.proposal_revision);
  const existing = await readJson<ConflictProposal>(versionPath);
  if (existing) {
    const valid = validateConflictProposal(existing);
    if (valid.proposal_hash !== normalized.proposal_hash || valid.proposal_id !== normalized.proposal_id) {
      throw new Error(`Conflict proposal revision v${normalized.proposal_revision} is immutable and already contains different content`);
    }
  } else {
    await immutableJson(versionPath, { ...normalized, status: 'draft', publication: undefined });
  }
  await atomicJson(conflictProposalStatusPath(statePath, normalized.proposal_revision), { status: normalized.status });
  const current = await readCurrentConflictProposal(statePath);
  if (!current || current.proposal.proposal_revision <= normalized.proposal_revision) {
    await atomicJson(conflictProposalCurrentPath(statePath), pointerFromProposal(statePath, normalized, workspacePath));
  }
  return readCurrentConflictProposal(statePath);
}

export async function markConflictProposalStatus(statePath: string, revision: number, status: ConflictProposalStatus,
  workspacePath: string, publication?: ConflictProposalPublication) {
  const proposal = await readConflictProposal(statePath, revision);
  if (!proposal) throw new Error(`Conflict proposal v${revision} is missing`);
  await atomicJson(conflictProposalStatusPath(statePath, revision), { status, ...(publication ? { publication } : {}) });
  const current = await readCurrentConflictProposal(statePath);
  if (current?.proposal.proposal_revision === revision) {
    const next = { ...proposal, status, ...(publication ? { publication } : {}) };
    await atomicJson(conflictProposalCurrentPath(statePath), pointerFromProposal(statePath, next, workspacePath));
  }
  return readCurrentConflictProposal(statePath);
}

export function proposalPointerForState(proposal: ConflictProposal, workspacePath: string): NonNullable<RunState['conflict_proposal']> {
  return {
    proposal_id: proposal.proposal_id, proposal_revision: proposal.proposal_revision, proposal_hash: proposal.proposal_hash,
    status: proposal.status, run_id: proposal.run_id, execution_id: proposal.execution_id, workspace_path: workspacePath,
    pr_head_sha: proposal.basis.pr_head_sha, pr_head_ref: proposal.basis.pr_head_ref, pr_head_repo: proposal.basis.pr_head_repo,
    current_base_tip_sha: proposal.basis.current_base_tip_sha, base_ref: proposal.basis.base_ref,
    workspace_evidence_sha256: proposal.basis.workspace_evidence_sha256,
    command_snapshot_id: proposal.basis.command_snapshot_id, command_snapshot_sha256: proposal.basis.command_snapshot_sha256,
  };
}

export async function saveProposalState(path: string, proposal: ConflictProposal, workspacePath: string, patch: Partial<RunState> = {}) {
  const current = await readState(path);
  if (current && current.conflict_proposal && current.conflict_proposal.proposal_revision > proposal.proposal_revision) return current;
  const pointer = proposalPointerForState(proposal, workspacePath);
  const next: RunState = applyRunPhase({ ...(current ?? {} as RunState), ...patch, conflict_proposal: pointer,
    active: patch.active ?? current?.active ?? false }, patch.phase ?? current?.phase ?? proposal.status);
  await writeState(path, next);
  return next;
}

export async function updateProposalState(path: string, proposal: ConflictProposal, workspacePath: string, patch: Partial<RunState> = {}) {
  const current = await readState(path);
  if (current?.conflict_proposal && current.conflict_proposal.proposal_hash !== proposal.proposal_hash &&
      current.conflict_proposal.proposal_revision > proposal.proposal_revision) return current;
  return saveProposalState(path, proposal, workspacePath, patch);
}

export async function markCurrentConflictProposalStale(path: string, workspacePath: string, reason: string) {
  const current = await readCurrentConflictProposal(path);
  if (!current) return null;
  await markConflictProposalStatus(path, current.proposal.proposal_revision, 'stale', workspacePath);
  const state = await readState(path);
  if (state?.conflict_proposal?.proposal_hash === current.proposal.proposal_hash) {
    await writeState(path, applyRunPhase({ ...state, active: false, conflict_proposal: { ...state.conflict_proposal, status: 'stale' } }, 'stale'));
  }
  return { ...current, reason };
}

export function proposalDeliverySemanticKey(proposal: ConflictProposal) {
  return `conflict-proposal:${proposal.proposal_id}:v${proposal.proposal_revision}:${proposal.proposal_hash}`;
}

export async function cancelConflictProposalPublication(root: string, repo: string, prNumber: number, proposal: ConflictProposal) {
  const delivery = (await listOutbound(root, { repo, prNumber })).find(item => item.item.semantic_key === proposalDeliverySemanticKey(proposal));
  if (!delivery) return undefined;
  return cancelOutboundDelivery(root, delivery, 'conflict_proposal_superseded');
}

export function proposalPublicationFromOutbound(item: OutboundItem): ConflictProposalPublication {
  return {
    delivery_id: item.delivery_id,
    remote_id: item.receipt?.id,
    remote_url: item.receipt?.html_url,
    published_at: item.receipt?.published_at ?? new Date().toISOString(),
  };
}

/**
 * Reconcile the proposal projection from the durable communication receipt. This is safe to
 * call from a worker retry or the communication scheduler: it never calls a model or grants
 * write access, and it refuses to move a superseded/stale version back to awaiting approval.
 */
export async function reconcileConflictProposalPublication(root: string, statePath: string, repo: string, prNumber: number, finalize = true) {
  const current = await readCurrentConflictProposal(statePath);
  if (!current || !['draft', 'publication_pending', 'published'].includes(current.proposal.status)) return current;
  // /close removes the proposal directory and retires the local generation. If a delayed
  // scheduler sees an old outbox row during that boundary, it may finalize delivery but must
  // not recreate a closed run's state, trace, or retained workspace.
  const stateBefore = await readState(statePath);
  if (stateBefore?.phase === 'closed') return current;
  const delivery = (await listOutbound(root, { repo, prNumber })).find(item => item.item.semantic_key === proposalDeliverySemanticKey(current.proposal));
  if (!delivery || delivery.item.status !== 'delivered' || !delivery.item.receipt) return current;
  const publication = proposalPublicationFromOutbound(delivery.item);
  const updated = current.proposal.status === 'published'
    ? current
    : await markConflictProposalStatus(statePath, current.proposal.proposal_revision, 'published', current.pointer.workspace_path, publication);
  const state = await readState(statePath);
  if (updated && state && state.phase !== 'closed'
      && (state.conflict_proposal?.proposal_hash !== current.proposal.proposal_hash
        || state.conflict_proposal?.status !== 'published' || state.phase !== 'awaiting_approval')) {
    const next: RunState = applyRunPhase({ ...state, active: false,
      conflict_proposal: { ...proposalPointerForState(updated.proposal, current.pointer.workspace_path), status: 'published', publication_delivery_id: publication.delivery_id,
        publication_remote_id: publication.remote_id, publication_remote_url: publication.remote_url, published_at: publication.published_at } }, 'awaiting_approval');
    await writeState(statePath, next);
    const paused = await readPaused(statePath);
    if (paused?.workspace.path === current.pointer.workspace_path) await savePaused(statePath, { ...paused, status: 'awaiting_approval' });
    const dir = join(patchpawPaths(root).runs, current.proposal.run_id);
    const trace = new Trace(dir); trace.save('conflict-proposal-publication.json', { ...publication, proposal_revision: current.proposal.proposal_revision,
      proposal_hash: current.proposal.proposal_hash, status: 'published' }); trace.emit('conflict_proposal_published', publication);
    const resultPath = join(dir, 'result.json');
    const existing = await readJson<Record<string, unknown>>(resultPath);
    if (existing && ['publication_pending', 'draft'].includes(String(existing.status))) {
      trace.save('result.json', { ...existing, status: 'awaiting_approval', proposal_revision: current.proposal.proposal_revision,
        proposal_hash: current.proposal.proposal_hash, publication });
    }
  }
  // Finalization is idempotent and is intentionally performed even when the projection was
  // already repaired by an earlier worker pass.
  if (finalize) await finalizeDelivery(root, delivery);
  return updated;
}

export async function reconcilePendingConflictProposal(root: string, statePath: string, repo: string, prNumber: number) {
  return reconcileConflictProposalPublication(root, statePath, repo, prNumber);
}
