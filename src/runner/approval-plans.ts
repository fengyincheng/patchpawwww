import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJson } from '../control-plane/snapshots.ts';
import { atomicJson, immutableJson, readJson } from './durable-json.ts';

export const APPROVAL_PLAN_SCHEMA_VERSION = 'patchpaw.approval-plan.v1';
export const APPROVAL_PLAN_CURRENT_SCHEMA_VERSION = 'patchpaw.approval-plan-current.v1';
export const APPROVAL_PLAN_STATUS_SCHEMA_VERSION = 'patchpaw.approval-plan-status.v1';

export type ApprovalPlanStatus = 'draft' | 'publication_pending' | 'published' | 'approved' | 'stale' | 'superseded';

/** Run result states accepted by the shared Approval Plan boundary. */
export type ApprovalPlanFinishStatus =
  | 'needs_human' | 'budget_exhausted' | 'stale' | 'publication_pending' | 'awaiting_approval'
  | 'custom_completed' | 'review_completed' | 'repair_completed' | 'ci_completed' | 'conflict_completed';

export type ApprovalPlanCompletionStatus = 'custom_completed' | 'review_completed' | 'repair_completed' | 'ci_completed' | 'conflict_completed';

const APPROVAL_PLAN_COMPLETION_STATUSES: ReadonlySet<string> = new Set([
  'custom_completed', 'review_completed', 'repair_completed', 'ci_completed', 'conflict_completed',
]);

export function isApprovalPlanCompletionStatus(value: string): value is ApprovalPlanCompletionStatus {
  return APPROVAL_PLAN_COMPLETION_STATUSES.has(value);
}

export interface ApprovalPlanPublication {
  delivery_id: string;
  remote_id?: number;
  remote_url?: string;
  published_at?: string;
}

/**
 * The durable generic approval claim. It is written only after the current Plan, its publication
 * receipt, the verified webhook provenance and the mechanical Git/workspace/snapshot facts have
 * all been validated. Its phase is the only generic approval lifecycle state; the source comment
 * is retired after the claim is durable, so a crash can never require a second `/approval`.
 */
export type ApprovalPlanClaimPhase = 'accepted' | 'running' | 'completed' | 'interrupted';

export interface ApprovalPlanClaim {
  plan_id: string;
  plan_revision: number;
  body_sha256: string;
  source_event_id: string;
  source_comment_id: number;
  source_comment_url?: string;
  source_comment_created_at?: string;
  author: string;
  author_association?: string;
  accepted_at: string;
  claim_run_id?: string;
  phase: ApprovalPlanClaimPhase;
  updated_at: string;
}

/**
 * The logical Plan the rest of the Harness reasons about. The Agent body is an opaque
 * string: it is only trimmed, size-bounded, hashed, and stored. Nothing here parses it.
 */
export interface ApprovalPlan {
  schema_version: typeof APPROVAL_PLAN_SCHEMA_VERSION;
  plan_id: string;
  plan_revision: number;
  body: string;
  body_sha256: string;
  command_id: string;
  command_name: string;
  execution_type: 'custom' | 'review' | 'repair' | 'ci' | 'conflict';
  permission: 'read_write_approval';
  run_id: string;
  execution_id: number;
  pr_head_sha: string;
  pr_head_ref: string;
  pr_head_repo: string;
  current_base_tip_sha: string;
  base_ref: string;
  workspace_path: string;
  workspace_evidence_sha256: string;
  command_snapshot_id: string;
  command_snapshot_sha256: string;
  status: ApprovalPlanStatus;
  created_at: string;
  publication?: ApprovalPlanPublication;
}

/** The immutable half of a Plan: everything that defines which text and mechanical binding was approved. */
export type ApprovalPlanImmutable = Omit<ApprovalPlan, 'status' | 'publication'>;

