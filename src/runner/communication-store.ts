import { createClient, type Client, type Row } from '@libsql/client';
import { chmod, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchpawPaths, legacyRuntimePaths } from '../config/paths.ts';
import type { HumanReply } from '../github/comments.ts';
import {
  type InboundRecord,
  type InboundStatus,
  LIFECYCLE_PURPOSES,
  type OutboundItem,
  type OutboundLifecycleStatus,
  type OutboundStatus,
  type SafeCommunicationError,
} from './communication-types.ts';

export const COMMUNICATION_SCHEMA_VERSION = '1';
export const communicationDbPath = (runtimeHome: string) => patchpawPaths(runtimeHome).communicationDb;

const schema = `
CREATE TABLE IF NOT EXISTS communication_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_delivery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL UNIQUE,
  semantic_key TEXT NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'review')),
  purpose TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  marker TEXT NOT NULL,
  source_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'pending_retry', 'blocked', 'delivered', 'cancelled_stale')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_attempt_at TEXT NOT NULL,
  sending_until_at TEXT,
  last_error_json TEXT,
  receipt_json TEXT,
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('pending', 'finalized')),
  finalized_at TEXT,
  finalization_attempt_count INTEGER NOT NULL DEFAULT 0,
  finalization_last_error_json TEXT,
  next_finalization_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo, pr_number, semantic_key)
);

CREATE INDEX IF NOT EXISTS idx_outbound_pr_order ON outbound_delivery(repo, pr_number, id);
CREATE INDEX IF NOT EXISTS idx_outbound_due ON outbound_delivery(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbound_finalization_due ON outbound_delivery(lifecycle_status, next_finalization_at);

CREATE TABLE IF NOT EXISTS inbound_comment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  comment_id INTEGER NOT NULL,
  reply_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_verification', 'verified', 'rejected', 'dispatched', 'retired')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error_json TEXT,
  rejected_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo, pr_number, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_due ON inbound_comment(status, next_attempt_at);
`;

type DbArgs = Record<string, string | number | null>;

function value(row: Row, key: string) {
  return row[key] as string | number | bigint | null | undefined;
}

function textValue(row: Row, key: string, fallback = '') {
  const current = value(row, key);
  return current === null || current === undefined ? fallback : String(current);
}

function numberValue(row: Row, key: string, fallback = 0) {
  const current = value(row, key);
  return current === null || current === undefined ? fallback : Number(current);
}

function jsonValue<T>(row: Row, key: string, fallback: T): T {
  const current = value(row, key);
  if (current === null || current === undefined || current === '') return fallback;
  return JSON.parse(String(current)) as T;
}

function optionalJsonValue<T>(row: Row, key: string): T | null {
  const current = value(row, key);
  return current === null || current === undefined ? null : JSON.parse(String(current)) as T;
}

function lifecycleRequired(purpose: string) {
  return LIFECYCLE_PURPOSES.includes(purpose as typeof LIFECYCLE_PURPOSES[number]);
}

function toOutbound(row: Row, dbPath: string): { item: OutboundItem; path: string } {
  const purpose = textValue(row, 'purpose');
  const lifecycleStatus = textValue(row, 'lifecycle_status', lifecycleRequired(purpose) ? 'pending' : 'finalized') as OutboundLifecycleStatus;
  return {
    path: dbPath,
    item: {
      version: 1,
      delivery_id: textValue(row, 'delivery_id'),
      semantic_key: textValue(row, 'semantic_key'),
      repo: textValue(row, 'repo'),
      pr_number: numberValue(row, 'pr_number'),
      sequence: numberValue(row, 'id'),
      kind: textValue(row, 'kind') as OutboundItem['kind'],
      purpose,
      created_at: textValue(row, 'created_at'),
      updated_at: textValue(row, 'updated_at'),
      status: textValue(row, 'status') as OutboundStatus,
      payload: jsonValue(row, 'payload_json', {} as OutboundItem['payload']),
      marker: textValue(row, 'marker'),
      source: jsonValue(row, 'source_json', {}),
      attempt_count: numberValue(row, 'attempt_count'),
      last_attempt_at: value(row, 'last_attempt_at') === null ? null : textValue(row, 'last_attempt_at'),
      next_attempt_at: textValue(row, 'next_attempt_at'),
      sending_until_at: value(row, 'sending_until_at') === null ? null : textValue(row, 'sending_until_at'),
      last_error: optionalJsonValue<SafeCommunicationError>(row, 'last_error_json'),
      receipt: optionalJsonValue<OutboundItem['receipt']>(row, 'receipt_json'),
      lifecycle_status: lifecycleStatus,
      finalized_at: value(row, 'finalized_at') === null ? null : textValue(row, 'finalized_at'),
      finalization_attempt_count: numberValue(row, 'finalization_attempt_count'),
      finalization_last_error: optionalJsonValue<SafeCommunicationError>(row, 'finalization_last_error_json'),
      next_finalization_at: value(row, 'next_finalization_at') === null ? null : textValue(row, 'next_finalization_at'),
    },
  };
}

