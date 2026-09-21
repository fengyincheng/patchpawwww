import { repairCompletionPrompt } from '../repair-prompt.ts';
import { loadOperation } from '../../operation/load.ts';
export const conflictPrompt = `${loadOperation('conflict')}\n${repairCompletionPrompt}`;
