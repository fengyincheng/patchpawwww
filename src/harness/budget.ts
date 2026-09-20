export const DEFAULT_MAX_OUTPUT_TOKENS = 60_000;
export const budget = { maxSteps: 65, feedbackTurns: 2, finalAnswerSteps: 2, finalAnswerMs: 120_000, closeoutSteps: 2, closeoutMs: 120_000, taskMs: 2_700_000, providerMs: 300_000,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS, ciWaitMs: 1_200_000, ciPollMs: 20_000, repairAttempts: 3 };