function toInbound(row: Row, dbPath: string): { record: InboundRecord; path: string } {
  const reply = jsonValue<HumanReply>(row, 'reply_json', {
    repo: textValue(row, 'repo'), pr_number: numberValue(row, 'pr_number'), comment_id: numberValue(row, 'comment_id'),
    installation_id: 0, author: '', body: '', url: '',
  });
  return {
    path: dbPath,
    record: {
      version: 1,
      delivery_id: textValue(row, 'delivery_id'),
      repo: textValue(row, 'repo'),
      pr_number: numberValue(row, 'pr_number'),
      comment_id: numberValue(row, 'comment_id'),
      reply,
      status: textValue(row, 'status') as InboundStatus,
      attempt_count: numberValue(row, 'attempt_count'),
      next_attempt_at: textValue(row, 'next_attempt_at'),
      last_error: optionalJsonValue<SafeCommunicationError>(row, 'last_error_json'),
      rejected_reason: value(row, 'rejected_reason') === null ? undefined : textValue(row, 'rejected_reason'),
      created_at: textValue(row, 'created_at'),
      updated_at: textValue(row, 'updated_at'),
    },
  };
}

function isoNow() { return new Date().toISOString(); }

export class CommunicationStore {
  readonly path: string;

  constructor(readonly root: string, private readonly client: Client) {
    this.path = communicationDbPath(root);
  }

  async execute(sql: string, args?: DbArgs) {
    return this.client.execute({ sql, args });
  }

  async close() { this.client.close(); }

  async getMeta(key: string) {
    const result = await this.execute('SELECT value FROM communication_meta WHERE key = :key', { key });
    return result.rows[0] ? textValue(result.rows[0], 'value') : undefined;
  }

  async setMeta(key: string, valueToSet: string) {
    await this.execute(`INSERT INTO communication_meta(key, value) VALUES (:key, :value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`, { key, value: valueToSet });
  }

  async enqueueOutbound(item: Omit<OutboundItem, 'sequence' | 'updated_at'> & { updated_at?: string }) {
    const now = item.updated_at ?? isoNow();
    await this.execute(`INSERT INTO outbound_delivery(
      delivery_id, semantic_key, repo, pr_number, kind, purpose, payload_json, marker, source_json,
      status, attempt_count, last_attempt_at, next_attempt_at, sending_until_at, last_error_json, receipt_json,
      lifecycle_status, finalized_at, finalization_attempt_count, finalization_last_error_json, next_finalization_at,
      created_at, updated_at
    ) VALUES (
      :delivery_id, :semantic_key, :repo, :pr_number, :kind, :purpose, :payload_json, :marker, :source_json,
      :status, :attempt_count, :last_attempt_at, :next_attempt_at, :sending_until_at, :last_error_json, :receipt_json,
      :lifecycle_status, :finalized_at, :finalization_attempt_count, :finalization_last_error_json, :next_finalization_at,
      :created_at, :updated_at
    ) ON CONFLICT(repo, pr_number, semantic_key) DO NOTHING`, {
      delivery_id: item.delivery_id, semantic_key: item.semantic_key, repo: item.repo, pr_number: item.pr_number,
      kind: item.kind, purpose: item.purpose, payload_json: JSON.stringify(item.payload), marker: item.marker,
      source_json: JSON.stringify(item.source), status: item.status, attempt_count: item.attempt_count,
      last_attempt_at: item.last_attempt_at, next_attempt_at: item.next_attempt_at,
      sending_until_at: item.sending_until_at ?? null, last_error_json: item.last_error ? JSON.stringify(item.last_error) : null,
      receipt_json: item.receipt ? JSON.stringify(item.receipt) : null, lifecycle_status: item.lifecycle_status,
      finalized_at: item.finalized_at ?? null, finalization_attempt_count: item.finalization_attempt_count,
      finalization_last_error_json: item.finalization_last_error ? JSON.stringify(item.finalization_last_error) : null,
      next_finalization_at: item.next_finalization_at ?? null, created_at: item.created_at, updated_at: now,
    });
    return this.getOutboundBySemanticKey(item.repo, item.pr_number, item.semantic_key);
  }

