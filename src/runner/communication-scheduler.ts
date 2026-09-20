import { createGitHub, type GitHubReader } from '../github/client.ts';
import { claimRun, readState, statePath, workerStatus } from './state.ts';
import { retryAfterMs } from '../harness/retry.ts';
import { drainDueDeliveries, OUTBOUND_LOCK_BUSY_RETRY_MS, safeError, type OutboundConnection, type OutboundItem, type StoredItem } from './outbound.ts';
import { verifyInboundNow } from './inbound-verification.ts';
import { createCommunicationWakeServer, registerCommunicationWake, type CommunicationWakeServer } from './communication-wake.ts';
import { closeCommunicationStore, openCommunicationStore, type CommunicationStore } from './communication-store.ts';
import type { InboundRecord } from './communication-types.ts';
import { patchpawPaths } from '../config/paths.ts';
import { withRuntimeLock } from '../migration/runtime-lock.ts';
import { reconcileLegacyOutbox } from './communication-legacy-reconciliation.ts';
import {
  classifyFinalization, finalizeApprovalPlanPublication, finalizeReviewDelivery, finalizeRunNotice,
  finalizeStaleReview, type FinalizationConnection,
} from './communication-finalization.ts';
import { finalizeLegacyConflictProposal, finalizeLegacyConflictRepair } from './communication-legacy-conflict-finalization.ts';
import { finalizeCloseCompletion, finalizeCloseRefusal, finalizeCloseStart } from './communication-close-finalization.ts';
import type { ScmInboundReader } from '../scm/types.ts';

export { reconcileLegacyOutbox } from './communication-legacy-reconciliation.ts';

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

class FinalizationBusy extends Error {
  retryAfter = OUTBOUND_LOCK_BUSY_RETRY_MS / 1000;
  constructor() { super('PR lifecycle is owned by an active worker'); this.name = 'FinalizationBusy'; }
}

async function finalizeDelayedDeliveryOwned(config: SchedulerConfig, stored: StoredItem, store: CommunicationStore,
  connection?: FinalizationConnection) {
  const item = stored.item;
  const done = async () => (await store.markFinalized(item.delivery_id))?.item;
  const resolveConnection = async () => typeof connection === 'function' ? connection() : connection;
  const finalizationKind = classifyFinalization(item);
  if (finalizationKind === 'stale_review') return finalizeStaleReview({ config, stored, store, resolveConnection, done });
  if (finalizationKind === 'review') return finalizeReviewDelivery({ config, stored, store, resolveConnection, done });
  if (finalizationKind === 'run_notice') return finalizeRunNotice({ config, stored, store, resolveConnection, done });
  if (finalizationKind === 'approval_plan') return finalizeApprovalPlanPublication({ config, stored, store, resolveConnection, done });
  if (finalizationKind === 'legacy_conflict_proposal') return finalizeLegacyConflictProposal({ config, stored, store, resolveConnection, done });
  if (finalizationKind === 'legacy_conflict_repair') return finalizeLegacyConflictRepair({ config, stored, store, resolveConnection, done });
  if (finalizationKind === 'close_refusal') return finalizeCloseRefusal({ config, stored, store, resolveConnection, done });
  if (finalizationKind === 'close_completion') return finalizeCloseCompletion({ config, stored, store, resolveConnection, done });
  if (finalizationKind === 'close_start') return finalizeCloseStart({ config, stored, store, resolveConnection, done });
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
    for (const stored of await store.listDueInbound(new Date().toISOString(), 25)) {
      await verifyInboundNow(config.root, stored, github, onVerified, config.inboundScmReader);
    }
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
