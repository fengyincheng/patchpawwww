import { runRepair } from '../repair.ts';
import type { TaskOptions } from '../../harness/runtime.ts';
import type { OpaqueRepairResult, LegacyRepairResult } from '../repair.ts';

type CIRepairOptions = Omit<TaskOptions, 'task' | 'prompt'>;
export function runCIRepair(options: CIRepairOptions & { opaqueOutcome: true }, seed: unknown): Promise<OpaqueRepairResult>;
export function runCIRepair(options: CIRepairOptions & { opaqueOutcome?: false | undefined }, seed: unknown): Promise<LegacyRepairResult>;
export function runCIRepair(options: CIRepairOptions, seed: unknown): Promise<LegacyRepairResult>;
export function runCIRepair(options: CIRepairOptions, seed: unknown): Promise<OpaqueRepairResult | LegacyRepairResult> {
  return runRepair({ ...options, task: 'ci-repair', prompt: '' }, seed);
}