  async getOutboundBySemanticKey(repo: string, prNumber: number, semanticKey: string) {
    const result = await this.execute(`SELECT * FROM outbound_delivery
      WHERE repo = :repo AND pr_number = :pr_number AND semantic_key = :semantic_key`,
      { repo, pr_number: prNumber, semantic_key: semanticKey });
    return result.rows[0] ? toOutbound(result.rows[0], this.path) : undefined;
  }

  async getOutboundByDeliveryId(deliveryId: string) {
    const result = await this.execute('SELECT * FROM outbound_delivery WHERE delivery_id = :delivery_id', { delivery_id: deliveryId });
    return result.rows[0] ? toOutbound(result.rows[0], this.path) : undefined;
  }

  async listOutbound(filters?: { repo?: string; prNumber?: number }) {
    const where: string[] = [];
    const args: DbArgs = {};
    if (filters?.repo) { where.push('repo = :repo'); args.repo = filters.repo; }
    if (filters?.prNumber !== undefined) { where.push('pr_number = :pr_number'); args.pr_number = filters.prNumber; }
    const result = await this.execute(`SELECT * FROM outbound_delivery ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`, args);
    return result.rows.map(row => toOutbound(row, this.path));
  }

  async claimOutbound(deliveryId: string, now: string, leaseUntil: string, force = false) {
    const result = await this.execute(`UPDATE outbound_delivery AS target SET
      status = 'sending', attempt_count = attempt_count + 1, last_attempt_at = :now,
      sending_until_at = :lease_until, next_attempt_at = :lease_until, updated_at = :now
      WHERE target.delivery_id = :delivery_id
        AND target.status IN ('pending', 'pending_retry')
        AND (:force = 1 OR target.next_attempt_at <= :now)
        AND NOT EXISTS (
          SELECT 1 FROM outbound_delivery AS older
          WHERE older.repo = target.repo AND older.pr_number = target.pr_number
            AND older.id < target.id AND older.status NOT IN ('delivered', 'cancelled_stale')
        )`, { delivery_id: deliveryId, now, lease_until: leaseUntil, force: force ? 1 : 0 });
    if (!result.rowsAffected) return undefined;
    return this.getOutboundByDeliveryId(deliveryId);
  }

  async markOutboundDelivered(deliveryId: string, receipt: OutboundItem['receipt'], now = isoNow()) {
    await this.execute(`UPDATE outbound_delivery SET status = 'delivered', receipt_json = :receipt_json,
      last_error_json = NULL, sending_until_at = NULL, next_attempt_at = :now,
      lifecycle_status = CASE WHEN purpose IN ('pr_review', 'run_notice', 'conflict_proposal', 'conflict_repair', 'close_start', 'close_completion', 'close_refusal')
        THEN lifecycle_status ELSE 'finalized' END,
      finalized_at = CASE WHEN purpose IN ('pr_review', 'run_notice', 'conflict_proposal', 'conflict_repair', 'close_start', 'close_completion', 'close_refusal')
        THEN finalized_at ELSE :now END,
      updated_at = :now WHERE delivery_id = :delivery_id AND status = 'sending'`,
      { delivery_id: deliveryId, receipt_json: receipt ? JSON.stringify(receipt) : null, now });
    return this.getOutboundByDeliveryId(deliveryId);
  }

