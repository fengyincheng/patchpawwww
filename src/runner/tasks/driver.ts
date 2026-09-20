import type { PermissionPhase, TaskAgentResult, TaskOptions } from '../../harness/runtime.ts';
import type { Trace } from '../../harness/trace.ts';
import type { ScmAdapter } from '../../scm/types.ts';
import { ciTaskDriver } from './ci.ts';
import { customTaskDriver } from './custom.ts';
import { repairTaskDriver } from './repair.ts';

/**
 * The seam between task semantics and the Harness's durable effects.
 *
 * Permission and execution type are orthogonal: a permission decides whether an execution may
 * write, never whether the task it names is meaningful. Some tasks are only meaningful after the
 * Harness has read something real — `/CI` needs the current head's actual CI state, because a Plan
 * written without it is guesswork about repository files. Encoding that as a branch on the task
 * name inside the runner is how it gets skipped, which is exactly what the production incident
 * was, and the same omission would hit any other command an operator later moved to
 * `read_write_approval`.
 *
 * So a task driver owns everything that depends on *which task this is* — what must be read
 * first, which Agent turn follows, how a turn's result is presented — and it expresses every
 * durable effect as a typed decision. The runner owns everything common to all runs: the Agent
 * turn itself, Git writeback, publication, terminal results, recovery and state transitions. The
 * driver never writes a result, never enqueues a delivery and never pushes; it decides, and the
 * runner performs.
 */

export type { TaskAgentResult } from '../../harness/runtime.ts';

/** An Agent turn a driver can ask for. The driver names it; the runner runs it. */
export interface TaskAgent {
  /** Label for the manifest task chain and the run phase, e.g. `ci-repair`. */
  readonly name: string;
  run(options: TaskOptions, seed: unknown): Promise<TaskAgentResult>;
}

/**
 * The terminal statuses a driver may declare. It is the same vocabulary the runner's delivery
 * accepts, so a driver names its own outcome without the runner needing to know which task it is.
 */
export type TaskTerminalStatus = 'ci_completed' | 'custom_completed' | 'repair_completed' | 'conflict_completed';

export interface TaskTurnRecord {
  /** The Agent's opaque answer for this turn. */
  body: string;
  /** Whether the turn left changes that the Harness then committed and pushed. */
  writtenBack: boolean;
  /** The confirmed commit for this turn, or the head it started from when nothing was written back. */
  sha: string;
}

export interface TaskProgress {
  /** Agent turns this task has run, in order. */
  turns: TaskTurnRecord[];
}

export interface TaskDecisionContext {
  phase: PermissionPhase;
  /** Whether this execution may mutate the workspace: read_write, or an approved write. */
  writable: boolean;
  headSha: string;
  repo: string;
  scm: ScmAdapter;
  projectId: string;
  changeRequestNumber: number;
  trace: Trace;
  signal?: AbortSignal;
  /** Base turn options. A decision adds its own prepared inputs on top of these. */
  options: TaskOptions;
  /** Durable attempt count and the configured budget, both owned and persisted by the runner. */
  repairAttempts: number;
  repairBudget: number;
  /** A retained workspace this execution may continue, when the runner resumed one. */
  resumed: { pausePhase?: string } | null;
  progress: TaskProgress;
  /**
   * Harness-owned cycle guard: mark the run's phase for this task step and verify the Git facts
   * are still the ones the workspace was built from. A driver calls it before it reads remote
   * state or turns the Agent, because when that check belongs in the cycle is task knowledge,
   * while how it is performed and persisted is not.
   */
  guardCycle(phaseLabel: string): Promise<void>;
}

/**
 * What the task needs next, from freshly-read real state.
 *
 * `complete` and `blocked` are mechanical outcomes. The three `agent` modes each name the single
 * runner-owned effect that follows the turn: `plan` publishes an opaque Plan and waits for
 * approval, `diagnose` delivers the Agent's answer as the task's terminal result, and `repair`
 * writes the turn's changes back and asks the driver again.
 *
 * What a turn that changed nothing *means* stays with the driver, which sees it in `progress` on
 * the next call. For CI it means the task is unresolved; for a task that only answers, it is an
 * ordinary completed turn. The runner must not assume either.
 */
export type TaskDecision =
  | { kind: 'complete'; status: TaskTerminalStatus; body: string }
  | { kind: 'blocked'; reason: string; failureCode?: string }
  | { kind: 'agent'; mode: 'plan'; agent: TaskAgent; artifact?: string;
      evidence?: unknown; seed?: Record<string, unknown> }
  | { kind: 'agent'; mode: 'repair'; agent: TaskAgent; artifact?: string; writebackKind: string;
      /** Whether this turn consumes one of the task's durable attempts. CI counts repairs against a
       *  budget; a task that simply answers does not, and the runner must not assume either. */
      countsAsRepairAttempt: boolean;
      evidence?: unknown; seed?: Record<string, unknown> }
  | { kind: 'agent'; mode: 'diagnose'; agent: TaskAgent; artifact?: string; status: TaskTerminalStatus;
      heading: string; trailer: string; evidence?: unknown; seed?: Record<string, unknown> };

export interface TaskDriver {
  readonly executionType: string;
  decide(context: TaskDecisionContext): Promise<TaskDecision>;
}

const DRIVERS: readonly TaskDriver[] = [ciTaskDriver, customTaskDriver, repairTaskDriver];

/**
 * The only place execution type selects behaviour. It is a registry lookup rather than a branch,
 * so a task family that later needs its own semantics registers a driver instead of adding a
 * condition to the runner.
 */
export function resolveTaskDriver(executionType: string | undefined): TaskDriver | undefined {
  return DRIVERS.find(driver => driver.executionType === executionType);
}
