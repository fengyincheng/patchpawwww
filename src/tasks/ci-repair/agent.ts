import { runRepair } from '../repair.ts';
import type { TaskOptions } from '../../harness/runtime.ts';
export const runCIRepair = (options: Omit<TaskOptions, 'task' | 'prompt'>, seed: unknown) =>
  runRepair({ ...options, task: 'ci-repair', prompt: '' }, seed);