  async markOutboundStale(deliveryId: string, error: SafeCommunicationError, now = isoNow()) {
    await this.execute(`UPDATE outbound_delivery SET status = 'cancelled_stale', last_error_json = :error_json,
      sending_until_at = NULL, next_attempt_at = :now, updated_at = :now
      WHERE delivery_id = :delivery_id AND status = 'sending'`,
      { delivery_id: deliveryId, error_json: JSON.stringify(error), now });
    return this.getOutboundByDeliveryId(deliveryId);
  }

  async cancelOutboundStale(deliveryId: string, error: SafeCommunicationError, now = isoNow()) {
    await this.execute(`UPDATE outbound_delivery SET status = 'cancelled_stale', last_error_json = :error_json,
      sending_until_at = NULL, next_attempt_at = :now, next_finalization_at = :now, updated_at = :now
      WHERE delivery_id = :delivery_id AND status NOT IN ('delivered', 'cancelled_stale', 'sending')`,
      { delivery_id: deliveryId, error_json: JSON.stringify(error), now });
    return this.getOutboundByDeliveryId(deliveryId);
  }

  async markOutboundRetry(deliveryId: string, error: SafeCommunicationError, nextAttemptAt: string, now = isoNow()) {
    await this.execute(`UPDATE outbound_delivery SET status = 'pending_retry', last_error_json = :error_json,
      sending_until_at = NULL, next_attempt_at = :next_attempt_at, updated_at = :now
      WHERE delivery_id = :delivery_id AND status = 'sending'`,
      { delivery_id: deliveryId, error_json: JSON.stringify(error), next_attempt_at: nextAttemptAt, now });
    return this.getOutboundByDeliveryId(deliveryId);
  }

  async markOutboundBlocked(deliveryId: string, error: SafeCommunicationError, now = isoNow()) {
    await this.execute(`UPDATE outbound_delivery SET status = 'blocked', last_error_json = :error_json,
      sending_until_at = NULL, next_attempt_at = :now, updated_at = :now
      WHERE delivery_id = :delivery_id AND status = 'sending'`,
      { delivery_id: deliveryId, error_json: JSON.stringify(error), now });
    return this.getOutboundByDeliveryId(deliveryId);
  }

  async recordOutboundFailure(deliveryId: string, error: SafeCommunicationError, nextAttemptAt?: string, now = isoNow()) {
    await this.execute(`UPDATE outbound_delivery SET
      status = CASE WHEN :next_attempt_at IS NULL THEN 'blocked' ELSE 'pending_retry' END,
      attempt_count = attempt_count + CASE WHEN status = 'sending' THEN 0 ELSE 1 END,
      last_attempt_at = :now, last_error_json = :error_json, sending_until_at = NULL,
      next_attempt_at = COALESCE(:next_attempt_at, :now), updated_at = :now
      WHERE delivery_id = :delivery_id AND status NOT IN ('delivered', 'cancelled_stale')`, {
      delivery_id: deliveryId, error_json: JSON.stringify(error), next_attempt_at: nextAttemptAt ?? null, now,
    });
    return this.getOutboundByDeliveryId(deliveryId);
  }

  async recoverExpiredSending(now = isoNow()) {
    // This transition has a semantic meaning used by /close: the sender's lease expired while
    // its remote POST may still be in flight. Never let a caller replace this marker with a
    // generic transport error, or close could cancel the row and lose a late receipt.
    const leaseExpired = { status: null, code: 'sending_lease_expired', name: 'SendingLeaseExpired', category: 'transport', retry_after_ms: null };
    const result = await this.execute(`UPDATE outbound_delivery SET status = 'pending_retry',
      attempt_count = CASE WHEN attempt_count < 2 THEN 2 ELSE attempt_count END,
      sending_until_at = NULL, next_attempt_at = :now,
      last_error_json = :error_json, updated_at = :now
      WHERE status = 'sending' AND COALESCE(sending_until_at, next_attempt_at) <= :now`,
      { now, error_json: JSON.stringify(leaseExpired) });
    return result.rowsAffected;
  }

