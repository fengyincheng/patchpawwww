import { TaskStopped } from '../runner/stop.ts';
import { createTaskSession, ExecutionBudgetExhausted, renderRuntimePrompt, templateValuesFromSeed, type TaskOptions } from '../harness/runtime.ts';
import { createCloseoutSubmission, persistCloseout } from './closeout.ts';
import { createRepairSubmission } from './repair-submission.ts';
import { validateWorkspace } from '../workspace/manager.ts';
import { budget } from '../harness/budget.ts';
import { captureVerificationInputs } from '../workspace/verification-inputs.ts';
import { git } from '../workspace/git.ts';
import { HumanHelpRequested } from './human-help.ts';

// The trace keeps decision facts and a pointer; the full stdout/stderr evidence lives in the
// validation artifacts (last-validation.json / <task>-validation-*.json), never duplicated
// whole into trace.jsonl on every attempt.
function verificationEvent(task: string, extra: { attempt?: number; closeout?: boolean }, validation: Awaited<ReturnType<typeof validateWorkspace>>) {
  return { task, ...extra, ok: validation.ok, failures: validation.failures, warnings: validation.warnings,
    reason: validation.reason, verification_input_changes: validation.verification_input_changes,
    repair_changes: validation.repair_changes,
    commands: validation.validation.map(c => ({ command: c.command, exit_code: c.exitCode, timed_out: c.timedOut })),
    evidence: 'last-validation.json' };
}

export async function runRepair(options: TaskOptions, seed: unknown) {
  const startHead = options.repairStartHead ?? (options.task === 'conflict' ? options.ws.initialHead : (await git(options.ws.path, ['rev-parse', 'HEAD'], options.trace)).stdout.trim());
  options.trace.emit('repair_started', { task: options.task, head: startHead });
  options.ws.verificationInputs ??= await captureVerificationInputs(options.ws.path, options.trace);
  const submission = createRepairSubmission(options.trace, options.task);
  const closeout = createCloseoutSubmission(options);
  const session = createTaskSession({ ...options, repairBudget: true, templateValues: templateValuesFromSeed(seed),
    tools: { ...options.tools, ...submission.tools, submit_task_closeout: closeout.tool },
    stopWhen: () => submission.hasRequest() || !!closeout.get() });
  let input = JSON.stringify(seed);
  let lastIssue = '尚未提交验收请求。';
  try {
    for (let attempt = 0; attempt <= budget.feedbackTurns; attempt++) {
      try { await session.turn(input); } // Narrative is preserved in trace, never parsed as the result.
      catch (error) { if (!(error instanceof ExecutionBudgetExhausted)) throw error; break; }
      if (closeout.get()) break;
      const decision = submission.take();
      if (!decision) {
        lastIssue = 'Agent 尚未提交本轮验收或求助请求。';
        input = renderRuntimePrompt(options, 'repair-no-verification', {});
        continue;
      }
      if (decision.kind === 'needs_human') return { status: 'needs_human' as const, summary: decision.summary };
      const result = decision.request;
      if (!result.tests.length && !result.validation_not_applicable) {
        lastIssue = '验收请求未提供测试命令或不适用说明。';
        input = renderRuntimePrompt(options, 'repair-verification-empty', {}); continue;
      }
      const validation = await validateWorkspace(options.ws, result.tests, options.trace, startHead, options.stopSignal);
      options.trace.save(`${options.task}-validation-${Date.now()}-${attempt}.json`, validation);
      options.trace.save('last-validation.json', { task: options.task, ...validation });
      options.trace.emit('repair_verification', verificationEvent(options.task, { attempt }, validation));
      if (validation.ok) return { status: 'repaired' as const, ...result, warnings: validation.warnings };
      lastIssue = [...validation.failures, ...(validation.reason ? [validation.reason] : [])].join('\n');
      input = renderRuntimePrompt(options, 'repair-feedback', { evidence: JSON.stringify(validation) });
    }
    await session.freeze();
    await options.onCloseout?.();
    options.trace.emit('repair_closeout_started', { task: options.task, thread: session.thread });
    if (!closeout.get()) {
      try {
        const closeoutPrompt = renderRuntimePrompt(options, 'repair-closeout', { closeoutSteps: budget.closeoutSteps, lastIssue }, true);
        if (closeoutPrompt) await session.turn(closeoutPrompt, true);
        else options.trace.emit('prompt_role_unavailable', { task: options.task, role: 'repair-closeout' });
      }
      catch (error) {
        if (error instanceof HumanHelpRequested || error instanceof TaskStopped) throw error;
        options.trace.emit('repair_closeout_error', { task: options.task, message: (error as Error).message });
      }
    }
    const decision = submission.take();
    if (decision?.kind === 'verify') {
      const result = decision.request;
      if (result.tests.length || result.validation_not_applicable) {
        const validation = await validateWorkspace(options.ws, result.tests, options.trace, startHead, options.stopSignal);
        options.trace.save('last-validation.json', { task: options.task, ...validation });
        options.trace.emit('repair_verification', verificationEvent(options.task, { closeout: true }, validation));
        if (validation.ok) return { status: 'repaired' as const, ...result, warnings: validation.warnings };
        lastIssue = [...validation.failures, validation.reason ?? ''].join('\n');
      }
    }
    return await persistCloseout(options, session.thread, closeout.get(), lastIssue);
  } catch (error) {
    if (error instanceof TaskStopped || options.stopSignal?.aborted) return await session.stop();
    if (error instanceof HumanHelpRequested) return { status: 'needs_human' as const, summary: error.message };
    throw error;
  } finally { await session.close(); }
}
