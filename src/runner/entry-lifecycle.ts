import { join } from 'node:path';
import { hasHumanReplies, readHumanReplies } from './human-feedback.ts';
import { parsePRTask } from './command.ts';
import { prepareCloseStart, preparePendingCloseStart, runClose, retryPendingCloseCompletion, hasPendingClose, resumePendingClose, closeRefusalBody } from './close.ts';
import { deferDelivery, deliverImmediately, enqueueCommentDelivery, requeueOldestBlockedDelivery, type OutboundConnection } from './outbound.ts';
import { needsReviewRecovery, readArtifact } from './review-lifecycle.ts';
import { patchpawPaths } from '../config/paths.ts';
import { readState, writeState, type RunState } from './state.ts';
import { reconcileConflictProposalPublication } from './conflict-proposals.ts';

export type RunnerConfig = { appId?: number; privateKey?: string; snapshotRoot: string; root: string; operatorLogin?: string; appSlug?: string; botLogin?: string };
type CloseFacts = Pick<RunState, 'closed_at' | 'closed_through_comment_id' | 'close_start_notice_id' | 'close_comment_id' | 'close_mentions' | 'completion_notice_id' | 'completion_notice_status' | 'pending_close_refusal'>;

export interface EntryLifecycleInput {
  config: RunnerConfig;
  resolveConnection: () => Promise<OutboundConnection>;
  repo: string;
  prNumber: number;
  path: string;
  appSlug?: string;
  botLogin: string;
}

export interface EntryLifecycleResult {
  appSlug?: string;
  botLogin: string;
  closeResult?: Awaited<ReturnType<typeof runClose>>;
  recoveryTarget?: string;
  priorClose?: CloseFacts;
  priorConflictProposal?: RunState['conflict_proposal'];
}

export async function prepareEntryLifecycle(input: EntryLifecycleInput): Promise<EntryLifecycleResult> {
  const { config, repo, prNumber, path } = input;
  let { appSlug, botLogin } = input;
  let closeResult: Awaited<ReturnType<typeof runClose>> | undefined;
  let recoveryTarget: string | undefined;
  let priorClose: CloseFacts | undefined;
  let priorConflictProposal: RunState['conflict_proposal'];
  const connection = input.resolveConnection;
  const previous = await readState(path);
  if (await hasHumanReplies(path)) await requeueOldestBlockedDelivery(config.root, repo, prNumber);
  const handledIds = new Set(previous?.handled_comment_ids ?? []);
  const oldest = (await readHumanReplies(path)).find(comment => comment.comment_id > (previous?.closed_through_comment_id ?? 0) && !handledIds.has(comment.comment_id));
  if (oldest?.body.includes('/close')) {
    const closeSlug = appSlug ?? botLogin.replace(/\[bot\]$/i, '');
    if (closeSlug && parsePRTask(oldest.body, closeSlug) === 'close') {
      const [owner, name] = repo.split('/');
      const mentions = [oldest.author, config.operatorLogin ?? owner].filter((login): login is string => !!login);
      const closeConnection = await connection();
      const prepared = await prepareCloseStart(config, repo, prNumber, path, { comment_id: oldest.comment_id, mentions, bot_login: botLogin, connection: closeConnection });
      try {
        closeResult = await runClose(config, repo, prNumber, path, { comment_id: oldest.comment_id, connection: closeConnection,
          mentions, bot_login: botLogin });
      } catch (error) {
        if (!prepared.start) throw error;
        const deferred = await deferDelivery(config.root, prepared.start, error);
        closeResult = { status: 'close_start_unpublished', run_ids: prepared.runIds.length, publication: deferred.publication };
      }
    }
  }
  if (!closeResult && await hasPendingClose(path)) {
    const prepared = await preparePendingCloseStart(config, repo, prNumber, path, botLogin);
    try {
      closeResult = await resumePendingClose(config, repo, prNumber, path, await connection(), botLogin);
    } catch (error) {
      if (!prepared?.start) throw error;
      const deferred = await deferDelivery(config.root, prepared.start, error);
      closeResult = { status: 'close_start_unpublished', run_ids: prepared.runIds.length, publication: deferred.publication };
    }
  }
  if (!closeResult && (previous?.completion_notice_status === 'pending' || previous?.pending_close_refusal)) {
    try {
      const client = connection;
      const bot = botLogin;
      if (previous?.completion_notice_status === 'pending') await retryPendingCloseCompletion(path, repo, prNumber, client, config.root, bot);
      const refusal = (await readState(path))?.pending_close_refusal;
      if (refusal) {
        try {
          const stored = await enqueueCommentDelivery({ root: config.root, repo, prNumber, purpose: 'close_refusal',
            semanticKey: 'close-refusal:' + refusal.comment_id, body: closeRefusalBody,
            mentions: [refusal.author ?? bot].filter((login): login is string => !!login), botLogin: bot,
            source: { comment_id: refusal.comment_id } });
          const delivered = await deliverImmediately(config.root, stored, { ...await client(), botLogin: bot });
          if (delivered.item.status === 'delivered') {
            const cleared = await readState(path);
            if (cleared) await writeState(path, { ...cleared, pending_close_refusal: undefined });
          }
        } catch { /* the refusal stays pending for the next entry */ }
      }
    } catch { /* durable pending markers survive for the next entry */ }
  }
  if (!closeResult) {
    const currentState = await readState(path);
    if (currentState?.conflict_proposal) await reconcileConflictProposalPublication(config.root, path, repo, prNumber);
  }
  if (!closeResult) {
    const current = await readState(path);
    const { closed_at, closed_through_comment_id, close_start_notice_id, close_comment_id, close_mentions, completion_notice_id, completion_notice_status, pending_close_refusal } = current ?? {};
    if (closed_at || closed_through_comment_id || completion_notice_status || pending_close_refusal) {
      priorClose = { closed_at, closed_through_comment_id, close_start_notice_id, close_comment_id, close_mentions,
        completion_notice_id, completion_notice_status, pending_close_refusal };
    }
    priorConflictProposal = current?.conflict_proposal;
    if (current && await needsReviewRecovery(current, join(patchpawPaths(config.root).runs, current.run_id))) recoveryTarget = current.run_id;
    if (current && await readArtifact(join(patchpawPaths(config.root).runs, current.run_id), 'run-notice.json')
      && (await readArtifact(join(patchpawPaths(config.root).runs, current.run_id), 'notification.json'))?.status !== 'published') recoveryTarget = current.run_id;
  }
  return { appSlug, botLogin, closeResult, recoveryTarget, priorClose, priorConflictProposal };
}