  async listDueOutboundHeads(now = isoNow(), limit = 25) {
    const result = await this.execute(`WITH heads AS (
      SELECT MIN(id) AS id FROM outbound_delivery
      WHERE status NOT IN ('delivered', 'cancelled_stale') GROUP BY repo, pr_number
    ) SELECT o.* FROM outbound_delivery o JOIN heads h ON h.id = o.id
      WHERE o.status IN ('pending', 'pending_retry') AND o.next_attempt_at <= :now
      ORDER BY o.next_attempt_at, o.id LIMIT :limit`, { now, limit });
    return result.rows.map(row => toOutbound(row, this.path));
  }

  async nextCommunicationDeadline() {
    const result = await this.execute(`WITH heads AS (
      SELECT MIN(id) AS id FROM outbound_delivery
      WHERE status NOT IN ('delivered', 'cancelled_stale') GROUP BY repo, pr_number
    ), deadlines AS (
      SELECT CASE
        WHEN o.status = 'sending' THEN COALESCE(o.sending_until_at, o.next_attempt_at)
        WHEN o.status IN ('pending', 'pending_retry') THEN o.next_attempt_at
        ELSE NULL END AS deadline
      FROM outbound_delivery o JOIN heads h ON h.id = o.id WHERE o.status <> 'blocked'
      UNION ALL
      SELECT next_finalization_at FROM outbound_delivery
      WHERE lifecycle_status = 'pending' AND status IN ('delivered', 'cancelled_stale')
        AND next_finalization_at IS NOT NULL
      UNION ALL
      SELECT next_attempt_at FROM inbound_comment
      WHERE status IN ('pending_verification', 'verified')
    ) SELECT MIN(deadline) AS deadline FROM deadlines WHERE deadline IS NOT NULL`);
    return result.rows[0] && value(result.rows[0], 'deadline') !== null
      ? String(value(result.rows[0], 'deadline')) : undefined;
  }

  async hasDueCommunication(now = isoNow()) {
    const deadline = await this.nextCommunicationDeadline();
    return deadline !== undefined && deadline <= now;
  }

  async listDueFinalizations(now = isoNow(), limit = 25) {
    const result = await this.execute(`SELECT * FROM outbound_delivery
      WHERE status IN ('delivered', 'cancelled_stale') AND lifecycle_status = 'pending'
        AND next_finalization_at IS NOT NULL AND next_finalization_at <= :now
      ORDER BY next_finalization_at, id LIMIT :limit`, { now, limit });
    return result.rows.map(row => toOutbound(row, this.path));
  }

  async markFinalized(deliveryId: string, now = isoNow()) {
    await this.execute(`UPDATE outbound_delivery SET lifecycle_status = 'finalized', finalized_at = :now,
      finalization_last_error_json = NULL, next_finalization_at = NULL, updated_at = :now
      WHERE delivery_id = :delivery_id AND status IN ('delivered', 'cancelled_stale') AND lifecycle_status = 'pending'`,
      { delivery_id: deliveryId, now });
    return this.getOutboundByDeliveryId(deliveryId);
  }

  async deferFinalization(deliveryId: string, error: SafeCommunicationError, nextAttemptAt: string, now = isoNow()) {
    await this.execute(`UPDATE outbound_delivery SET finalization_attempt_count = finalization_attempt_count + 1,
      finalization_last_error_json = :error_json, next_finalization_at = :next_attempt_at, updated_at = :now
      WHERE delivery_id = :delivery_id AND status IN ('delivered', 'cancelled_stale') AND lifecycle_status = 'pending'`,
      { delivery_id: deliveryId, error_json: JSON.stringify(error), next_attempt_at: nextAttemptAt, now });
    return this.getOutboundByDeliveryId(deliveryId);
  }

  async requeueOldestBlocked(repo: string, prNumber: number, now = isoNow()) {
    const result = await this.execute(`UPDATE outbound_delivery SET status = 'pending', next_attempt_at = :now,
      last_error_json = NULL, updated_at = :now WHERE id = (
        SELECT id FROM outbound_delivery WHERE repo = :repo AND pr_number = :pr_number AND status = 'blocked'
        ORDER BY id LIMIT 1
      ) RETURNING *`, { repo, pr_number: prNumber, now });
    return result.rows[0] ? toOutbound(result.rows[0], this.path).item : undefined;
  }

