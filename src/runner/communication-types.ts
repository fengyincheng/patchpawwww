import type { ReviewResult } from '../tasks/review/result.ts';
import type { HumanReply } from '../github/comments.ts';

export type OutboundKind = 'comment' | 'review';
export type OutboundStatus = 'pending' | 'sending' | 'pending_retry' | 'blocked' | 'delivered' | 'cancelled_stale';
export type OutboundLifecycleStatus = 'pending' | 'finalized';
export const LIFECYCLE_PURPOSES = ['pr_review', 'run_notice', 'conflict_proposal', 'conflict_repair', 'close_start', 'close_completion', 'close_refusal'] as const;
export type LifecyclePurpose = typeof LIFECYCLE_PURPOSES[number];

export interface DeliveryReceipt {
  id: number;
  html_url: string;
  commit_id?: string;
  published_at?: string;
  reused?: boolean;
  remote_adopted?: boolean;
}

export interface CommentPayload {
  body: string;
  mentions: string[];
  bot_login?: string;
  legacy_markers?: string[];
}

export interface ReviewPayload {
  head_sha: string;
  review: ReviewResult;
  mentions: string[];
  bot_login?: string;
  run_id: string;
  allow_legacy?: boolean;
}

export interface SafeCommunicationError {
  status: number | null;
  code: string | null;
  name: string | null;
  category: string;
  retry_after_ms?: number | null;
}

export interface OutboundItem {
  version: 1;
  delivery_id: string;
  semantic_key: string;
  repo: string;
  pr_number: number;
  /** SQLite row id exposed at the domain boundary for compatibility with old callers. */
  sequence: number;
  kind: OutboundKind;
  purpose: string;
  created_at: string;
  updated_at?: string;
  status: OutboundStatus;
  payload: CommentPayload | ReviewPayload;
  marker: string;
  source: Record<string, string | number | null | undefined>;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string;
  sending_until_at?: string | null;
  last_error: SafeCommunicationError | null;
  receipt: DeliveryReceipt | null;
  lifecycle_status: OutboundLifecycleStatus;
  finalized_at: string | null;
  finalization_attempt_count: number;
  finalization_last_error: SafeCommunicationError | null;
  next_finalization_at: string | null;
}

export interface InboundRecord {
  version: 1;
  delivery_id: string;
  repo: string;
  pr_number: number;
  comment_id: number;
  reply: HumanReply;
  status: InboundStatus;
  attempt_count: number;
  next_attempt_at: string;
  last_error: SafeCommunicationError | null;
  rejected_reason?: string;
  created_at?: string;
  updated_at?: string;
}

export type InboundStatus = 'pending_verification' | 'verified' | 'rejected' | 'dispatched' | 'retired';
