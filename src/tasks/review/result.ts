import { z } from 'zod';
export const reviewResultSchema = z.object({
  summary: z.string(), recommendation: z.enum(['approve', 'changes_requested', 'comment']),
  findings: z.array(z.object({ path: z.string(), line: z.number().int().positive(),
    severity: z.enum(['high', 'medium', 'low']), title: z.string(), evidence: z.string() })),
  limitations: z.array(z.string()),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;
