import { readRunArtifact } from './run-reader.ts';
import type { ObservableEvent } from './types.ts';

export type PublicationClassification = 'delivered' | 'retryable' | 'permanent' | 'stale' | 'unknown';
export type PublicationState = 'delivered' | 'blocked' | 'pending' | 'stale' | 'unknown';

export interface PublicationRecord {
  purpose: string;
  artifacts: string[];
  status?: string;
  state: PublicationState;
  classification: PublicationClassification;
  deliveryId?: string;
  remoteId?: number;
  remoteUrl?: string;
  publishedAt?: string;
  httpStatus?: number | null;
  errorName?: string | null;
  errorCategory?: string | null;
  retryAfterMs?: number | null;
  errorMessage?: string | null;
  documentationUrl?: string | null;
  requestId?: string | null;
  events: string[];
}

export interface PublicationView {
  records: PublicationRecord[];
  notice?: PublicationRecord;
  blockedWithoutDelivery: boolean;
  anyDelivered: boolean;
}

interface Definition {
  purpose: string;
  artifacts: [string, string?][];
  events: string[];
}

const DEFINITIONS: Definition[] = [
  { purpose: 'run_notice', artifacts: [['run-notice.json', 'notification.json']],
    events: ['run_notice_published', 'run_notice_failed', 'run_notice_delayed_delivery_finalized'] },
  { purpose: 'delivery_report', artifacts: [['delivery.json', 'delivery-publication.json']], events: [] },
  { purpose: 'pr_review', artifacts: [['review.json', 'review-publication.json']],
    events: ['review_published', 'review_delayed_delivery_finalized', 'review_delayed_delivery_preserved', 'review_settled_resume'] },
  { purpose: 'approval_plan', artifacts: [['approval-plan.json', 'approval-plan-publication.json']], events: ['approval_plan_claim_claimed'] },
  { purpose: 'conflict_repair', artifacts: [['conflict-result.json', 'conflict-repair-publication.json']],
    events: ['conflict_repair_delayed_delivery_finalized', 'conflict_repair_recovery_state_finalized'] },
  { purpose: 'closeout', artifacts: [['closeout.json', 'notice-recovery.json']], events: ['close_refusal_notice_pending'] },
];

const STATUS_STATE: Record<string, PublicationState> = {
  delivered: 'delivered', published: 'delivered',
  pending: 'pending', pending_retry: 'pending', sending: 'pending', queued: 'pending', notification_pending: 'pending',
  blocked: 'blocked', notification_failed: 'blocked',
  cancelled_stale: 'stale', stale: 'stale',
};

const STATE_CLASSIFICATION: Record<PublicationState, PublicationClassification> = {
  delivered: 'delivered', blocked: 'permanent', pending: 'retryable', stale: 'stale', unknown: 'unknown',
};

function text(value: unknown) { return typeof value === 'string' ? value : undefined; }
function nullableNumber(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function statusOf(value: Record<string, unknown> | null | undefined) { return value ? text(value.status) : undefined; }

function lastErrorOf(...values: (Record<string, unknown> | null | undefined)[]) {
  for (const value of values) {
    const error = value?.last_error;
    if (error && typeof error === 'object' && !Array.isArray(error)) return error as Record<string, unknown>;
  }
  return null;
}

function recordFor(definition: Definition, artifacts: Map<string, Record<string, unknown>>, events: Map<string, ObservableEvent[]>): PublicationRecord | null {
  const names = definition.artifacts.flatMap(([created, outcome]) => [created, outcome].filter((name): name is string => !!name && artifacts.has(name)));
  const observed = definition.events.flatMap(event => events.get(event) ?? []);
  if (!names.length && !observed.length) return null;

  const [, outcomeName] = definition.artifacts[0];
  const created = artifacts.get(definition.artifacts[0][0]) ?? null;
  const outcome = outcomeName ? artifacts.get(outcomeName) ?? null : null;
  const latestEvent = observed.at(-1);
  const detail = latestEvent?.detail as Record<string, unknown> | undefined;
  const status = statusOf(outcome) ?? statusOf(detail) ?? undefined;
  const outcomePresent = !!outcomeName && artifacts.has(outcomeName);
  const state: PublicationState = (status ? STATUS_STATE[status] : undefined) ?? (outcomePresent ? 'unknown' : 'pending');
  const error = lastErrorOf(outcome, created, detail);
  const receipt = outcome?.receipt && typeof outcome.receipt === 'object' ? outcome.receipt as Record<string, unknown> : outcome;
  return {
    purpose: definition.purpose, artifacts: names, ...(status ? { status } : {}), state,
    classification: STATE_CLASSIFICATION[state],
    ...(text(receipt?.delivery_id) ?? text(detail?.delivery_id) ? { deliveryId: text(receipt?.delivery_id) ?? text(detail?.delivery_id) } : {}),
    ...(nullableNumber(receipt?.remote_id ?? receipt?.id ?? detail?.remote_id) !== null
      ? { remoteId: nullableNumber(receipt?.remote_id ?? receipt?.id ?? detail?.remote_id) as number } : {}),
    ...(text(receipt?.remote_url ?? receipt?.html_url ?? detail?.remote_url) ? { remoteUrl: text(receipt?.remote_url ?? receipt?.html_url ?? detail?.remote_url) } : {}),
    ...(text(receipt?.published_at ?? detail?.published_at) ? { publishedAt: text(receipt?.published_at ?? detail?.published_at) } : {}),
    httpStatus: nullableNumber(outcome?.http_status ?? error?.status ?? detail?.http_status),
    errorName: text(error?.name) ?? null,
    errorCategory: text(error?.category) ?? null,
    retryAfterMs: nullableNumber(error?.retry_after_ms),
    errorMessage: text(error?.message) ?? text(detail?.message) ?? null,
    documentationUrl: text(error?.documentation_url) ?? text(detail?.documentation_url) ?? null,
    requestId: text(error?.request_id) ?? text(detail?.request_id) ?? null,
    events: observed.map(event => event.sourceEvent ?? ''),
  } satisfies PublicationRecord;
}

export async function readPublicationView(input: { dir: string; events: ObservableEvent[]; terminal: boolean }): Promise<PublicationView> {
  const artifacts = new Map<string, Record<string, unknown>>();
  const corrupt: string[] = [];
  for (const definition of DEFINITIONS) {
    for (const pair of definition.artifacts) {
      for (const name of pair) {
        if (!name || artifacts.has(name)) continue;
        const artifact = await readRunArtifact(input.dir, name);
        if (artifact.state === 'present' && artifact.value) artifacts.set(name, artifact.value);
        else if (artifact.state === 'corrupt') corrupt.push(name);
      }
    }
  }
  const events = new Map<string, ObservableEvent[]>();
  for (const event of input.events) {
    if (!event.sourceEvent) continue;
    events.set(event.sourceEvent, [...events.get(event.sourceEvent) ?? [], event]);
  }
  const records: PublicationRecord[] = DEFINITIONS.flatMap(definition => {
    const record = recordFor(definition, artifacts, events);
    return record ? [record] : [];
  });
  for (const name of corrupt) records.push({ purpose: `corrupt:${name}`, artifacts: [name], state: 'unknown', classification: 'unknown', events: [] });
  const notice = records.find(record => record.purpose === 'run_notice');
  return {
    records, ...(notice ? { notice } : {}),
    blockedWithoutDelivery: input.terminal && !!notice && notice.state !== 'delivered',
    anyDelivered: records.some(record => record.state === 'delivered'),
  };
}