  async insertInbound(deliveryId: string, reply: HumanReply, now = isoNow(), initial: {
    status?: InboundStatus;
    attemptCount?: number;
    nextAttemptAt?: string;
    lastError?: SafeCommunicationError | null;
    rejectedReason?: string;
    updatedAt?: string;
  } = {}) {
    const status = initial.status ?? 'pending_verification';
    const attemptCount = initial.attemptCount ?? 0;
    const nextAttemptAt = initial.nextAttemptAt ?? now;
    const updatedAt = initial.updatedAt ?? now;
    await this.execute(`INSERT INTO inbound_comment(
      delivery_id, repo, pr_number, comment_id, reply_json, status, attempt_count, next_attempt_at,
      last_error_json, rejected_reason, created_at, updated_at
    ) VALUES (:delivery_id, :repo, :pr_number, :comment_id, :reply_json, :status, :attempt_count, :next_attempt_at,
      :last_error_json, :rejected_reason, :created_at, :updated_at) ON CONFLICT(repo, pr_number, comment_id) DO NOTHING`, {
      delivery_id: deliveryId, repo: reply.repo, pr_number: reply.pr_number, comment_id: reply.comment_id,
      reply_json: JSON.stringify(reply), status, attempt_count: attemptCount, next_attempt_at: nextAttemptAt,
      last_error_json: initial.lastError ? JSON.stringify(initial.lastError) : null,
      rejected_reason: initial.rejectedReason ?? null, created_at: now, updated_at: updatedAt,
    });
    return this.getInbound(reply.repo, reply.pr_number, reply.comment_id);
  }

  async getInbound(repo: string, prNumber: number, commentId: number) {
    const result = await this.execute(`SELECT * FROM inbound_comment
      WHERE repo = :repo AND pr_number = :pr_number AND comment_id = :comment_id`,
      { repo, pr_number: prNumber, comment_id: commentId });
    return result.rows[0] ? toInbound(result.rows[0], this.path) : undefined;
  }

  async listInbound(filters?: { repo?: string; prNumber?: number }) {
    const where: string[] = [];
    const args: DbArgs = {};
    if (filters?.repo) { where.push('repo = :repo'); args.repo = filters.repo; }
    if (filters?.prNumber !== undefined) { where.push('pr_number = :pr_number'); args.pr_number = filters.prNumber; }
    const result = await this.execute(`SELECT * FROM inbound_comment ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`, args);
    return result.rows.map(row => toInbound(row, this.path));
  }

  async listDueInbound(now = isoNow(), limit = 25) {
    const result = await this.execute(`SELECT * FROM inbound_comment
      WHERE status IN ('pending_verification', 'verified') AND next_attempt_at <= :now
      ORDER BY next_attempt_at, id LIMIT :limit`, { now, limit });
    return result.rows.map(row => toInbound(row, this.path));
  }

  async markInboundVerified(repo: string, prNumber: number, commentId: number, now = isoNow()) {
    await this.execute(`UPDATE inbound_comment SET status = 'verified', next_attempt_at = :now,
      last_error_json = NULL, rejected_reason = NULL, updated_at = :now
      WHERE repo = :repo AND pr_number = :pr_number AND comment_id = :comment_id AND status = 'pending_verification'`,
      { repo, pr_number: prNumber, comment_id: commentId, now });
    return this.getInbound(repo, prNumber, commentId);
  }

  async markInboundDispatched(repo: string, prNumber: number, commentId: number, now = isoNow()) {
    await this.execute(`UPDATE inbound_comment SET status = 'dispatched', next_attempt_at = :now,
      last_error_json = NULL, updated_at = :now
      WHERE repo = :repo AND pr_number = :pr_number AND comment_id = :comment_id AND status = 'verified'`,
      { repo, pr_number: prNumber, comment_id: commentId, now });
    return this.getInbound(repo, prNumber, commentId);
  }