/** Mutable lifecycle facts live beside the immutable body so a crash cannot rewind them. */
export interface ApprovalPlanStatusRecord {
  schema_version: typeof APPROVAL_PLAN_STATUS_SCHEMA_VERSION;
  plan_id: string;
  plan_revision: number;
  body_sha256: string;
  status: ApprovalPlanStatus;
  publication?: ApprovalPlanPublication;
  /** Durable generic approval claim; only ever present on the current published revision. */
  approval?: ApprovalPlanClaim;
  updated_at: string;
}

export interface ApprovalPlanPointer {
  schema_version: typeof APPROVAL_PLAN_CURRENT_SCHEMA_VERSION;
  plan_id: string;
  plan_revision: number;
  body_sha256: string;
  status: ApprovalPlanStatus;
  plan_path: string;
  run_id: string;
  execution_id: number;
  workspace_path: string;
  pr_head_sha: string;
  pr_head_ref: string;
  pr_head_repo: string;
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

/** Projection persisted on RunState so a worker entry can find the current Plan cheaply. */
export interface ApprovalPlanStatePointer {
  plan_id: string; plan_revision: number; body_sha256: string;
  status: ApprovalPlanStatus;
  run_id: string; execution_id: number; workspace_path: string;
  pr_head_sha: string; pr_head_ref: string; pr_head_repo: string;
  current_base_tip_sha: string; base_ref: string; workspace_evidence_sha256: string;
  command_snapshot_id: string; command_snapshot_sha256: string;
  publication_delivery_id?: string; publication_remote_id?: number; publication_remote_url?: string; published_at?: string;
}

export interface ApprovalPlanWorkspaceState { plan: ApprovalPlan; pointer: ApprovalPlanPointer; approval?: ApprovalPlanClaim }

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, 'must be a SHA-256 hash');
const timestampSchema = z.string().refine(isUtcTimestamp, 'must be an RFC 3339 UTC timestamp');
const approvalPlanPublicationSchema: z.ZodType<ApprovalPlanPublication> = z.object({
  delivery_id: z.string().min(1), remote_id: z.number().int().positive().optional(),
  remote_url: z.string().min(1).optional(), published_at: timestampSchema.optional(),
});
const approvalPlanClaimSchema: z.ZodType<ApprovalPlanClaim> = z.object({
  plan_id: z.string().min(1), plan_revision: z.number().int().positive(), body_sha256: sha256Schema,
  source_event_id: z.string().min(1), source_comment_id: z.number().int().positive(),
  source_comment_url: z.string().min(1).optional(), source_comment_created_at: timestampSchema.optional(),
  author: z.string().min(1), author_association: z.string().min(1).optional(),
  accepted_at: timestampSchema, claim_run_id: z.string().min(1).optional(),
  phase: z.enum(['accepted', 'running', 'completed', 'interrupted']), updated_at: timestampSchema,
});
const approvalPlanSchema: z.ZodType<ApprovalPlan> = z.object({
  schema_version: z.literal(APPROVAL_PLAN_SCHEMA_VERSION), plan_id: z.string().min(1), plan_revision: z.number().int().positive(),
  body: z.string().min(1).max(512 * 1024).refine(value => value === value.trim(), 'body must be trimmed'), body_sha256: sha256Schema,
  command_id: z.string().min(1), command_name: z.string().min(1), execution_type: z.enum(['custom', 'review', 'repair', 'ci', 'conflict']),
  permission: z.literal('read_write_approval'), run_id: z.string().min(1), execution_id: z.number().int().positive(),
  pr_head_sha: z.string().min(1), pr_head_ref: z.string().min(1), pr_head_repo: z.string().min(1),
  current_base_tip_sha: z.string().min(1), base_ref: z.string().min(1), workspace_path: z.string().min(1),
  workspace_evidence_sha256: sha256Schema, command_snapshot_id: z.string().min(1), command_snapshot_sha256: sha256Schema,
  status: z.enum(['draft', 'publication_pending', 'published', 'approved', 'stale', 'superseded']), created_at: timestampSchema,
  publication: approvalPlanPublicationSchema.optional(),
});
const approvalPlanStatusRecordSchema: z.ZodType<ApprovalPlanStatusRecord> = z.object({
  schema_version: z.literal(APPROVAL_PLAN_STATUS_SCHEMA_VERSION), plan_id: z.string().min(1), plan_revision: z.number().int().positive(),
  body_sha256: sha256Schema, status: z.enum(['draft', 'publication_pending', 'published', 'approved', 'stale', 'superseded']),
  publication: approvalPlanPublicationSchema.optional(), approval: approvalPlanClaimSchema.optional(), updated_at: timestampSchema,
});
const approvalPlanPointerSchema: z.ZodType<ApprovalPlanPointer> = z.object({
  schema_version: z.literal(APPROVAL_PLAN_CURRENT_SCHEMA_VERSION), plan_id: z.string().min(1), plan_revision: z.number().int().positive(),
  body_sha256: sha256Schema, status: z.enum(['draft', 'publication_pending', 'published', 'approved', 'stale', 'superseded']),
  plan_path: z.string().min(1), run_id: z.string().min(1), execution_id: z.number().int().positive(), workspace_path: z.string().min(1),
  pr_head_sha: z.string().min(1), pr_head_ref: z.string().min(1), pr_head_repo: z.string().min(1),
  current_base_tip_sha: z.string().min(1), base_ref: z.string().min(1), workspace_evidence_sha256: sha256Schema,
  command_snapshot_id: z.string().min(1), command_snapshot_sha256: sha256Schema,
  publication_delivery_id: z.string().min(1).optional(), publication_remote_id: z.number().int().positive().optional(),
  publication_remote_url: z.string().min(1).optional(), published_at: timestampSchema.optional(), updated_at: timestampSchema,
});

