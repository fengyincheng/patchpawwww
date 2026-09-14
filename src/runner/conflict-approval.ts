import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../control-plane/snapshots.ts';
import { atomicJson, immutableJson, readJson } from './durable-json.ts';

export const CONFLICT_APPROVAL_SCHEMA_VERSION = 'patchpaw.conflict-approval.v1';

export type ConflictApprovalStatus = 'accepted' | 'rejected' | 'stale';
export type ConflictApprovalPhase =
  | 'accepted'
  | 'claimed'
  | 'repairing'
  | 'verification_passed'
  | 'committing'
  | 'committed'
  | 'pushing'
  | 'remote_confirmed'
  | 'publication_pending'
  | 'completed'
  | 'interrupted';

export type ConflictApprovalRejectionCode =
  | 'approval_after_close'
  | 'approval_already_processed'
  | 'no_pending_proposal'
  | 'proposal_not_published'
  | 'proposal_not_current'
  | 'proposal_publication_missing'
  | 'proposal_stale'
  | 'unauthorized_actor'
  | 'approval_event_invalid'
  | 'snapshot_missing'
  | 'snapshot_corrupt'
  | 'snapshot_hash_mismatch'
  | 'command_missing'
  | 'command_read_only'
  | 'command_disabled'
  | 'workspace_missing'
  | 'workspace_changed'
  | 'workspace_owned'
  | 'git_facts_changed'
  | 'pr_closed'
  | 'repair_interrupted';

const QUALIFIED_APPROVAL_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface ConflictApprovalRecord {
  schema_version: typeof CONFLICT_APPROVAL_SCHEMA_VERSION;
  approval_id: string;
  idempotency_key: string;
  source_event_id: string;
  source_comment_id: number;
  source_comment_url: string;
  source_comment_created_at?: string;
  author: string;
  author_association: string;
  received_at: string;
  verified_at: string;
  repair_execution_id: string;
  proposal_id: string;
  proposal_revision: number;
  proposal_hash: string;
  proposal_publication_delivery_id: string;
  proposal_publication_remote_id?: number;
  pr_head_sha: string;
  pr_head_ref: string;
  pr_head_repo: string;
  current_base_tip_sha: string;
  base_ref: string;
  command_snapshot_id: string;
  command_snapshot_sha256: string;
  status: ConflictApprovalStatus;
  rejection_code?: ConflictApprovalRejectionCode;
  phase: ConflictApprovalPhase;
  claim_run_id?: string;
  repair_run_id?: string;
  claimed_at?: string;
  repair_started_at?: string;
  verification_at?: string;
  commit_sha?: string;
  pushed_at?: string;
  remote_head_sha?: string;
  final_publication_delivery_id?: string;
  final_publication_remote_id?: number;
  final_published_at?: string;
  updated_at: string;
}

export function conflictApprovalDirectory(statePath: string) {
  return `${statePath}.conflict-approvals`;
}

export function conflictApprovalRecordPath(statePath: string, approvalId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(approvalId)) throw new Error('Conflict approval id is not a safe runtime identifier');
  return join(conflictApprovalDirectory(statePath), `approval-${approvalId}.json`);
}

export function conflictApprovalCurrentPath(statePath: string) {
  return join(conflictApprovalDirectory(statePath), 'approval-current.json');
}

export function conflictApprovalIdempotencyKey(input: { sourceCommentId: number; proposalHash: string; repairExecutionId: string }) {
  return `approval:${input.sourceCommentId}:${input.proposalHash}:${input.repairExecutionId}`;
}

export function approvalDeliverySemanticKey(approval: Pick<ConflictApprovalRecord, 'proposal_id' | 'proposal_revision' | 'proposal_hash'>) {
  return `conflict-repair:${approval.proposal_id}:v${approval.proposal_revision}:${approval.proposal_hash}`;
}