  async markInboundRetired(repo: string, prNumber: number, commentId: number, now = isoNow()) {
    await this.execute(`UPDATE inbound_comment SET status = 'retired', next_attempt_at = :now,
      last_error_json = NULL, updated_at = :now
      WHERE repo = :repo AND pr_number = :pr_number AND comment_id = :comment_id
        AND status IN ('pending_verification', 'verified')`, { repo, pr_number: prNumber, comment_id: commentId, now });
    return this.getInbound(repo, prNumber, commentId);
  }

  async markInboundRetry(repo: string, prNumber: number, commentId: number, error: SafeCommunicationError, nextAttemptAt: string, now = isoNow()) {
    await this.execute(`UPDATE inbound_comment SET status = 'pending_verification', attempt_count = attempt_count + 1,
      next_attempt_at = :next_attempt_at, last_error_json = :error_json, updated_at = :now
      WHERE repo = :repo AND pr_number = :pr_number AND comment_id = :comment_id
        AND status IN ('pending_verification', 'verified')`,
      { repo, pr_number: prNumber, comment_id: commentId, next_attempt_at: nextAttemptAt, error_json: JSON.stringify(error), now });
    return this.getInbound(repo, prNumber, commentId);
  }

  async markInboundRejected(repo: string, prNumber: number, commentId: number, reason: string, error: SafeCommunicationError | null = null, now = isoNow()) {
    await this.execute(`UPDATE inbound_comment SET status = 'rejected', rejected_reason = :reason,
      next_attempt_at = :now, last_error_json = :error_json, updated_at = :now
      WHERE repo = :repo AND pr_number = :pr_number AND comment_id = :comment_id
        AND status IN ('pending_verification', 'verified')`,
      { repo, pr_number: prNumber, comment_id: commentId, reason, error_json: error ? JSON.stringify(error) : null, now });
    return this.getInbound(repo, prNumber, commentId);
  }

  async maxInboundCommentId(repo: string, prNumber: number) {
    const result = await this.execute(`SELECT MAX(comment_id) AS max_comment_id FROM inbound_comment
      WHERE repo = :repo AND pr_number = :pr_number`, { repo, pr_number: prNumber });
    const current = result.rows[0] ? value(result.rows[0], 'max_comment_id') : null;
    return current === null || current === undefined ? 0 : Number(current);
  }
}

async function readJsonFile(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
}

