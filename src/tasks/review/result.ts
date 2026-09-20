import { z } from 'zod';
export const reviewResultSchema = z.object({
  summary: z.string(), recommendation: z.enum(['approve', 'changes_requested', 'comment']),
  findings: z.array(z.object({ path: z.string(), line: z.number().int().positive(),
    severity: z.enum(['high', 'medium', 'low']), title: z.string(), evidence: z.string() })),
  limitations: z.array(z.string()),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

/** Fresh runs persist the Agent's answer as opaque Markdown; the structured shape is legacy-only. */
export const opaqueReviewSchema = z.object({ body: z.string().min(1) });
export const reviewPayloadSchema = z.union([reviewResultSchema, opaqueReviewSchema]);
export type OpaqueReview = z.infer<typeof opaqueReviewSchema>;
export type ReviewPayload = ReviewResult | OpaqueReview;