function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function isUtcTimestamp(value: unknown) {
  return typeof value === 'string' && /T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function assertRecord(value: ConflictApprovalRecord) {
  if (value.schema_version !== CONFLICT_APPROVAL_SCHEMA_VERSION) throw new Error('Conflict approval schema is unsupported');
  if (!value.approval_id || !value.idempotency_key || !value.source_event_id || !Number.isSafeInteger(value.source_comment_id) || value.source_comment_id < 1) {
    throw new Error('Conflict approval identity is incomplete');
  }
  if (value.idempotency_key !== conflictApprovalIdempotencyKey({ sourceCommentId: value.source_comment_id, proposalHash: value.proposal_hash, repairExecutionId: value.repair_execution_id })) {
    throw new Error('Conflict approval idempotency binding is invalid');
  }
  try { if (new URL(value.source_comment_url).protocol !== 'https:') throw new Error(); } catch { throw new Error('Conflict approval source URL is invalid'); }
  if (!value.author || !value.author_association) throw new Error('Conflict approval actor identity is incomplete');
  if (value.status === 'accepted' && !QUALIFIED_APPROVAL_ASSOCIATIONS.has(value.author_association.toUpperCase())) throw new Error('Conflict approval actor is not qualified');
  if (!value.proposal_id || !Number.isSafeInteger(value.proposal_revision) || value.proposal_revision < 1 || !value.proposal_hash) {
    throw new Error('Conflict approval proposal identity is incomplete');
  }
  if (!value.repair_execution_id || !value.command_snapshot_id || !value.command_snapshot_sha256) {
    throw new Error('Conflict approval snapshot identity is incomplete');
  }
  if (!value.proposal_publication_delivery_id || !value.pr_head_sha || !value.pr_head_ref || !value.pr_head_repo || !value.current_base_tip_sha || !value.base_ref) {
    throw new Error('Conflict approval publication or Git binding is incomplete');
  }
  if (!['accepted', 'rejected', 'stale'].includes(value.status)) throw new Error('Conflict approval status is invalid');
  if (!['accepted', 'claimed', 'repairing', 'verification_passed', 'committing', 'committed', 'pushing', 'remote_confirmed', 'publication_pending', 'completed', 'interrupted'].includes(value.phase)) {
    throw new Error('Conflict approval phase is invalid');
  }
  if (!isUtcTimestamp(value.received_at) || !isUtcTimestamp(value.verified_at) || !isUtcTimestamp(value.updated_at)) throw new Error('Conflict approval timestamps are incomplete');
  if (value.source_comment_created_at !== undefined && !isUtcTimestamp(value.source_comment_created_at)) throw new Error('Conflict approval source comment time is invalid');
  if (value.claimed_at !== undefined && !isUtcTimestamp(value.claimed_at)) throw new Error('Conflict approval claim time is invalid');
  if (value.repair_started_at !== undefined && !isUtcTimestamp(value.repair_started_at)) throw new Error('Conflict approval repair start time is invalid');
  if (value.verification_at !== undefined && !isUtcTimestamp(value.verification_at)) throw new Error('Conflict approval verification time is invalid');
  if (value.pushed_at !== undefined && !isUtcTimestamp(value.pushed_at)) throw new Error('Conflict approval push time is invalid');
  if (value.final_published_at !== undefined && !isUtcTimestamp(value.final_published_at)) throw new Error('Conflict approval final publication time is invalid');
  if (value.proposal_publication_remote_id !== undefined && (!Number.isSafeInteger(value.proposal_publication_remote_id) || value.proposal_publication_remote_id < 1)) throw new Error('Conflict approval proposal receipt is invalid');
  if (value.final_publication_remote_id !== undefined && (!Number.isSafeInteger(value.final_publication_remote_id) || value.final_publication_remote_id < 1)) throw new Error('Conflict approval final receipt is invalid');
  return value;
}

async function listRecordPaths(statePath: string) {
  try {
    return (await readdir(conflictApprovalDirectory(statePath)))
      .filter(name => name !== 'approval-current.json' && /^approval-[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name))
      .map(name => join(conflictApprovalDirectory(statePath), name));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

export async function listConflictApprovals(statePath: string) {
  const records: ConflictApprovalRecord[] = [];
  for (const path of await listRecordPaths(statePath)) {
    const record = await readJson<ConflictApprovalRecord>(path);
    if (record) records.push(assertRecord(record));
  }
  return records.sort((left, right) => left.source_comment_id - right.source_comment_id || left.received_at.localeCompare(right.received_at));
}

export async function readConflictApproval(statePath: string, approvalId: string) {
  const record = await readJson<ConflictApprovalRecord>(conflictApprovalRecordPath(statePath, approvalId));
  return record ? assertRecord(record) : null;
}

export async function readConflictApprovalByIdempotency(statePath: string, idempotencyKey: string) {
  return (await listConflictApprovals(statePath)).find(record => record.idempotency_key === idempotencyKey) ?? null;
}

export function isUnfinishedConflictApproval(record: ConflictApprovalRecord) {
  return record.status === 'accepted' && !['completed', 'interrupted'].includes(record.phase);
}

export async function readUnfinishedConflictApproval(statePath: string) {
  const records = await listConflictApprovals(statePath);
  return records.reverse().find(isUnfinishedConflictApproval) ?? null;
}

export async function saveConflictApproval(statePath: string, input: ConflictApprovalRecord) {
  const record = assertRecord(input);
  const path = conflictApprovalRecordPath(statePath, record.approval_id);
  const existing = await readJson<ConflictApprovalRecord>(path);
  if (existing) {
    const current = assertRecord(existing);
    if (current.idempotency_key !== record.idempotency_key) throw new Error('Conflict approval id is already bound to another event');
    await atomicJson(path, record);
  } else {
    await immutableJson(path, record);
  }
  await atomicJson(conflictApprovalCurrentPath(statePath), {
    schema_version: `${CONFLICT_APPROVAL_SCHEMA_VERSION}:current`, approval_id: record.approval_id,
    idempotency_key: record.idempotency_key, status: record.status, phase: record.phase, updated_at: record.updated_at,
  });
  return readConflictApproval(statePath, record.approval_id);
}

export async function updateConflictApproval(statePath: string, approvalId: string, patch: Partial<ConflictApprovalRecord>) {
  const current = await readConflictApproval(statePath, approvalId);
  if (!current) throw new Error(`Conflict approval is missing: ${approvalId}`);
  return saveConflictApproval(statePath, { ...current, ...patch, updated_at: new Date().toISOString() });
}

export function newConflictApproval(input: Omit<ConflictApprovalRecord, 'schema_version' | 'approval_id' | 'idempotency_key' | 'updated_at'>) {
  const idempotency_key = conflictApprovalIdempotencyKey({ sourceCommentId: input.source_comment_id, proposalHash: input.proposal_hash, repairExecutionId: input.repair_execution_id });
  const approval_id = `approval-${digest(idempotency_key).slice(0, 32)}`;
  return { schema_version: CONFLICT_APPROVAL_SCHEMA_VERSION, ...input, approval_id, idempotency_key, updated_at: new Date().toISOString() } satisfies ConflictApprovalRecord;
}
