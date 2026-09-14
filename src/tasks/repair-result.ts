import { z } from 'zod';
export const verificationRequestSchema = z.object({
  summary: z.string(), tests: z.array(z.string().trim().min(1)),
  validation_not_applicable: z.string().trim().min(1).nullable(),
});
export type VerificationRequest = z.infer<typeof verificationRequestSchema>;
export type RepairSubmission = { kind: 'verify'; request: VerificationRequest } | { kind: 'needs_human'; summary: string };