function parsePersisted<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ');
  throw new Error(`${label} validation failed: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  return value;
}

/** Lifecycle fields a caller may patch; every other field is immutable identity. */
export type ApprovalPlanMutablePatch =
  Partial<Pick<ApprovalPlan, 'status' | 'publication'>> & { approval?: ApprovalPlanClaim | null };

const MUTABLE_PATCH_FIELDS = new Set(['status', 'publication', 'approval']);

export function approvalPlanDirectory(statePath: string) { return `${statePath}.approval-plans`; }
const planDirectory = approvalPlanDirectory;
export function approvalPlanVersionPath(statePath: string, revision: number) { return join(planDirectory(statePath), `plan-v${revision}.json`); }
export function approvalPlanStatusPath(statePath: string, revision: number) { return join(planDirectory(statePath), `plan-v${revision}.status.json`); }
export function approvalPlanCurrentPath(statePath: string) { return join(planDirectory(statePath), 'plan-current.json'); }
export function approvalPlanDeliverySemanticKey(plan: Pick<ApprovalPlan, 'plan_id' | 'plan_revision' | 'body_sha256'>) {
  return `approval-plan:${plan.plan_id}:v${plan.plan_revision}:${plan.body_sha256}`;
}
export function approvalPlanBodySha256(body: string) { return createHash('sha256').update(body, 'utf8').digest('hex'); }

function assertRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Approval Plan revision must be a positive integer');
}

function isUtcTimestamp(value: unknown) {
  return typeof value === 'string' && /T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function immutablePayload(plan: ApprovalPlan): ApprovalPlanImmutable {
  const { status: _status, publication: _publication, ...immutable } = plan;
  return immutable;
}

export function createApprovalPlan(input: Omit<ApprovalPlan, 'schema_version' | 'plan_id' | 'body_sha256' | 'status' | 'created_at'> & { plan_id?: string; created_at?: string; status?: ApprovalPlanStatus }): ApprovalPlan {
  const body = input.body.trim();
  if (!body) throw new Error('Approval Plan body must be non-empty');
  if (body.length > 512 * 1024) throw new Error('Approval Plan body is too large');
  assertRevision(input.plan_revision);
  const body_sha256 = approvalPlanBodySha256(body);
  return { ...input, schema_version: APPROVAL_PLAN_SCHEMA_VERSION, plan_id: input.plan_id ?? `plan-${randomUUID()}`, body,
    body_sha256, status: input.status ?? 'draft', created_at: input.created_at ?? new Date().toISOString() };
}

export function validateApprovalPlan(input: unknown): ApprovalPlan {
  const plan = parsePersisted(approvalPlanSchema, input, 'Approval Plan');
  if (plan.body_sha256 !== approvalPlanBodySha256(plan.body)) throw new Error('Approval Plan body hash does not match');
  return plan;
}

function validateApprovalPlanClaim(input: unknown): ApprovalPlanClaim {
  return parsePersisted(approvalPlanClaimSchema, input, 'Approval Plan claim');
}

function statusRecord(plan: ApprovalPlan, approval?: ApprovalPlanClaim): ApprovalPlanStatusRecord {
  return { schema_version: APPROVAL_PLAN_STATUS_SCHEMA_VERSION, plan_id: plan.plan_id, plan_revision: plan.plan_revision,
    body_sha256: plan.body_sha256, status: plan.status, ...(plan.publication ? { publication: plan.publication } : {}),
    ...(approval ? { approval } : {}), updated_at: new Date().toISOString() };
}

function pointerFromPlan(statePath: string, plan: ApprovalPlan, updatedAt = new Date().toISOString()): ApprovalPlanPointer {
  return { schema_version: APPROVAL_PLAN_CURRENT_SCHEMA_VERSION, plan_id: plan.plan_id, plan_revision: plan.plan_revision,
    body_sha256: plan.body_sha256, status: plan.status, plan_path: approvalPlanVersionPath(statePath, plan.plan_revision), run_id: plan.run_id,
    execution_id: plan.execution_id, workspace_path: plan.workspace_path, pr_head_sha: plan.pr_head_sha, pr_head_ref: plan.pr_head_ref,
    pr_head_repo: plan.pr_head_repo, current_base_tip_sha: plan.current_base_tip_sha, base_ref: plan.base_ref,
    workspace_evidence_sha256: plan.workspace_evidence_sha256, command_snapshot_id: plan.command_snapshot_id,
    command_snapshot_sha256: plan.command_snapshot_sha256,
    ...(plan.publication ? { publication_delivery_id: plan.publication.delivery_id, publication_remote_id: plan.publication.remote_id,
      publication_remote_url: plan.publication.remote_url, published_at: plan.publication.published_at } : {}), updated_at: updatedAt };
}

/**
 * Validate the mutable sidecar against the immutable version before it is trusted. The sidecar
 * already carries plan_id/revision/body_sha256; using them means a sidecar from another plan or
 * revision can never donate its lifecycle (or its approval claim) to this one.
 */
async function readStatusRecord(statePath: string, revision: number, raw: Partial<ApprovalPlan>): Promise<ApprovalPlanStatusRecord | null> {
  const statusValue = await readJson<unknown>(approvalPlanStatusPath(statePath, revision));
  if (statusValue === null) return null;
  const status = parsePersisted(approvalPlanStatusRecordSchema, statusValue, 'Approval Plan status sidecar');
  if (status.plan_id !== raw.plan_id || status.plan_revision !== revision || status.plan_revision !== raw.plan_revision
      || status.body_sha256 !== raw.body_sha256) {
    throw new Error('Approval Plan status sidecar does not match its immutable revision');
  }
  const approval = status.approval ? validateApprovalPlanClaim(status.approval) : undefined;
  if (approval && (approval.plan_id !== raw.plan_id || approval.plan_revision !== revision || approval.body_sha256 !== raw.body_sha256)) {
    throw new Error('Approval Plan approval claim does not match its immutable revision');
  }
  return { ...status, ...(approval ? { approval } : {}) };
}

/**
 * Read the immutable body and merge the validated mutable status sidecar. The immutable version
 * file never carries lifecycle state, so a status/publication update cannot be lost when the body
 * file is already on disk.
 */
export async function readApprovalPlan(statePath: string, revision: number) {
  const rawValue = await readJson<unknown>(approvalPlanVersionPath(statePath, revision));
  if (rawValue === null) return null;
  const raw = objectValue(rawValue, 'Approval Plan');
  const status = await readStatusRecord(statePath, revision, raw);
  const merged = {
    ...raw,
    status: status?.status ?? 'draft',
    ...(status?.publication ? { publication: status.publication } : {}),
  };
  return validateApprovalPlan(merged);
}

export async function readApprovalPlanClaim(statePath: string, revision: number): Promise<ApprovalPlanClaim | null> {
  const rawValue = await readJson<unknown>(approvalPlanVersionPath(statePath, revision));
  if (rawValue === null) return null;
  const raw = objectValue(rawValue, 'Approval Plan');
  const status = await readStatusRecord(statePath, revision, raw);
  return status?.approval ?? null;
}

export async function readCurrentApprovalPlan(statePath: string): Promise<ApprovalPlanWorkspaceState | null> {
  const pointerValue = await readJson<unknown>(approvalPlanCurrentPath(statePath));
  if (pointerValue === null) return null;
  const pointer = parsePersisted(approvalPlanPointerSchema, pointerValue, 'Approval Plan current pointer');
  const plan = await readApprovalPlan(statePath, pointer.plan_revision);
  if (!plan || plan.plan_id !== pointer.plan_id || plan.plan_revision !== pointer.plan_revision || plan.body_sha256 !== pointer.body_sha256) {
    throw new Error('Approval Plan pointer does not resolve to its immutable body');
  }
  // The pointer's mechanical projection must match the immutable version. Its status/publication
  // are only a projection and may legitimately lag a crash between the sidecar and pointer writes,
  // so they are deliberately not treated as identity here.
  const contradiction = pointer.run_id !== plan.run_id || pointer.execution_id !== plan.execution_id
    || pointer.workspace_path !== plan.workspace_path || pointer.pr_head_sha !== plan.pr_head_sha
    || pointer.pr_head_ref !== plan.pr_head_ref || pointer.pr_head_repo !== plan.pr_head_repo
    || pointer.current_base_tip_sha !== plan.current_base_tip_sha || pointer.base_ref !== plan.base_ref
    || pointer.workspace_evidence_sha256 !== plan.workspace_evidence_sha256
    || pointer.command_snapshot_id !== plan.command_snapshot_id || pointer.command_snapshot_sha256 !== plan.command_snapshot_sha256;
  if (contradiction) throw new Error('Approval Plan current pointer contradicts its immutable revision');
  const approval = await readApprovalPlanClaim(statePath, pointer.plan_revision);
  return { plan, pointer, ...(approval ? { approval } : {}) };
}

export function approvalPlanStatePointer(plan: ApprovalPlan): ApprovalPlanStatePointer {
  return { plan_id: plan.plan_id, plan_revision: plan.plan_revision, body_sha256: plan.body_sha256, status: plan.status,
    run_id: plan.run_id, execution_id: plan.execution_id, workspace_path: plan.workspace_path,
    pr_head_sha: plan.pr_head_sha, pr_head_ref: plan.pr_head_ref, pr_head_repo: plan.pr_head_repo,
    current_base_tip_sha: plan.current_base_tip_sha, base_ref: plan.base_ref,
    workspace_evidence_sha256: plan.workspace_evidence_sha256, command_snapshot_id: plan.command_snapshot_id,
    command_snapshot_sha256: plan.command_snapshot_sha256,
    ...(plan.publication ? { publication_delivery_id: plan.publication.delivery_id, publication_remote_id: plan.publication.remote_id,
      publication_remote_url: plan.publication.remote_url, published_at: plan.publication.published_at } : {}) };
}

/**
 * Persist one Plan revision. The immutable envelope is written once and every later save at the
 * same revision must carry a byte-identical immutable payload; only the lifecycle sidecar changes.
 * `lifecycle.approval === undefined` preserves the existing claim, `null` clears it.
 */
export async function saveApprovalPlan(statePath: string, planInput: ApprovalPlan, lifecycle: { approval?: ApprovalPlanClaim | null } = {}) {
  const plan = validateApprovalPlan(planInput);
  const path = approvalPlanVersionPath(statePath, plan.plan_revision);
  const existingValue = await readJson<unknown>(path);
  const existing = existingValue === null ? null : objectValue(existingValue, 'Approval Plan immutable revision');
  const existingStatus = existing ? await readStatusRecord(statePath, plan.plan_revision, existing) : null;
  if (existing) {
    const existingPlan = validateApprovalPlan({ ...existing, status: existingStatus?.status ?? existing.status ?? 'draft',
      ...((existingStatus?.publication ?? existing.publication) ? { publication: existingStatus?.publication ?? existing.publication } : {}) });
    // The full immutable envelope is identity, not just the body hash: Git basis, workspace
    // evidence, snapshot and run identity must never change under the same revision.
    if (canonicalJson(immutablePayload(plan)) !== canonicalJson(immutablePayload(existingPlan))) {
      throw new Error(`Approval Plan revision v${plan.plan_revision} is immutable`);
    }
  } else await immutableJson(path, immutablePayload(plan));
  const approval = lifecycle.approval === undefined ? existingStatus?.approval : (lifecycle.approval ?? undefined);
  if (approval) validateApprovalPlanClaim(approval);
  await atomicJson(approvalPlanStatusPath(statePath, plan.plan_revision), statusRecord(plan, approval));
  await atomicJson(approvalPlanCurrentPath(statePath), pointerFromPlan(statePath, plan));
  const pointer = parsePersisted(approvalPlanPointerSchema, await readJson<unknown>(approvalPlanCurrentPath(statePath)), 'Approval Plan current pointer');
  return { plan, pointer, ...(approval ? { approval } : {}) };
}

export async function updateApprovalPlan(statePath: string, revision: number, patch: ApprovalPlanMutablePatch) {
  for (const key of Object.keys(patch)) {
    if (!MUTABLE_PATCH_FIELDS.has(key)) throw new Error(`Approval Plan patch cannot change immutable field: ${key}`);
  }
  const current = await readApprovalPlan(statePath, revision);
  if (!current) throw new Error(`Approval Plan is missing: v${revision}`);
  const next = validateApprovalPlan({ ...current,
    ...('status' in patch ? { status: patch.status } : {}),
    ...('publication' in patch ? { publication: patch.publication } : {}) });
  return saveApprovalPlan(statePath, next, { approval: patch.approval === undefined ? undefined : patch.approval });
}

export function isUnfinishedApprovalPlanClaim(claim: ApprovalPlanClaim) {
  return claim.phase === 'accepted' || claim.phase === 'running';
}

/**
 * A durable generic approval is runnable work even after its source comment has been retired.
 * The claim only counts while the Plan still carries the approved status; a superseded/stale Plan
 * must never be resumed from a stale claim.
 *
 * A missing pointer is genuinely "no approval work" and returns null. A pointer that exists but
 * fails its mechanical identity checks is an integrity failure and is deliberately propagated:
 * swallowing it here would let a corrupt durable claim masquerade as "nothing pending" and be
 * silently shelved. Callers (runnable wake predicate, recovery) must surface or block on it.
 */
export async function readUnfinishedApprovalPlanClaim(statePath: string) {
  const current = await readCurrentApprovalPlan(statePath);
  if (!current?.approval || current.plan.status !== 'approved' || !isUnfinishedApprovalPlanClaim(current.approval)) return null;
  return { plan: current.plan, pointer: current.pointer, approval: current.approval };
}
