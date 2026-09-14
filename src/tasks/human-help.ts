import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import type { Trace } from '../harness/trace.ts';

export const humanHelpSkill = readFileSync(new URL('../../skills/patchpaw-human-help/SKILL.md', import.meta.url), 'utf8');
export class HumanHelpRequested extends Error {}

export function createHumanHelp(trace: Trace, task: string) {
  let reason: string | undefined;
  return {
    requested: () => reason !== undefined,
    reason: () => reason,
    tool: createTool({ id: 'request_human_help',
      description: 'End this task and ask humans through a PR comment. Explain your reason in Chinese. No prior edit, failure or minimum effort is required.',
      inputSchema: z.object({ reason: z.string().trim().min(1) }),
      execute: async input => {
        reason ??= input.reason;
        trace.emit('human_help_requested', { task, reason });
        return { status: 'human_help_requested' };
      } }),
  };
}
