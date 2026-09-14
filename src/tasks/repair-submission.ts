import { createTool } from '@mastra/core/tools';
import { verificationRequestSchema, type RepairSubmission } from './repair-result.ts';
import type { Trace } from '../harness/trace.ts';

// Tools submit a request, never an agent-authored success status. Verification runs
// after this Mastra tool batch finishes, including any concurrent file edits.
export function createRepairSubmission(trace: Trace, task: string) {
  let pending: RepairSubmission | undefined;
  return {
    tools: {
      request_repair_verification: createTool({
        id: 'request_repair_verification',
        description: 'Request independent Harness verification of the current workspace with exact repeatable test commands. This does not declare success. Failed checks return in the same conversation for further repair.',
        inputSchema: verificationRequestSchema,
        execute: async request => {
          pending = { kind: 'verify', request };
          trace.emit('repair_verification_requested', { task, request });
          return { status: 'verification_requested' };
        },
      }),
    },
    hasRequest: () => pending !== undefined,
    take() { const value = pending; pending = undefined; return value; },
  };
}
