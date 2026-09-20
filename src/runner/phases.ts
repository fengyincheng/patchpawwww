import type { RunState } from './state.ts';

/**
 * A run's phase vocabulary, derived from what the code actually writes.
 *
 * `RunState.phase` used to be a bare string, and `waiting_for_ci` was re-derived from it in several
 * places. That is how a lifecycle drifts: nothing states which phases exist, nothing rejects a
 * label nobody handles, and a derived field ends up computed differently in different files. The
 * vocabulary and the derivation now live here, and every writer goes through them.
 *
 * A phase is the last thing a run was doing, so the terminal one is the status it finished with —
 * that is why completed/failed statuses appear alongside the operational labels.
 */
export const RUN_PHASES = [
  // Reading reality before any work starts.
  'inspect', 'workspace', 'claimed', 'closing',
  // Executing a task: the label names the task, or the step it is on.
  'conversation', 'custom', 'review', 'review_running', 'review_ready', 'review_publishing',
  'conflict', 'repair', 'repairing', 'ci', 'ci-repair', 'repair_closeout',
  // Waiting on something durable outside this process.
  'publishing', 'awaiting_approval', 'publication_pending',
  // Legacy: the conflict-proposal lifecycle stored its own status in this field when a run had no
  // phase yet, so older durable states can carry these. Kept as named members rather than
  // reinterpreted, and never written for a new reason.
  'draft', 'published',
  // Terminal.
  'conversation_completed', 'custom_completed', 'review_completed', 'conflict_completed',
  'ci_completed', 'repair_completed', 'closed', 'superseded',
  'stale', 'review_stale', 'review_interrupted', 'review_publication_pending', 'publication_interrupted',
  'needs_human', 'budget_exhausted', 'stopped', 'mention_required',
  'harness_failed', 'provider_unavailable', 'model_output_truncated',
  // A durable phase written by a build whose vocabulary this one does not know. It is a real
  // state — "the phase cannot be read" — and naming it forces every reader to handle it instead
  // of silently treating an unknown phase as a specific one.
  'unrecognized',
] as const;

export type RunPhase = typeof RUN_PHASES[number];

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === 'string' && (RUN_PHASES as readonly string[]).includes(value);
}

export function parseRunPhase(value: unknown): RunPhase {
  return isRunPhase(value) ? value : 'unrecognized';
}

/**
 * The one place a phase and the fields derived from it change together, so the projection cannot
 * drift between callers. Every phase writer in the runner goes through this.
 */
export function applyRunPhase<T extends { phase: RunPhase; waiting_for_ci: boolean }>(state: T, phase: RunPhase): T {
  state.phase = phase;
  state.waiting_for_ci = phase === 'ci';
  return state;
}

/**
 * Build a run state at its starting phase. Callers supply everything except the phase and the
 * projection derived from it, so a freshly created state cannot disagree with itself either.
 */
export type RunStateFields = Omit<RunState, 'phase' | 'waiting_for_ci'>;

export function createRunState<T extends RunStateFields>(fields: T, phase: RunPhase): T & { phase: RunPhase; waiting_for_ci: boolean } {
  return applyRunPhase({ ...fields, phase, waiting_for_ci: false }, phase);
}

/** A stale vocabulary is a programming error, not a runtime condition: fail loudly where authored. */
export function assertRunPhase(value: string): RunPhase {
  if (!isRunPhase(value)) throw new Error(`Unknown run phase ${value}; add it to RUN_PHASES in src/runner/phases.ts`);
  return value;
}
