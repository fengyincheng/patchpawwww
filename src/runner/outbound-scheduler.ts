/**
 * Compatibility facade for callers that still import the old module name.
 * Runtime scheduling is implemented by the single communication scheduler.
 */
export {
  startCommunicationScheduler,
  startOutboundScheduler,
  reconcileLegacyOutbox,
  finalizeDelayedDelivery,
  type CommunicationSchedulerService,
  type OutboundSchedulerService,
  type SchedulerConfig,
} from './communication-scheduler.ts';