async function legacyOutboundFiles(runtimeHome: string, legacyHome?: string) {
  const rootDir = legacyRuntimePaths(runtimeHome, legacyHome).outbox;
  const files: { path: string; item: Record<string, any> }[] = [];
  let repoKeys: string[];
  try { repoKeys = await readdir(rootDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files; throw error; }
  for (const repoKey of repoKeys) {
    let prs: string[];
    try { prs = await readdir(join(rootDir, repoKey)); } catch { continue; }
    for (const pr of prs) {
      if (!/^pr-\d+$/.test(pr)) continue;
      let names: string[];
      try { names = await readdir(join(rootDir, repoKey, pr)); } catch { continue; }
      for (const name of names.filter(value => /^\d+-[\w-]+\.json$/.test(value))) {
        const path = join(rootDir, repoKey, pr, name);
        files.push({ path, item: await readJsonFile(path) });
      }
    }
  }
  return files;
}

async function legacyInboundFiles(runtimeHome: string, legacyHome?: string) {
  const rootDir = legacyRuntimePaths(runtimeHome, legacyHome).inbound;
  const files: { path: string; record: Record<string, any> }[] = [];
  let repoKeys: string[];
  try { repoKeys = await readdir(rootDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files; throw error; }
  for (const repoKey of repoKeys) {
    let prs: string[];
    try { prs = await readdir(join(rootDir, repoKey)); } catch { continue; }
    for (const pr of prs.filter(value => /^pr-\d+$/.test(value))) {
      let names: string[];
      try { names = await readdir(join(rootDir, repoKey, pr)); } catch { continue; }
      for (const name of names.filter(value => /^comment-\d+\.json$/.test(value))) {
        const path = join(rootDir, repoKey, pr, name);
        files.push({ path, record: await readJsonFile(path) });
      }
    }
  }
  return files;
}

async function importLegacyFiles(store: CommunicationStore, legacyHome?: string) {
  if (await store.getMeta('file_queue_import_v1')) return { outbound: 0, inbound: 0, skipped: true };
  const outbound = await legacyOutboundFiles(store.root, legacyHome);
  outbound.sort((a, b) => {
    const ak = `${String(a.item.repo ?? '')}\u0000${String(a.item.pr_number ?? '')}`;
    const bk = `${String(b.item.repo ?? '')}\u0000${String(b.item.pr_number ?? '')}`;
    return ak.localeCompare(bk) || Number(a.item.sequence ?? 0) - Number(b.item.sequence ?? 0);
  });
  for (const { item } of outbound) {
    if (!item.repo || !Number.isSafeInteger(item.pr_number) || !item.delivery_id || !item.semantic_key) continue;
    const purpose = String(item.purpose ?? 'legacy');
    const lifecycle = (item.lifecycle_status ?? (lifecycleRequired(purpose) ? 'pending' : 'finalized')) as OutboundLifecycleStatus;
    await store.enqueueOutbound({
      version: 1, delivery_id: String(item.delivery_id), semantic_key: String(item.semantic_key), repo: String(item.repo),
      pr_number: Number(item.pr_number), kind: item.kind === 'review' ? 'review' : 'comment', purpose,
      created_at: String(item.created_at ?? isoNow()), status: item.status as OutboundStatus ?? 'pending',
      payload: item.payload, marker: String(item.marker ?? ''), source: item.source ?? {}, attempt_count: Number(item.attempt_count ?? 0),
      last_attempt_at: item.last_attempt_at ?? null, next_attempt_at: String(item.next_attempt_at ?? isoNow()),
      sending_until_at: item.sending_until_at ?? null, last_error: item.last_error ?? null, receipt: item.receipt ?? null,
      lifecycle_status: lifecycle, finalized_at: item.finalized_at ?? null, finalization_attempt_count: Number(item.finalization_attempt_count ?? 0),
      finalization_last_error: item.finalization_last_error ?? null,
      next_finalization_at: item.next_finalization_at ?? (lifecycle === 'pending' ? isoNow() : null),
    });
  }
  const inbound = await legacyInboundFiles(store.root, legacyHome);
  for (const { record } of inbound) {
    const reply = record.reply as HumanReply | undefined;
    if (!reply?.repo || !Number.isSafeInteger(reply.pr_number) || !Number.isSafeInteger(reply.comment_id)) continue;
    const knownStatuses: InboundStatus[] = ['pending_verification', 'verified', 'rejected', 'dispatched', 'retired'];
    const status = knownStatuses.includes(record.status) ? record.status : 'pending_verification';
    await store.insertInbound(String(record.delivery_id ?? `legacy-${reply.comment_id}`), reply,
      String(record.created_at ?? isoNow()), { status, attemptCount: Number(record.attempt_count ?? 0),
        nextAttemptAt: String(record.next_attempt_at ?? record.created_at ?? isoNow()), lastError: record.last_error ?? null,
        rejectedReason: record.rejected_reason, updatedAt: String(record.updated_at ?? record.created_at ?? isoNow()) });
  }
  await store.setMeta('file_queue_import_v1', isoNow());
  return { outbound: outbound.length, inbound: inbound.length, skipped: false };
}

export async function openCommunicationStore(root: string, legacyHome = process.env.PATCHPAW_LEGACY_HOME) {
  const paths = patchpawPaths(root);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  const path = communicationDbPath(root);
  const client = createClient({ url: pathToFileURL(path).href, timeout: 5000 });
  try {
    await client.execute('PRAGMA journal_mode=WAL');
    await client.execute('PRAGMA foreign_keys=ON');
    await client.executeMultiple(schema);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      await chmod(file, 0o600).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    const store = new CommunicationStore(root, client);
    await store.setMeta('schema_version', COMMUNICATION_SCHEMA_VERSION);
    await importLegacyFiles(store, legacyHome);
    return store;
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function ensureCommunicationStore(root: string) {
  return openCommunicationStore(root);
}

export async function closeCommunicationStore(store: CommunicationStore) {
  await store.close();
}
