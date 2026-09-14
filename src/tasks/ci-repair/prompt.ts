import { repairCompletionPrompt } from '../repair-prompt.ts';
import { loadOperation } from '../../operation/load.ts';
export const ciRepairPrompt = `${loadOperation('ci-repair')}\n${repairCompletionPrompt}`;
